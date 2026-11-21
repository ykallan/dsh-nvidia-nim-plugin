/**
 * NVIDIA NIM model supply for DeepSeek Harness.
 *
 * The plugin registers one LLM provider route on `ctx.llm`. Models come from
 * the configuration and, when enabled, from the endpoint's own `GET /models`
 * catalog. Every request draws a key from the configured pool under per-key
 * pacing: at most one start per second, at most forty per rolling minute, and a
 * two-second sleep before re-sending a request that failed.
 *
 * Configuration is read once per activation, so editing it (or adding a key to
 * the environment or key file) reloads the plugin and rebuilds the pool.
 *
 * @module dsh-nvidia-nim
 */

import { createRequire } from 'node:module'
import { normalizeConfig } from './lib/config.js'
import { resolveApiKeys, resolveKeyFile } from './lib/keys.js'
import { KeyScheduler } from './lib/rate-limit.js'
import { createAdapterClass } from './lib/adapter.js'
import { KeyFileStore } from './lib/key-store.js'
import { createKeyManager } from './lib/manager.js'

const { version } = /** @type {{ version: string }} */ (createRequire(import.meta.url)('./package.json'))

export const name = 'nvidia-nim'
export const inject = ['llm']

/**
 * The harness exports the adapter base class and the attribution headers. When
 * this plugin is loaded outside a dsh profile (a unit test, a copied directory
 * without the peer resolved) the fallbacks below keep it loadable; the runtime
 * contract is duck-typed, so only attribution changes.
 */
let bridge
try {
  bridge = await import('@deepseek-ai/dsh-llm')
} catch (error) {
  bridge = undefined
  // Nothing is mounted yet, so this is the only place the fallback is visible.
  process.emitWarning(
    `dsh-nvidia-nim: @deepseek-ai/dsh-llm could not be resolved (${error instanceof Error ? error.message : String(error)});`
    + ' running with the built-in attribution fallback',
  )
}

/** Base class used only when the harness package is unavailable. */
class StandaloneAdapter {
  providerInfo(provider) {
    return { id: provider, name: provider }
  }

  providerRetryPolicy() {
    return undefined
  }

  async listModels() {
    return []
  }

  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }

  async prepareCall(provider, model) {
    return { model: await this.resolveModel(provider, model), stream: request => this.stream(request) }
  }

  stream() {
    throw new Error('dsh-nvidia-nim: the standalone adapter base cannot stream')
  }
}

const BaseAdapter = bridge?.LlmAdapter ?? StandaloneAdapter

/**
 * Headers every provider request carries: the harness attribution when the
 * real package loaded, otherwise a self-identifying product token.
 * @returns {Record<string, string>}
 */
function requestHeaders() {
  if (typeof bridge?.attributionHeaders === 'function') return bridge.attributionHeaders()
  const suffix = process.env.DSH_USER_AGENT_SUFFIX
  return {
    'user-agent': `deepseek-harness/nvidia-nim-plugin-${version}`
      + (typeof suffix === 'string' && suffix !== '' ? ` ${suffix}` : ''),
  }
}

/**
 * Mount the route.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config - this row's `config`.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  let pool = resolveApiKeys(settings)
  const logger = ctx.logger
  const keysNow = () => pool.keys

  if (pool.keys.length === 0) {
    logger.error(
      'nvidia-nim: no API key configured, so every model request will fail.\n'
      + `  ${pool.problems.join('\n  ')}\n`
      + '  add keys in Settings → Plugins → NVIDIA NIM keys, set NVIDIA_NIM_API_KEY, or point keysFile at a key file.',
    )
  } else {
    for (const problem of pool.problems) logger.debug(`nvidia-nim: ${problem}`)
  }

  const scheduler = new KeyScheduler({
    keys: pool.keys,
    requestsPerSecond: settings.requestsPerSecond,
    requestsPerMinute: settings.requestsPerMinute,
  })

  const Adapter = createAdapterClass({
    LlmAdapter: BaseAdapter,
    settings,
    keys: keysNow,
    scheduler,
    log: logger,
    headers: requestHeaders,
    onCatalogChanged: () => {
      try {
        ctx.emit('llm/models-updated', settings.provider)
      } catch (error) {
        logger.debug('nvidia-nim: could not announce the updated model catalog', error)
      }
    },
  })

  const adapter = new Adapter()
  const release = ctx.llm.registerAdapter([settings.provider], adapter)

  // The key file is the manager's storage, so a key added in the UI survives a
  // restart exactly like one typed into the file by hand.
  const keyFile = resolveKeyFile(settings)
  const manager = settings.managerEnabled
    ? createKeyManager({
      settings,
      store: new KeyFileStore(keyFile),
      scheduler,
      keys: keysNow,
      keyFile,
      log: logger,
      onKeysChanged: () => {
        pool = resolveApiKeys(settings)
        scheduler.sync(pool.keys)
        try {
          ctx.emit('llm/models-updated', settings.provider)
        } catch (error) {
          logger.debug('nvidia-nim: could not announce the updated key pool', error)
        }
      },
    })
    : undefined

  ctx.effect(() => () => {
    manager?.dispose()
    scheduler.dispose()
    release()
  })

  if (manager !== undefined) {
    void manager.start().catch(error => {
      logger.warn('nvidia-nim: key manager failed to start; the settings tab will report it unavailable', error)
    })
  }

  // Warm the model catalog in the background so the first model-selector fetch
  // (which blocks on `listModels`) is answered from cache instead of waiting for
  // the endpoint. One request against the same per-key budget; a failure only
  // leaves the configured models visible.
  if (settings.discoverModels && pool.keys.length > 0) {
    void Promise.resolve(adapter.listModels(settings.provider)).catch(error => {
      logger.debug('nvidia-nim: background model discovery failed', error)
    })
  }

  logger.info(
    `nvidia-nim: route "${settings.provider}" ready (${settings.displayName}); `
    + `${pool.keys.length} key${pool.keys.length === 1 ? '' : 's'}, `
    + `${settings.requestsPerSecond}/s and ${settings.requestsPerMinute}/min per key, `
    + `${settings.errorDelayMs}ms retry delay`,
  )
}