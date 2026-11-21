/**
 * Harness LLM adapter for NVIDIA NIM.
 *
 * One provider route ("nvidia-nim" by default) talks the OpenAI Chat
 * Completions protocol to `https://integrate.api.nvidia.com/v1`. Every attempt
 * reserves a key from the pool through the shared key scheduler, so the per-key
 * limits apply to inference and model discovery alike.
 *
 * A failed attempt is retried after `errorDelayMs` (two seconds by default)
 * only while nothing content-bearing has been emitted: once tokens reached the
 * caller, repeating the request would duplicate output, so the failure is final
 * and `dsh-llm-retry` owns the decision at the agent-step level.
 */

import { FAILURE_CODES, NimError, httpError, isRetryable, transportError } from './errors.js'
import { buildRequestBody } from './wire.js'
import { parseJsonStream } from './sse.js'
import { translateCompletions } from './translate.js'
import { createModelCatalog, parseModelList } from './discovery.js'

/** Chunk types that carry model output, where a repeat is no longer safe. */
const CONTENT_CHUNKS = new Set(['block-start', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end'])

/**
 * Build the adapter class for one plugin activation.
 *
 * The base class is injected so this module can be exercised without the
 * harness runtime (see `test/`), while the plugin entry passes the real
 * `LlmAdapter` from `@deepseek-ai/dsh-llm`.
 *
 * @param {{
 *   LlmAdapter: new () => any,
 *   settings: import('./config.js').NvidiaNimSettings,
 *   keys: readonly { value: string, label: string }[] | (() => readonly { value: string, label: string }[]),
 *   scheduler: {
 *     readonly available: readonly { value: string, label: string }[],
 *     acquire: (signal?: AbortSignal) => Promise<{ key: { value: string, label: string }, release: () => void }>,
 *     report: (key: { value: string, label: string }, outcome: { kind: string, retryAfterMs?: number }) => void,
 *   },
 *   log?: { debug: (...args: unknown[]) => void, warn: (...args: unknown[]) => void, error: (...args: unknown[]) => void },
 *   headers?: () => Record<string, string>,
 *   enabledModels?: () => readonly string[] | undefined,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   onCatalogChanged?: () => void,
 * }} options
 */
export function createAdapterClass(options) {
  const { LlmAdapter, settings, scheduler, log } = options
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const headers = options.headers ?? (() => ({}))
  const now = options.now ?? Date.now
  // Read per call: the key manager adds or removes keys while the plugin runs,
  // and `scheduler.sync()` keeps the pacing state in step with this list.
  const keysOf = typeof options.keys === 'function' ? options.keys : () => options.keys

  /**
   * `GET /models` through the same key pool and pacing.
   * @returns {Promise<string[]>}
   */
  async function discoverModels() {
    if (keysOf().length === 0) return []
    const lease = await scheduler.acquire(undefined)
    try {
      const response = await fetchImpl(`${settings.baseURL}/models`, {
        method: 'GET',
        redirect: 'error',
        signal: settings.requestTimeoutMs > 0 ? AbortSignal.timeout(settings.requestTimeoutMs) : undefined,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${lease.key.value}`,
          ...headers(),
          ...settings.extraHeaders,
        },
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw httpError(response.status, text, response.headers)
      }
      const payload = await response.json()
      scheduler.report(lease.key, { kind: 'ok' })
      return parseModelList(payload)
    } catch (error) {
      const failure = error instanceof NimError ? error : transportError(error, undefined, 'model discovery')
      scheduler.report(lease.key, { kind: failure.code === FAILURE_CODES.AUTH ? 'auth' : 'server' })
      throw new NimError(`model discovery failed: ${failure.message}`, FAILURE_CODES.DISCOVERY_FAILED, { cause: failure })
    } finally {
      lease.release()
    }
  }

  const catalog = createModelCatalog({
    provider: settings.provider,
    settings,
    log,
    now,
    discover: discoverModels,
    enabledModels: options.enabledModels,
    onCatalogChanged: () => options.onCatalogChanged?.(),
  })

  return class NvidiaNimAdapter extends LlmAdapter {
    /** @param {string} provider */
    providerInfo(provider) {
      return { id: provider, name: settings.displayName }
    }

    /** Retrying at the agent-step level is left to the default provider policy. */
    providerRetryPolicy() {
      return undefined
    }

    /** @param {string} provider */
    async listModels(provider) {
      return catalog.list()
    }

    /** Every model id the route knows about (ignores the selection), for the panel. */
    async catalogIds() {
      return catalog.allIds()
    }

    /** Drop the discovery cache and re-fetch, returning the fresh id list. */
    async refreshCatalog() {
      catalog.invalidate()
      return catalog.allIds()
    }

    /** @param {string} provider @param {string} model */
    async resolveModel(provider, model) {
      return catalog.resolve(model)
    }

    /** @param {string} provider @param {string} model */
    async prepareCall(provider, model) {
      return { model: catalog.resolve(model), stream: request => this.generate(request) }
    }

    /** @param {Record<string, unknown>} request */
    stream(request) {
      return this.generate(request)
    }

    /**
     * One model call, with key pacing and the retry-after-failure loop.
     * @param {Record<string, unknown>} request
     */
    async * generate(request) {
      if (keysOf().length === 0) {
        throw new NimError(
          'no NVIDIA NIM API key is configured: set NVIDIA_NIM_API_KEY (or the variables in apiKeyEnvs),'
          + ' or point keysFile at a key file, then reload the plugin',
          FAILURE_CODES.MISSING_CREDENTIAL,
        )
      }
      const body = buildRequestBody(request, settings)
      const signal = /** @type {AbortSignal | undefined} */ (request.signal)
      let emitted = 0

      for (let attempt = 1; ; attempt++) {
        const lease = await scheduler.acquire(signal)
        /** Carries the combined abort signal out of the request scope. */
        const scope = { signal: undefined }
        try {
          const response = await postRequest('/chat/completions', body, lease.key, signal, 'text/event-stream', scope)
          try {
            for await (const chunk of translateCompletions(parseJsonStream(response.body), { model: String(request.model) })) {
              const type = /** @type {{ type?: string }} */ (chunk).type
              if (typeof type === 'string' && CONTENT_CHUNKS.has(type)) emitted += 1
              yield chunk
            }
          } finally {
            response.close()
          }
          scheduler.report(lease.key, { kind: 'ok' })
          return
        } catch (error) {
          const failure = error instanceof NimError ? error : classifyAbort(error, scope.signal, signal)
          reportFailure(lease.key, failure)
          // A rejected key is a per-key failure while another key can still
          // serve the request; a transport or server failure repeats on any key.
          const authRetry = failure.code === FAILURE_CODES.AUTH && scheduler.available.length > 0
          const retryable = authRetry || isRetryable(failure)
          if (signal?.aborted || emitted > 0 || attempt >= settings.maxAttempts || !retryable) throw failure
          log?.warn(
            `nvidia-nim: ${failure.message}; retrying in ${settings.errorDelayMs}ms`
            + ` (attempt ${attempt + 1}/${settings.maxAttempts})`,
          )
          await delay(settings.errorDelayMs, signal)
        } finally {
          lease.release()
        }
      }
    }
  }

  /**
   * One HTTP request with the current key's credential, an idle deadline, and
   * the shared whole-request deadline.
   * @param {string} path
   * @param {Record<string, unknown> | undefined} body
   * @param {{ value: string, label: string }} key
   * @param {AbortSignal | undefined} signal
   * @param {string} accept
   * @param {{ signal: AbortSignal | undefined }} scope
   */
  async function postRequest(path, body, key, signal, accept, scope) {
    const controller = new AbortController()
    const idleMs = settings.idleTimeoutMs
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let idleTimer
    const clearIdle = () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
    }
    const resetIdle = () => {
      if (idleMs <= 0) return
      clearIdle()
      idleTimer = setTimeout(() => controller.abort(new IdleTimeout()), idleMs)
      // The deadline must not keep a shutting-down process alive on its own.
      idleTimer.unref?.()
    }
    const scopes = [controller.signal]
    if (signal !== undefined) scopes.push(signal)
    if (settings.requestTimeoutMs > 0) scopes.push(AbortSignal.timeout(settings.requestTimeoutMs))
    const combined = scopes.length === 1 ? scopes[0] : AbortSignal.any(scopes)
    scope.signal = combined
    resetIdle()
    /** @type {RequestInit} */
    const init = {
      method: 'POST',
      signal: combined,
      redirect: 'error',
      headers: {
        accept,
        'content-type': 'application/json',
        authorization: `Bearer ${key.value}`,
        ...headers(),
        ...settings.extraHeaders,
      },
    }
    if (body !== undefined) init.body = JSON.stringify(body)

    let response
    try {
      response = await fetchImpl(`${settings.baseURL}${path}`, init)
    } catch (error) {
      clearIdle()
      throw classifyAbort(error, combined, signal)
    }
    if (!response.ok) {
      clearIdle()
      const text = await response.text().catch(() => '')
      throw httpError(response.status, text, response.headers)
    }
    if (response.body === null) {
      clearIdle()
      throw new NimError('NVIDIA NIM returned no response body', FAILURE_CODES.EMPTY_RESPONSE)
    }
    return {
      body: withActivity(response.body, resetIdle, clearIdle),
      close: () => {
        clearIdle()
        // The body is finished; aborting releases a lingering socket.
        if (!combined.aborted) controller.abort()
      },
    }
  }

  /**
   * Feed one observed failure back into key selection.
   * @param {{ value: string, label: string }} key
   * @param {NimError} failure
   */
  function reportFailure(key, failure) {
    const detail = /** @type {{ status?: number, providerRetryAfterMs?: number }} */ (failure.failure ?? {})
    if (failure.code === FAILURE_CODES.AUTH) {
      scheduler.report(key, { kind: 'auth' })
      log?.warn(`nvidia-nim: API key ${key.label} was rejected and is no longer used`)
      return
    }
    if (failure.code === FAILURE_CODES.RATE_LIMIT) {
      scheduler.report(key, { kind: 'rate-limit', retryAfterMs: detail.providerRetryAfterMs })
      log?.debug(`nvidia-nim: API key ${key.label} is rate limited for ${detail.providerRetryAfterMs ?? 60_000}ms`)
      return
    }
    if (typeof detail.status === 'number' && detail.status >= 500) {
      scheduler.report(key, { kind: 'server' })
    }
  }
}

/** Marker for an idle-deadline abort. */
class IdleTimeout extends Error {
  constructor() {
    super('stream idle timeout')
    this.name = 'IdleTimeout'
  }
}

/**
 * Name the reason an abort happened: caller cancellation, whole-call deadline,
 * or a stream that went quiet.
 * @param {unknown} error
 * @param {AbortSignal | undefined} combined
 * @param {AbortSignal | undefined} caller
 * @returns {NimError}
 */
function classifyAbort(error, combined, caller) {
  if (error instanceof NimError) return error
  if (caller?.aborted) {
    return new NimError('NVIDIA NIM request aborted', FAILURE_CODES.ABORTED, { cause: error })
  }
  const reason = combined?.reason
  if (reason instanceof IdleTimeout) {
    return new NimError('NVIDIA NIM stream went idle and was aborted', FAILURE_CODES.TIMEOUT, { cause: error })
  }
  if (combined?.aborted) {
    return new NimError('NVIDIA NIM request exceeded its deadline', FAILURE_CODES.TIMEOUT, { cause: error })
  }
  return transportError(error, caller, 'request')
}

/**
 * Re-arm a deadline whenever a body chunk arrives.
 * @param {ReadableStream<Uint8Array>} body
 * @param {() => void} onActivity
 * @param {() => void} onEnd
 * @returns {ReadableStream<Uint8Array>}
 */
function withActivity(body, onActivity, onEnd) {
  const reader = body.getReader()
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          onEnd()
          controller.close()
          return
        }
        onActivity()
        controller.enqueue(value)
      } catch (error) {
        onEnd()
        controller.error(error)
      }
    },
    cancel(reason) {
      onEnd()
      return reader.cancel(reason)
    },
  })
}

/**
 * Abortable sleep.
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 */
function delay(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new NimError('NVIDIA NIM request aborted', FAILURE_CODES.ABORTED))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new NimError('NVIDIA NIM request aborted', FAILURE_CODES.ABORTED))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}