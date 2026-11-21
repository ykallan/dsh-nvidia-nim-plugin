#!/usr/bin/env node
/**
 * Live smoke check for this plugin against the configured NVIDIA NIM endpoint.
 *
 * It prints what the endpoint serves, runs one short completion, and measures
 * how the pool paces two concurrent requests. The key is read from the
 * environment or the same key file the plugin uses; it is never printed.
 *
 *   $env:NVIDIA_NIM_API_KEY = 'nvapi-...'    # PowerShell
 *   node scripts/live-check.mjs
 *
 * Exit code 0 means every check passed.
 */

import { createAdapterClass } from '../lib/adapter.js'
import { KeyScheduler } from '../lib/rate-limit.js'
import { normalizeConfig } from '../lib/config.js'
import { resolveApiKeys } from '../lib/keys.js'

/** The harness base class is not needed outside a profile. */
class StandaloneAdapter {}

const settings = normalizeConfig({ discoverModels: true })
const pool = resolveApiKeys(settings)
if (pool.keys.length === 0) {
  console.error('No API key found. Set NVIDIA_NIM_API_KEY (or the variables in apiKeyEnvs), or create $DSH_HOME/nvidia-nim.keys.')
  for (const problem of pool.problems) console.error(`  ${problem}`)
  process.exit(2)
}
console.log(`keys: ${pool.keys.length} (${pool.keys.map(key => key.label).join(', ')})`)

const scheduler = new KeyScheduler({
  keys: pool.keys,
  requestsPerSecond: settings.requestsPerSecond,
  requestsPerMinute: settings.requestsPerMinute,
})

/** Every provider request leaves through this wrapper, so dispatch times are exact. */
const dispatch = []
const Adapter = createAdapterClass({
  LlmAdapter: StandaloneAdapter,
  settings,
  keys: pool.keys,
  scheduler,
  log: {
    debug() {},
    warn: message => console.warn(`warn: ${message}`),
    error: message => console.error(`error: ${message}`),
  },
  fetchImpl: (url, init) => {
    dispatch.push(Date.now())
    return fetch(url, init)
  },
})
const adapter = new Adapter()

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

/** Run one request to its finish chunk. */
async function once(model, prompt, maxTokens) {
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: settings.provider,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens,
  })) chunks.push(chunk)
  return chunks
}

const models = await adapter.listModels(settings.provider)
check('model catalog is not empty', models.length > 0, `${models.length} models`)
const model = process.env.NIM_MODEL ?? models.find(entry => /flash|instruct/i.test(entry.id))?.id ?? models[0]?.id
check('a model can be chosen', typeof model === 'string', model)
if (model === undefined) {
  scheduler.dispose()
  process.exit(1)
}

const begin = Date.now()
const chunks = await once(model, 'Reply with exactly: pong', 64)
const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block.type)
check('the stream ended with a finish chunk', chunks.at(-1)?.type === 'finish', JSON.stringify(chunks.at(-1)?.reason))
check('the response carried content', blocks.length > 0, blocks.join(', '))
check('the response reported usage', chunks.some(chunk => chunk.type === 'usage'))
console.log(`first completion: ${Date.now() - begin}ms`)

// Two concurrent requests: with one key they must start about a second apart,
// with several keys they may start together.
const before = dispatch.length
const burstStart = Date.now()
await Promise.all([once(model, 'say one', 8), once(model, 'say two', 8)])
const starts = dispatch.slice(before).map(at => at - burstStart)
if (pool.keys.length === 1) {
  check('two starts on one key are paced', starts.length === 2 && starts[1] - starts[0] >= 1000, `${starts.join(' / ')}ms`)
} else {
  check('two keys start together', starts.length === 2 && starts[1] - starts[0] < 1000, `${starts.join(' / ')}ms`)
}

scheduler.dispose()
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)