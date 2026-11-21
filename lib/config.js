/**
 * Configuration for the NVIDIA NIM model supply.
 *
 * Every field is optional; defaults describe the public NVIDIA NIM endpoint
 * with one key from `NVIDIA_NIM_API_KEY`, one request per second per key, forty
 * per minute per key, and a two-second sleep before re-sending a failed request.
 * Unknown keys are refused so a typo cannot silently fall back to a default.
 */

export const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1'

/** Field-by-field description used by the validation messages and README. */
export const FIELDS = Object.freeze({
  provider: 'provider route name the model selector shows',
  displayName: 'provider label shown beside the route',
  baseURL: 'OpenAI-compatible endpoint, without a trailing slash',
  apiKeys: 'inline API keys (prefer apiKeyEnvs or keysFile so no secret is written to a profile patch)',
  apiKeyEnvs: 'environment variables holding API keys; one variable may hold a comma-separated list',
  keysFile: 'key file path, one key per line, `#` starts a comment',
  requestsPerSecond: 'maximum request starts per second on each key',
  requestsPerMinute: 'maximum request starts per rolling minute on each key',
  errorDelayMs: 'sleep before re-sending a failed request, in milliseconds',
  maxAttempts: 'attempts per request, including the first (1 disables in-adapter retry)',
  requestTimeoutMs: 'whole-request deadline in milliseconds (0 disables it)',
  idleTimeoutMs: 'abort when no stream data arrives for this long, in milliseconds (0 disables it)',
  models: 'models to advertise, first in the selector',
  discoverModels: 'also advertise the models `GET /models` reports',
  discoveryCacheMs: 'how long a discovery answer stays cached, in milliseconds (0 caches until restart)',
  defaultContextWindow: 'context window advertised for a model without one, in tokens',
  defaultMaxTokens: 'output cap sent when a request names none',
  maxTokensField: 'wire field carrying the output cap',
  includeUsage: 'ask the endpoint for a final usage chunk',
  extraHeaders: 'additional request headers, for gateways behind a proxy',
  managerEnabled: 'serve the loopback key manager used by the settings tab (add, remove, batch test)',
})

const KNOWN_KEYS = new Set(Object.keys(FIELDS))

/**
 * @typedef {{ id: string, name?: string, contextWindow?: number, maxTokens?: number }} ConfiguredModel
 * @typedef {{
 *   provider: string,
 *   displayName: string,
 *   baseURL: string,
 *   apiKeys: string[],
 *   apiKeyEnvs: string[],
 *   keysFile: string,
 *   requestsPerSecond: number,
 *   requestsPerMinute: number,
 *   errorDelayMs: number,
 *   maxAttempts: number,
 *   requestTimeoutMs: number,
 *   idleTimeoutMs: number,
 *   models: ConfiguredModel[],
 *   discoverModels: boolean,
 *   discoveryCacheMs: number,
 *   defaultContextWindow: number,
 *   defaultMaxTokens: number,
 *   maxTokensField: 'max_tokens' | 'max_completion_tokens',
 *   includeUsage: boolean,
 *   extraHeaders: Record<string, string>,
 *   managerEnabled: boolean,
 * }} NvidiaNimSettings
 */

/**
 * Validate and default one plugin configuration.
 * @param {unknown} input - the loader row's `config`.
 * @returns {NvidiaNimSettings}
 */
