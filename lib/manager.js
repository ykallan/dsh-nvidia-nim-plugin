/**
 * Loopback key manager for the NVIDIA NIM plugin.
 *
 * The Web GUI's settings tab is browser code and cannot write files, and the
 * Desktop renderer reaches the Host through an IPC bridge that carries only the
 * harness's own API. So the Host half listens on a loopback-only HTTP port and
 * the tab talks to it directly:
 *
 *   GET  /state        current keys (masked), limits, and cached test results
 *   POST /keys/add     append every non-empty line of `text` as one key
 *   POST /keys/remove  delete one key by its hash id
 *   POST /keys/test    prove each key with a one-token chat completion
 *
 * `GET /models` answers without authentication on the public endpoint, so it
 * cannot tell a valid key from a bogus one; a one-token completion can, and it
 * costs one request plus one output token per key.
 *
 * Security: the socket binds 127.0.0.1, every request must come from a loopback
 * Host and carry the `x-nvidia-nim-manager` header (a custom header forces a
 * CORS preflight, which only loopback page origins and the Electron `null`
 * origin are answered for), and no response ever contains a full key. Any local
 * process could still call it, and could read the key file itself; the manager
 * adds no exposure beyond that.
 */

import { createServer } from 'node:http'
import { FAILURE_CODES, NimError, httpError } from './errors.js'
import { keyFileWritable, maskKey, keyId } from './key-store.js'
import { parseModelList } from './discovery.js'

/** Preferred loopback ports, tried in order; the client probes the same list. */
export const MANAGER_PORTS = Object.freeze([19871, 19872, 19873, 19874, 19875])

/** Header every request carries; its value is irrelevant, its presence is not. */
export const MANAGER_HEADER = 'x-nvidia-nim-manager'

/** Largest accepted request body: a batch of keys is small. */
const MAX_BODY_BYTES = 256 * 1024

/** Requests run in parallel during a batch test. */
const TEST_CONCURRENCY = 3

/** One probe must settle inside this window; a one-token completion is slow on some models. */
const TEST_TIMEOUT_MS = 30_000

const LOOPBACK_ORIGIN = /^(?:https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?)$/u

/**
 * Whether a page origin may read this manager's answers.
 *
 * The Web GUI is an http loopback origin, the Desktop renderer is a native
 * application scheme (`dsh-app://`), and a sandboxed frame reports `null`. Any
 * ordinary website is an `http(s)` origin whose authority is not loopback, so
 * it is denied — and because every request carries a custom header, the browser
 * sends a preflight this answer refuses.
 * @param {string} origin
 * @returns {boolean}
 */
function originAllowed(origin) {
  if (origin === 'null' || LOOPBACK_ORIGIN.test(origin)) return true
  try {
    const { protocol } = new URL(origin)
    return protocol !== 'http:' && protocol !== 'https:'
  } catch {
    return false
  }
}

/**
 * Create the manager without starting it.
 * @param {{
 *   settings: import('./config.js').NvidiaNimSettings,
 *   store: import('./key-store.js').KeyFileStore,
 *   scheduler: import('./rate-limit.js').KeyScheduler,
 *   keys: () => readonly { value: string, label: string }[],
 *   keyFile: string,
 *   log?: { debug: (...args: unknown[]) => void, warn: (...args: unknown[]) => void },
 *   fetchImpl?: typeof fetch,
 *   onKeysChanged?: () => void,
 *   now?: () => number,
 *   ports?: readonly number[],
 * }} options
 */
