/**
 * Per-key request pacing for NVIDIA NIM.
 *
 * Each key gets its own reservation schedule, so a request never waits on a
 * key that is already busy when another key is idle:
 *
 * - at least `requestsPerSecond` starts per key (default one per second),
 * - at most `requestsPerMinute` starts per key inside any rolling minute
 *   (default 40); a request that would overflow the window is parked until the
 *   oldest of those starts leaves it,
 * - a key reported as rate limited cools down, and a key reported as rejected
 *   is dropped for the rest of the process.
 *
 * Reservations are committed synchronously, so two concurrent callers cannot
 * both take the same slot, and a waiter re-plans after its sleep in case
 * another caller took the slot first.
 */

import { FAILURE_CODES, NimError } from './errors.js'

/** Default sleep used outside tests; releases its timer when the caller aborts. */
const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason)
    return
  }
  const onAbort = () => {
    clearTimeout(timer)
    reject(signal.reason)
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort)
    resolve()
  }, ms)
  signal?.addEventListener('abort', onAbort, { once: true })
})

/**
 * @typedef {{ value: string, label: string }} ApiKey
 * @typedef {{ key: ApiKey, release: () => void }} KeyLease
 */

/** One key's pacing state. */
class KeyState {
  /**
   * @param {ApiKey} key
   */
  constructor(key) {
    /** @type {ApiKey} */
    this.key = key
    /** Start times (ms) still inside the rolling window, ascending. */
    /** @type {number[]} */
    this.slots = []
    /** Last committed start time. */
    this.lastSlot = Number.NEGATIVE_INFINITY
    /** No start before this time (provider-requested or penalty cooldown). */
    this.cooldownUntil = 0
    /** Rejected credentials are not tried again in this process. */
    this.disabled = false
    /** User-paused: kept in the pool (still listed) but never selected. */
    this.paused = false
    /** User-pinned: preferred when several keys are equally available. */
    this.pinned = false
    /** Requests dispatched through this key, for diagnostics. */
    this.requests = 0
  }
}

export class KeyScheduler {
  /**
   * @param {{
   *   keys: readonly ApiKey[],
   *   requestsPerSecond?: number,
   *   requestsPerMinute?: number,
   *   windowMs?: number,
   *   safetyMs?: number,
   *   now?: () => number,
   *   sleep?: (ms: number) => Promise<void>,
   * }} options
   */
  constructor(options) {
    const { keys } = options
    if (!Array.isArray(keys)) throw new Error('KeyScheduler requires a key array (it may be empty)')
    this.perSecond = positive(options.requestsPerSecond ?? 1, 'requestsPerSecond')
    this.perMinute = positive(options.requestsPerMinute ?? 40, 'requestsPerMinute')
    this.windowMs = positive(options.windowMs ?? 60_000, 'windowMs')
    // A small margin absorbs timer and clock granularity so a burst never
    // lands one request inside the previous second or minute.
    this.safetyMs = Math.max(0, options.safetyMs ?? 50)
    this.gapMs = 1000 / this.perSecond + this.safetyMs
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? defaultSleep
    /** @type {KeyState[]} */
    this.states = keys.map(key => new KeyState(key))
    this.disposed = false
  }

  /** Keys that can still serve a request (not rejected, not paused). */
  get available() {
    return this.states.filter(state => !state.disabled && !state.paused)
  }

  /**
   * Wait for a dispatch slot on the least-loaded key.
   * @param {AbortSignal} [signal]
   * @returns {Promise<KeyLease>}
   */
  async acquire(signal) {
    for (;;) {
      if (this.disposed) throw new NimError('NVIDIA NIM adapter was disposed', FAILURE_CODES.ABORTED)
      throwIfAborted(signal)
      if (this.states.length === 0) {
        throw new NimError(
          'no NVIDIA NIM API key is configured: set NVIDIA_NIM_API_KEY (or the variables in apiKeyEnvs),'
          + ' or point keysFile at a key file, then reload the plugin',
          FAILURE_CODES.MISSING_CREDENTIAL,
        )
      }
      const plan = this.#plan()
      if (plan === undefined) {
        throw new NimError(
          this.states.every(state => state.disabled)
            ? 'every configured NVIDIA NIM API key was rejected; add a valid key and restart the plugin'
            : 'every usable NVIDIA NIM API key is paused; resume one in Settings → Plugins → dsh-nvidia-nim',
          this.states.every(state => state.disabled) ? FAILURE_CODES.AUTH : FAILURE_CODES.MISSING_CREDENTIAL,
        )
      }
      if (plan.at <= this.now()) {
        this.#commit(plan.state)
        return {
          key: plan.state.key,
          release: () => {},
        }
      }
      try {
        await this.#wait(plan.at - this.now(), signal)
      } catch (error) {
        // A caller abort and a failed injected sleep both end the wait; only
        // the abort may be reported as cancellation.
        throwIfAborted(signal)
        throw error
      }
    }
  }

