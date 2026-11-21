/**
 * Failure vocabulary for the NVIDIA NIM adapter.
 *
 * The harness normalizes anything thrown by an adapter with
 * `normalizeLlmFailure`, which trusts an error's own `code` and own `failure`
 * data properties (that is how cross-package error copies survive). This
 * module therefore builds plain `Error` instances carrying exactly those two
 * properties, so this plugin reports stable machine codes without importing
 * `@deepseek-ai/dsh-llm`.
 */

/** Failure codes the runtime and `dsh-llm-retry` already understand. */
export const FAILURE_CODES = Object.freeze({
  ABORTED: 'ABORTED',
  AUTH: 'AUTH',
  CONTENT_REFUSED: 'CONTENT_REFUSED',
  CONTEXT_WINDOW_EXCEEDED: 'CONTEXT_WINDOW_EXCEEDED',
  DISCOVERY_FAILED: 'DISCOVERY_FAILED',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  INVALID_CREDENTIAL: 'INVALID_CREDENTIAL',
  INVALID_REQUEST: 'INVALID_REQUEST',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  MISSING_CREDENTIAL: 'MISSING_CREDENTIAL',
  QUOTA: 'QUOTA',
  RATE_LIMIT: 'RATE_LIMIT',
  SERVER: 'SERVER',
  STREAM_CLOSED: 'STREAM_CLOSED',
  TIMEOUT: 'TIMEOUT',
  TRANSPORT: 'TRANSPORT',
  UNKNOWN_MODEL: 'UNKNOWN_MODEL',
  UNSUPPORTED_CONTENT: 'UNSUPPORTED_CONTENT',
})

/** Codes an in-adapter retry may repeat without changing the request. */
const RETRYABLE_CODES = new Set([
  FAILURE_CODES.TRANSPORT,
  FAILURE_CODES.TIMEOUT,
  FAILURE_CODES.SERVER,
  FAILURE_CODES.RATE_LIMIT,
  FAILURE_CODES.EMPTY_RESPONSE,
  FAILURE_CODES.MALFORMED_RESPONSE,
  FAILURE_CODES.STREAM_CLOSED,
])

/** HTTP statuses whose retry is worth the two-second sleep. */
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529])

/** Wording that means the *account* ran out of credit rather than this request being too fast. */
const QUOTA_WORDS = /\b(?:insufficient[_\s-]?(?:quota|balance|credits?)|quota[_\s-]?(?:exceeded|exhausted|reached)|out[_\s-]+of[_\s-]+(?:credits?|budget)|payment[_\s-]+required)\b/i

/** Wording that means the request exceeded the model's context window. */
const CONTEXT_WORDS = /\b(?:context[_\s-]?(?:length|window)|maximum[_\s-]+context|prompt[_\s-]+is[_\s-]+too[_\s-]+long|request[_\s-]+too[_\s-]+large)\b/i

/**
 * One provider or transport failure with the two data properties the harness
 * reads: a stable `code` and a serializable `failure`.
 */
export class NimError extends Error {
  /**
   * @param {string} message - human-readable summary that never contains a key.
   * @param {string} code - stable failure code (see {@link FAILURE_CODES}).
   * @param {{ status?: number, providerRetryAfterMs?: number, requestId?: string, cause?: unknown }} [options]
   */
  constructor(message, code, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'NimError'
    // Own data properties: normalizeLlmFailure reads both without invoking accessors.
    this.code = code
    /** @type {{ message: string, code: string, status?: number, providerRetryAfterMs?: number, requestId?: string }} */
    const failure = { message, code }
    if (options.status !== undefined) failure.status = options.status
    if (options.providerRetryAfterMs !== undefined) failure.providerRetryAfterMs = options.providerRetryAfterMs
    if (options.requestId !== undefined) failure.requestId = options.requestId
    this.failure = Object.freeze(failure)
  }
}

/**
 * Whether a failure is safe to repeat inside this adapter.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRetryable(error) {
  if (!(error instanceof Error)) return false
  const code = /** @type {{ code?: unknown }} */ (error).code
  if (typeof code === 'string') {
    if (code.startsWith('HTTP_')) {
      const status = Number(code.slice(5))
      return RETRYABLE_STATUSES.has(status)
    }
    return RETRYABLE_CODES.has(code)
  }
  const status = /** @type {{ status?: unknown }} */ (error).status
  return typeof status === 'number' && RETRYABLE_STATUSES.has(status)
}