export function createKeyManager(options) {
  const { settings, store, scheduler, keys, keyFile, log } = options
  const ports = options.ports ?? MANAGER_PORTS
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const now = options.now ?? Date.now
  const onKeysChanged = options.onKeysChanged ?? (() => {})
  /** Cached probe outcomes by key id. @type {Map<string, Record<string, unknown>>} */
  const results = new Map()
  /** @type {import('node:http').Server | undefined} */
  let server
  /** @type {number | undefined} */
  let port
  let disposed = false

  /**
   * Assemble the state the UI renders.
   * @returns {Record<string, unknown>}
   */
  function state() {
    const stats = scheduler.stats()
    const writable = keyFileWritable(keyFile)
    const entries = keys()
    return {
      app: 'dsh-nvidia-nim-manager',
      provider: settings.provider,
      displayName: settings.displayName,
      baseURL: settings.baseURL,
      keyFile: { path: keyFile, ...writable },
      limits: {
        perSecond: settings.requestsPerSecond,
        perMinute: settings.requestsPerMinute,
        errorDelayMs: settings.errorDelayMs,
      },
      ports: MANAGER_PORTS,
      port: port ?? null,
      keys: entries.map((entry, index) => {
        const id = keyId(entry.value)
        const stat = stats[index]
        return {
          id,
          label: entry.label,
          masked: maskKey(entry.value),
          disabled: stat?.disabled ?? false,
          cooldownMs: stat?.cooldownMs ?? 0,
          inWindow: stat?.inWindow ?? 0,
          requests: stat?.requests ?? 0,
          lastTest: results.get(id) ?? null,
        }
      }),
    }
  }

  /**
   * Append a pasted batch and refresh the live pool.
   * @param {string} text
   */
  function add(text) {
    if (typeof text !== 'string') throw new NimError('text must be a string', FAILURE_CODES.INVALID_REQUEST)
    const outcome = store.add(text)
    if (outcome.added.length > 0) onKeysChanged()
    log?.debug(`nvidia-nim: added ${outcome.added.length} key(s) from the manager`)
    return { ...outcome, state: state() }
  }

  /**
   * Remove one key and refresh the live pool.
   * @param {string} id
   */
  function remove(id) {
    if (typeof id !== 'string' || id === '') throw new NimError('id is required', FAILURE_CODES.INVALID_REQUEST)
    const removed = store.remove(id)
    for (const [key, value] of results) if (key === id) results.delete(key)
    if (removed) onKeysChanged()
    return { removed, state: state() }
  }

  /**
   * Probe every requested key (all when `ids` is omitted), and feed the outcome
   * back into key selection.
   * @param {readonly string[] | undefined} ids
   */
  async function test(ids) {
    const wanted = ids === undefined || ids.length === 0 ? undefined : new Set(ids)
    const targets = keys()
      .map(entry => ({ entry, id: keyId(entry.value) }))
      .filter(target => wanted === undefined || wanted.has(target.id))
    const probe = await probeTarget()
    const outcomes = new Array(targets.length)
    let cursor = 0
    const worker = async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        const target = targets[index]
        if (target === undefined) return
        outcomes[index] = await probeKey(target.id, target.entry, probe)
      }
    }
    await Promise.all(Array.from({ length: Math.min(TEST_CONCURRENCY, targets.length) }, worker))
    return { results: outcomes, state: state() }
  }

  /**
   * Pick the model a probe asks for, and the size of the public catalog it came
   * from. The catalog itself needs no credential, so it can be read before any
   * key is proven.
   * @returns {Promise<{ model: string, models?: number }>}
   */
  async function probeTarget() {
    if (settings.models.length > 0) return { model: settings.models[0].id }
    try {
      const response = await fetchImpl(`${settings.baseURL}/models`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        headers: { accept: 'application/json', 'user-agent': 'dsh-nvidia-nim/manager' },
      })
      if (response.ok) {
        const ids = parseModelList(await response.json().catch(() => null))
        // A small model answers a one-token probe fastest.
        const cheap = ids.find(id => /flash|nano|lite|lightning|8b|mini|tiny|small/iu.test(id))
        const chosen = cheap ?? ids[0]
        if (chosen !== undefined) return { model: chosen, models: ids.length }
      }
    } catch {
      // Fall through to the configured default below.
    }
    return { model: 'meta/llama-3.1-8b-instruct' }
  }

  /**
   * Prove one key with a one-token completion.
   * @param {string} id
   * @param {{ value: string, label: string }} entry
   * @param {{ model: string, models?: number }} probe
   */
  async function probeKey(id, entry, probe) {
    const started = now()
    /** @type {Record<string, unknown>} */
    let outcome
    const signal = AbortSignal.timeout(TEST_TIMEOUT_MS)
    try {
      const response = await fetchImpl(`${settings.baseURL}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${entry.value}`,
          'user-agent': 'dsh-nvidia-nim/manager',
        },
        body: JSON.stringify({
          model: probe.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          temperature: 0,
          stream: false,
        }),
      })
      if (response.ok) {
        await response.arrayBuffer().catch(() => undefined)
        scheduler.markHealthy({ value: entry.value, label: entry.label })
        outcome = probe.models === undefined
          ? { ok: true, status: response.status, model: probe.model }
          : { ok: true, status: response.status, model: probe.model, models: probe.models }
      } else {
        const text = await response.text().catch(() => '')
        const failure = httpError(response.status, text, response.headers)
        if (failure.code === FAILURE_CODES.AUTH) {
          scheduler.report({ value: entry.value, label: entry.label }, { kind: 'auth' })
        } else if (failure.code === FAILURE_CODES.RATE_LIMIT) {
          scheduler.report(
            { value: entry.value, label: entry.label },
            { kind: 'rate-limit', retryAfterMs: failure.failure.providerRetryAfterMs },
          )
        }
        outcome = { ok: false, status: response.status, code: failure.code, message: failure.message }
      }
    } catch (error) {
      outcome = {
        ok: false,
        code: 'TRANSPORT',
        message: error instanceof Error ? error.message : String(error),
      }
    }
    const record = { id, at: now(), latencyMs: now() - started, ...outcome }
    results.set(id, record)
    return record
  }

  /**
   * Start listening on the first free preferred port.
   * @returns {Promise<number | undefined>} the bound port, or undefined when all are taken.
   */
  async function start() {
    for (const candidate of ports) {
      if (disposed) return undefined
      const bound = await listen(candidate)
      if (bound !== undefined) {
        // A disposal that raced this await still owns the socket it just bound.
        if (disposed) {
          dispose()
          return undefined
        }
        port = bound
        log?.debug(`nvidia-nim: key manager listening on http://127.0.0.1:${bound}`)
        return bound
      }
    }
    log?.warn(`nvidia-nim: key manager could not bind any of ${ports.join(', ')}; the settings tab will report it unavailable`)
    return undefined
  }

  /**
   * Try one port.
   * @param {number} candidate
   * @returns {Promise<number | undefined>}
   */
  function listen(candidate) {
    return new Promise(resolve => {
      const candidateServer = createServer((request, response) => {
        handle(request, response).catch(error => {
          log?.warn('nvidia-nim: key manager request failed', error)
          if (!response.headersSent) send(response, 500, { ok: false, error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) } })
          else response.destroy()
        })
      })
      candidateServer.on('error', () => {
        candidateServer.close()
        resolve(undefined)
      })
      candidateServer.listen(candidate, '127.0.0.1', () => {
        server = candidateServer
        const address = candidateServer.address()
        resolve(typeof address === 'object' && address !== null ? address.port : candidate)
      })
    })
  }

  /** Stop listening and release the port. */
  function dispose() {
    disposed = true
    const current = server
    server = undefined
    port = undefined
    if (current === undefined) return
    current.close()
    current.closeAllConnections?.()
  }

  /**
   * Route one request.
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async function handle(request, response) {
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined
    const allowedOrigin = origin !== undefined && originAllowed(origin)
    const cors = {
      ...allowedOrigin ? {
        'access-control-allow-origin': origin,
        'access-control-allow-headers': `content-type, ${MANAGER_HEADER}`,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-max-age': '600',
        vary: 'origin',
      } : { vary: 'origin' },
    }
    if (request.method === 'OPTIONS') {
      send(response, 204, undefined, cors)
      return
    }
    if (!isLoopbackHost(request.headers.host)) {
      send(response, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'the manager only answers loopback requests' } }, cors)
      return
    }
    if (request.headers[MANAGER_HEADER] === undefined) {
      send(response, 403, { ok: false, error: { code: 'FORBIDDEN', message: `missing ${MANAGER_HEADER} header` } }, cors)
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    try {
      if (request.method === 'GET' && url.pathname === '/state') {
        send(response, 200, state(), cors)
        return
      }
      if (request.method === 'POST' && url.pathname === '/keys/add') {
        const body = await readJson(request)
        send(response, 200, add(String(body.text ?? '')), cors)
        return
      }
      if (request.method === 'POST' && url.pathname === '/keys/remove') {
        const body = await readJson(request)
        send(response, 200, remove(String(body.id ?? '')), cors)
        return
      }
      if (request.method === 'POST' && url.pathname === '/keys/test') {
        const body = await readJson(request)
        const ids = Array.isArray(body.ids) ? body.ids.filter(value => typeof value === 'string') : undefined
        send(response, 200, await test(ids), cors)
        return
      }
      send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: `unknown route ${request.method} ${url.pathname}` } }, cors)
    } catch (error) {
      const code = error instanceof NimError ? error.code : 'INVALID_REQUEST'
      send(response, code === 'INVALID_REQUEST' ? 400 : 500, {
        ok: false,
        error: { code, message: error instanceof Error ? error.message : String(error) },
      }, cors)
    }
  }

  return { start, dispose, state, add, remove, test, get port() { return port } }
}

/**
 * Read one bounded JSON body.
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new NimError('request body too large', FAILURE_CODES.INVALID_REQUEST)
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new NimError('request body is not JSON', FAILURE_CODES.INVALID_REQUEST)
  }
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} payload
 * @param {Record<string, string | number>} [headers]
 */
function send(response, status, payload, headers = {}) {
  if (payload === undefined) {
    response.writeHead(status, { ...headers })
    response.end()
    return
  }
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  response.end(body)
}

/**
 * Whether a `Host` header names the loopback interface.
 * @param {string | undefined} host
 * @returns {boolean}
 */
function isLoopbackHost(host) {
  if (host === undefined) return false
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return name === '127.0.0.1' || name === '[::1]' || name === 'localhost'
}