  /**
   * Record the outcome of one request, feeding health back into selection.
   * @param {ApiKey} key
   * @param {{ kind: 'ok' | 'rate-limit' | 'auth' | 'server', retryAfterMs?: number }} outcome
   */
  report(key, outcome) {
    // Match by value, because callers (the key manager, the adapter's health
    // reporting) may hold their own copy of the entry rather than this state's.
    const state = this.states.find(candidate => candidate.key.value === key.value)
    if (state === undefined) return
    const now = this.now()
    switch (outcome.kind) {
      case 'auth':
        state.disabled = true
        return
      case 'rate-limit':
        // The provider's own hint wins; otherwise restore the key after a minute.
        state.cooldownUntil = Math.max(state.cooldownUntil, now + (outcome.retryAfterMs ?? this.windowMs))
        return
      case 'server':
        state.cooldownUntil = Math.max(state.cooldownUntil, now + (outcome.retryAfterMs ?? 0))
        return
      default:
        return
    }
  }

  /** Snapshot for diagnostics; contains no key material. */
  stats() {
    const now = this.now()
    return this.states.map(state => ({
      label: state.key.label,
      disabled: state.disabled,
      paused: state.paused,
      pinned: state.pinned,
      requests: state.requests,
      inWindow: state.slots.filter(slot => slot > now - this.windowMs).length,
      cooldownMs: Math.max(0, state.cooldownUntil - now),
    }))
  }

  /**
   * Replace the key set while keeping the pacing state of every key that stays.
   * New keys start unused and removed keys stop being selected, which is what
   * makes a batch-added key usable on the next request without a plugin restart.
   * @param {readonly ApiKey[]} keys
   */
  sync(keys) {
    const previous = new Map(this.states.map(state => [state.key.value, state]))
    this.states = keys.map(key => {
      const kept = previous.get(key.value)
      if (kept === undefined) return new KeyState(key)
      // A relabelled key keeps its schedule and health.
      kept.key = key
      return kept
    })
  }

  /**
   * Apply user flags (paused / pinned) by key value, keeping everything else.
   * @param {readonly { value: string, paused?: boolean, pinned?: boolean }[]} flags
   */
  setFlags(flags) {
    const byValue = new Map(flags.map(entry => [entry.value, entry]))
    for (const state of this.states) {
      const flag = byValue.get(state.key.value)
      if (flag === undefined) continue
      state.paused = flag.paused === true
      state.pinned = flag.pinned === true
    }
  }

  /**
   * Record an authenticated probe: a key that answers is usable again, even if
   * an earlier request had it rejected or cooled down.
   * @param {ApiKey} key
   */
  markHealthy(key) {
    const state = this.states.find(candidate => candidate.key.value === key.value)
    if (state === undefined) return
    state.disabled = false
    state.cooldownUntil = 0
  }

  /** Stop waiting on new reservations. */
  dispose() {
    this.disposed = true
  }

  /**
   * The wait each key needs and the earliest of them.
   * @returns {{ state: KeyState, at: number } | undefined}
   */
  #plan() {
    const now = this.now()
    /** @type {{ state: KeyState, at: number } | undefined} */
    let best
    for (const state of this.states) {
      if (state.disabled || state.paused) continue
      let at = Math.max(now, state.cooldownUntil, state.lastSlot + this.gapMs)
      at = this.#windowSlot(state, at)
      if (best === undefined) {
        best = { state, at }
        continue
      }
      // Pinned keys win ties; otherwise the earliest slot wins.
      if (at < best.at || (at === best.at && state.pinned && !best.state.pinned)) best = { state, at }
    }
    return best
  }

  /**
   * Move `at` forward until the rolling minute has room for one more start.
   * @param {KeyState} state
   * @param {number} at
   * @returns {number}
   */
  #windowSlot(state, at) {
    const span = this.windowMs + this.safetyMs
    for (let guard = 0; guard < 1024; guard++) {
      const recent = state.slots.filter(slot => slot > at - span && slot <= at)
      if (recent.length < this.perMinute) return at
      // Starting now would be the (perMinute + 1)-th request in the window:
      // wait until the oldest start that must leave it actually leaves.
      at = recent[recent.length - this.perMinute] + span
      const gapFloor = state.lastSlot + this.gapMs
      if (at < gapFloor) at = gapFloor
    }
    // Unreachable with the per-minute cap strictly above zero.
    return at
  }

  /**
   * Reserve the current instant on one key.
   * @param {KeyState} state
   */
  #commit(state) {
    const now = Math.max(this.now(), state.lastSlot)
    state.lastSlot = now
    state.slots.push(now)
    state.requests += 1
    const horizon = now - this.windowMs - this.safetyMs
    if (state.slots.length > this.perMinute * 2 || state.slots[0] < horizon) {
      state.slots = state.slots.filter(slot => slot >= horizon)
    }
  }

  /**
   * Abortable wait through the injected sleep.
   * @param {number} ms
   * @param {AbortSignal} [signal]
   */
  #wait(ms, signal) {
    if (ms <= 0) return Promise.resolve()
    if (signal?.aborted) return Promise.reject(aborted(signal))
    return this.sleep(ms, signal)
  }
}

/**
 * Reject a lost race with the caller's cancellation.
 * @param {AbortSignal | undefined} signal
 * @returns {NimError}
 */
function aborted(signal) {
  return new NimError('NVIDIA NIM request aborted', FAILURE_CODES.ABORTED, {
    cause: signal?.reason instanceof Error ? signal.reason : undefined,
  })
}

/** @param {AbortSignal | undefined} signal */
function throwIfAborted(signal) {
  if (signal?.aborted) throw aborted(signal)
}

/**
 * Validate one positive numeric pacing knob.
 * @param {number} value
 * @param {string} name
 * @returns {number}
 */
function positive(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`nvidia-nim: ${name} must be a positive number`)
  }
  return value
}