export function normalizeConfig(input) {
  const raw = input === undefined || input === null ? {} : input
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('nvidia-nim: config must be an object')
  const config = /** @type {Record<string, unknown>} */ (raw)
  const unknown = Object.keys(config).filter(key => !KNOWN_KEYS.has(key))
  if (unknown.length > 0) {
    throw new Error(`nvidia-nim: unknown config key${unknown.length === 1 ? '' : 's'} ${unknown.map(key => JSON.stringify(key)).join(', ')}; see README.md for the accepted fields`)
  }

  const provider = optionalString(config.provider, 'provider') ?? 'nvidia-nim'
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(provider)) {
    throw new Error('nvidia-nim: provider must be a lowercase route name ([a-z0-9._-])')
  }

  const baseURL = (optionalString(config.baseURL, 'baseURL') ?? DEFAULT_BASE_URL).replace(/\/+$/u, '')
  if (!/^https?:\/\//iu.test(baseURL)) throw new Error('nvidia-nim: baseURL must be an http(s) URL')

  const maxTokensField = optionalString(config.maxTokensField, 'maxTokensField') ?? 'max_tokens'
  if (maxTokensField !== 'max_tokens' && maxTokensField !== 'max_completion_tokens') {
    throw new Error('nvidia-nim: maxTokensField must be "max_tokens" or "max_completion_tokens"')
  }

  const models = optionalArray(config.models, 'models').map((entry, index) => normalizeModel(entry, index))
  const configuredEnvs = optionalArray(config.apiKeyEnvs, 'apiKeyEnvs').map((value, index) => {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`nvidia-nim: apiKeyEnvs[${index}] must be a non-empty string`)
    return value.trim()
  })

  return {
    provider,
    displayName: optionalString(config.displayName, 'displayName') ?? 'NVIDIA NIM',
    baseURL,
    apiKeys: optionalArray(config.apiKeys, 'apiKeys').map((value, index) => {
      if (typeof value !== 'string') throw new Error(`nvidia-nim: apiKeys[${index}] must be a string`)
      return value
    }),
    apiKeyEnvs: configuredEnvs.length === 0 ? ['NVIDIA_NIM_API_KEY'] : configuredEnvs,
    keysFile: optionalString(config.keysFile, 'keysFile') ?? '',
    requestsPerSecond: positiveNumber(config.requestsPerSecond, 'requestsPerSecond') ?? 1,
    requestsPerMinute: positiveNumber(config.requestsPerMinute, 'requestsPerMinute') ?? 40,
    errorDelayMs: nonNegativeNumber(config.errorDelayMs, 'errorDelayMs') ?? 2000,
    maxAttempts: positiveInteger(config.maxAttempts, 'maxAttempts') ?? 4,
    requestTimeoutMs: nonNegativeNumber(config.requestTimeoutMs, 'requestTimeoutMs') ?? 600_000,
    idleTimeoutMs: nonNegativeNumber(config.idleTimeoutMs, 'idleTimeoutMs') ?? 180_000,
    models,
    discoverModels: optionalBoolean(config.discoverModels, 'discoverModels') ?? true,
    discoveryCacheMs: nonNegativeNumber(config.discoveryCacheMs, 'discoveryCacheMs') ?? 600_000,
    defaultContextWindow: positiveInteger(config.defaultContextWindow, 'defaultContextWindow') ?? 131_072,
    defaultMaxTokens: positiveInteger(config.defaultMaxTokens, 'defaultMaxTokens') ?? 4096,
    maxTokensField: /** @type {'max_tokens' | 'max_completion_tokens'} */ (maxTokensField),
    includeUsage: optionalBoolean(config.includeUsage, 'includeUsage') ?? true,
    extraHeaders: normalizeHeaders(config.extraHeaders),
    managerEnabled: optionalBoolean(config.managerEnabled, 'managerEnabled') ?? true,
  }
}

/**
 * One configured model entry.
 * @param {unknown} entry
 * @param {number} index
 * @returns {ConfiguredModel}
 */
function normalizeModel(entry, index) {
  if (typeof entry === 'string') {
    if (entry.trim() === '') throw new Error(`nvidia-nim: models[${index}] must not be empty`)
    return { id: entry.trim() }
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`nvidia-nim: models[${index}] must be a model id or an object with an id`)
  }
  const record = /** @type {Record<string, unknown>} */ (entry)
  const id = optionalString(record.id, `models[${index}].id`)
  if (id === undefined || id === '') throw new Error(`nvidia-nim: models[${index}].id is required`)
  const model = { id }
  const name = optionalString(record.name, `models[${index}].name`)
  if (name !== undefined) model.name = name
  const contextWindow = positiveInteger(record.contextWindow, `models[${index}].contextWindow`)
  if (contextWindow !== undefined) model.contextWindow = contextWindow
  const maxTokens = positiveInteger(record.maxTokens, `models[${index}].maxTokens`)
  if (maxTokens !== undefined) model.maxTokens = maxTokens
  return model
}

/**
 * Additional request headers, validated as a flat string dictionary.
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function normalizeHeaders(value) {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('nvidia-nim: extraHeaders must be an object of header name to value')
  }
  /** @type {Record<string, string>} */
  const out = {}
  for (const [name, headerValue] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    if (typeof headerValue !== 'string') throw new Error(`nvidia-nim: extraHeaders.${name} must be a string`)
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) throw new Error(`nvidia-nim: extraHeaders.${name} is not a valid header name`)
    out[name] = headerValue
  }
  return Object.freeze(out)
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {string | undefined}
 */
function optionalString(value, path) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`nvidia-nim: ${path} must be a string`)
  return value.trim()
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {unknown[]}
 */
function optionalArray(value, path) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`nvidia-nim: ${path} must be an array`)
  return value
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {boolean | undefined}
 */
function optionalBoolean(value, path) {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`nvidia-nim: ${path} must be true or false`)
  return value
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {number | undefined}
 */
function positiveNumber(value, path) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`nvidia-nim: ${path} must be a positive number`)
  }
  return value
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {number | undefined}
 */
function nonNegativeNumber(value, path) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`nvidia-nim: ${path} must be a number of milliseconds, zero or greater`)
  }
  return value
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {number | undefined}
 */
function positiveInteger(value, path) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`nvidia-nim: ${path} must be a positive integer`)
  }
  return value
}