/**
 * Read a `retry-after` header as milliseconds.
 * @param {Headers | undefined} headers
 * @returns {number | undefined}
 */
function retryAfterMs(headers) {
  const raw = headers?.get('retry-after')
  if (raw == null) return undefined
  if (/^\d+(?:\.\d+)?$/u.test(raw)) return Number(raw) * 1000
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

/**
 * Classify one non-2xx response.
 * @param {number} status - HTTP status.
 * @param {string} body - bounded response text (already read).
 * @param {Headers} [headers]
 * @returns {NimError}
 */
export function httpError(status, body, headers) {
  const text = body.trim().slice(0, 1200)
  let detail = text
  let providerMessage = ''
  let providerCode = ''
  try {
    const parsed = JSON.parse(text)
    const error = parsed?.error
    if (typeof error === 'string') providerMessage = error
    else if (error !== null && typeof error === 'object') {
      if (typeof error.message === 'string') providerMessage = error.message
      if (typeof error.code === 'string') providerCode = error.code
      else if (typeof error.type === 'string') providerCode = error.type
    } else if (typeof parsed?.detail === 'string') {
      providerMessage = parsed.detail
    }
    if (providerMessage !== '') detail = providerMessage
  } catch {
    // A gateway that does not answer with JSON keeps its raw text as the detail.
  }
  const haystack = `${providerCode} ${detail}`
  const summary = detail === '' ? `HTTP ${status}` : `HTTP ${status}: ${detail}`
  const options = { status }
  const requestId = headers?.get('request-id') ?? headers?.get('x-request-id')
  if (requestId) options.requestId = requestId
  const retry = retryAfterMs(headers)
  if (retry !== undefined && retry > 0) options.providerRetryAfterMs = retry

  if (status === 401 || status === 403) return new NimError(`NVIDIA NIM rejected the API key (${summary})`, FAILURE_CODES.AUTH, options)
  if (status === 402 || QUOTA_WORDS.test(haystack)) return new NimError(`NVIDIA NIM account quota exhausted (${summary})`, FAILURE_CODES.QUOTA, options)
  if (status === 429) return new NimError(`NVIDIA NIM rate limit reached (${summary})`, FAILURE_CODES.RATE_LIMIT, options)
  if (status === 404) return new NimError(`NVIDIA NIM does not serve this model (${summary})`, FAILURE_CODES.UNKNOWN_MODEL, options)
  if (status === 408) return new NimError(`NVIDIA NIM request timed out (${summary})`, FAILURE_CODES.TIMEOUT, options)
  if (status >= 500) return new NimError(`NVIDIA NIM server failure (${summary})`, FAILURE_CODES.SERVER, options)
  if (status === 400 || status === 413 || status === 422) {
    return new NimError(
      `NVIDIA NIM rejected the request (${summary})`,
      CONTEXT_WORDS.test(haystack) ? FAILURE_CODES.CONTEXT_WINDOW_EXCEEDED : FAILURE_CODES.INVALID_REQUEST,
      options,
    )
  }
  return new NimError(`NVIDIA NIM request failed (${summary})`, `HTTP_${status}`, options)
}

/**
 * Wrap a transport-level throw (DNS, TLS, reset, aborted fetch) as a failure.
 * @param {unknown} cause
 * @param {AbortSignal | undefined} signal - the caller's cancellation signal.
 * @param {string} what - short description of the operation, for the message.
 * @returns {NimError}
 */
export function transportError(cause, signal, what) {
  if (signal?.aborted) return new NimError(`NVIDIA NIM ${what} aborted`, FAILURE_CODES.ABORTED, { cause })
  const code = /** @type {{ code?: unknown, name?: unknown }} */ (cause)?.code
  if (code === 'TIMEOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
    return new NimError(`NVIDIA NIM ${what} timed out`, FAILURE_CODES.TIMEOUT, { cause })
  }
  const message = cause instanceof Error ? cause.message : String(cause)
  return new NimError(`NVIDIA NIM ${what} failed: ${message}`, FAILURE_CODES.TRANSPORT, { cause })
}