/**
 * Model catalog for one NVIDIA NIM route.
 *
 * The GUI only offers models an adapter advertises, so the plugin publishes
 * configured models first, then — when discovery is enabled — whatever the
 * endpoint's `GET /models` lists. Discovery costs one request against the same
 * per-key budget as an inference call, so the answer is cached in memory for
 * `discoveryCacheMs` and a failure degrades to the configured models instead of
 * failing the plugin.
 */

/** Upper bound for discovered entries, so a huge account catalog stays scrollable. */
const MAX_DISCOVERED = 500

/**
 * @typedef {{ id: string, name?: string, contextWindow?: number, maxTokens?: number }} ConfiguredModel
 */

/**
 * @param {{
 *   provider: string,
 *   settings: import('./config.js').NvidiaNimSettings,
 *   discover: () => Promise<string[]>,
 *   onCatalogChanged?: () => void,
 *   log?: { debug: (...args: unknown[]) => void, warn: (...args: unknown[]) => void },
 *   now?: () => number,
 * }} options
 */
export function createModelCatalog(options) {
  const { provider, settings, discover, onCatalogChanged, log, now = Date.now } = options
  /** @type {string[] | undefined} */
  let discovered
  let discoveredAt = 0
  /** @type {Promise<string[]> | undefined} */
  let inFlight

  /**
   * Advertised models, configured first.
   * @returns {Promise<{ provider: string, id: string, name: string, inputModalities: ['text'] }[]>}
   */
  async function list() {
    const ids = [...settings.models.map(model => model.id)]
    const extra = await discoveredIds()
    for (const id of extra) if (!ids.includes(id)) ids.push(id)
    return ids.slice(0, settings.models.length + MAX_DISCOVERED).map(id => ({
      provider,
      id,
      name: nameOf(id),
      inputModalities: /** @type {['text']} */ (['text']),
    }))
  }

  /**
   * Discovered ids, cached for the configured lifetime.
   * @returns {Promise<string[]>}
   */
  async function discoveredIds() {
    if (!settings.discoverModels) return []
    const fresh = discovered !== undefined
      && (settings.discoveryCacheMs === 0 || now() - discoveredAt < settings.discoveryCacheMs)
    if (fresh) return /** @type {string[]} */ (discovered)
    if (inFlight !== undefined) return inFlight
    inFlight = (async () => {
      try {
        const ids = await discover()
        discovered = ids
        discoveredAt = now()
        onCatalogChanged?.()
        return ids
      } catch (error) {
        // Keep a previous successful answer; otherwise degrade to configuration.
        log?.warn(`nvidia-nim: model discovery failed, continuing with configured models: ${error instanceof Error ? error.message : String(error)}`)
        return discovered ?? []
      } finally {
        inFlight = undefined
      }
    })()
    return inFlight
  }

  /**
   * Display name: the configured name, else the model id.
   * @param {string} id
   * @returns {string}
   */
  function nameOf(id) {
    const configured = settings.models.find(model => model.id === id)
    return configured?.name ?? id
  }

  /**
   * Exact-route metadata for one model id.
   * @param {string} id
   * @returns {{ provider: string, id: string, name: string, inputModalities: ['text'], context: { contextWindow: number }, defaultMaxTokens: number }}
   */
  function resolve(id) {
    const configured = settings.models.find(model => model.id === id)
    const contextWindow = configured?.contextWindow ?? settings.defaultContextWindow
    const maxTokens = configured?.maxTokens ?? settings.defaultMaxTokens
    return {
      provider,
      id,
      name: configured?.name ?? id,
      inputModalities: /** @type {['text']} */ (['text']),
      context: { contextWindow },
      defaultMaxTokens: maxTokens,
    }
  }

  return { list, resolve, nameOf }
}

/**
 * Parse one `GET /models` payload into model ids.
 * @param {unknown} payload
 * @returns {string[]}
 */
export function parseModelList(payload) {
  /** @type {unknown[]} */
  let entries = []
  if (Array.isArray(payload)) entries = payload
  else if (payload !== null && typeof payload === 'object') {
    const record = /** @type {Record<string, unknown>} */ (payload)
    if (Array.isArray(record.data)) entries = record.data
    else if (Array.isArray(record.models)) entries = record.models
    else if (record.models !== null && typeof record.models === 'object') entries = Object.values(record.models)
  }
  const ids = []
  for (const entry of entries) {
    const id = typeof entry === 'string'
      ? entry
      : entry !== null && typeof entry === 'object' && typeof /** @type {Record<string, unknown>} */ (entry).id === 'string'
        ? /** @type {string} */ (/** @type {Record<string, unknown>} */ (entry).id)
        : undefined
    if (id !== undefined && id !== '' && !ids.includes(id)) ids.push(id)
  }
  ids.sort((left, right) => left.localeCompare(right))
  return ids
}