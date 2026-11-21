import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAdapterClass } from '../lib/adapter.js'
import { KeyScheduler } from '../lib/rate-limit.js'
import { normalizeConfig } from '../lib/config.js'
import { assembleBlocks, assertChunkProtocol, collect } from './helpers.mjs'

/** Minimal stand-in for the harness base class. */
class BaseAdapter {}

const quietLog = { debug() {}, warn() {}, error() {} }
const keyOne = { value: 'nvapi-key-one', label: 'env:ONE' }
const keyTwo = { value: 'nvapi-key-two', label: 'env:TWO' }

/**
 * @param {Partial<import('../lib/config.js').NvidiaNimSettings>} [overrides]
 * @param {{ keys?: readonly { value: string, label: string }[], fetchImpl: typeof fetch }} options
 */
function makeAdapter(overrides, options) {
  const settings = normalizeConfig({ discoverModels: false, ...overrides })
  const scheduler = new KeyScheduler({
    keys: options.keys ?? [keyOne],
    requestsPerSecond: 1000,
    requestsPerMinute: 1000,
    safetyMs: 0,
  })
  const Adapter = createAdapterClass({
    LlmAdapter: BaseAdapter,
    settings,
    keys: options.keys ?? [keyOne],
    scheduler,
    log: quietLog,
    fetchImpl: options.fetchImpl,
    headers: () => ({ 'user-agent': 'test-agent' }),
    now: () => 0,
  })
  return { adapter: new Adapter(), scheduler }
}

/** SSE text for one text answer. */
const ANSWER = [
  'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
  'data: [DONE]\n\n',
].join('')

const REQUEST = {
  provider: 'nvidia-nim',
  model: 'meta/llama-3.3-70b-instruct',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
}

test('a transient HTTP failure is retried after the configured delay', async () => {
  let attempts = 0
  const fetchImpl = async () => {
    attempts += 1
    if (attempts === 1) return new Response('{"error":{"message":"upstream busy"}}', { status: 503 })
    return new Response(ANSWER, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const { adapter } = makeAdapter({ errorDelayMs: 1, maxAttempts: 3, idleTimeoutMs: 0, requestTimeoutMs: 0 }, { fetchImpl })
  const chunks = await collect(adapter.stream(REQUEST))
  assert.equal(attempts, 2)
  assertChunkProtocol(chunks)
  assert.equal(assembleBlocks(chunks)[0].text, 'Hello')
})

test('a failure after content was emitted is not retried', async () => {
  let attempts = 0
  const fetchImpl = async () => {
    attempts += 1
    const body = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const { adapter } = makeAdapter({ errorDelayMs: 1, maxAttempts: 3, idleTimeoutMs: 0, requestTimeoutMs: 0 }, { fetchImpl })
  await assert.rejects(collect(adapter.stream(REQUEST)), error => {
    assert.equal(error.code, 'STREAM_CLOSED')
    return true
  })
  assert.equal(attempts, 1)
})

test('a rate-limited key hands the retry to the next key', async () => {
  const seen = []
  let attempts = 0
  const fetchImpl = async (url, init) => {
    seen.push(init.headers.authorization)
    attempts += 1
    if (attempts === 1) {
      return new Response('{"error":{"message":"too many requests"}}', {
        status: 429,
        headers: { 'retry-after': '1' },
      })
    }
    return new Response(ANSWER, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const { adapter, scheduler } = makeAdapter(
    { errorDelayMs: 1, maxAttempts: 3, idleTimeoutMs: 0, requestTimeoutMs: 0 },
    { keys: [keyOne, keyTwo], fetchImpl },
  )
  const chunks = await collect(adapter.stream(REQUEST))
  assert.equal(attempts, 2)
  assert.deepEqual(seen, ['Bearer nvapi-key-one', 'Bearer nvapi-key-two'])
  assertChunkProtocol(chunks)
  assert.equal(scheduler.stats()[0].cooldownMs > 0, true, 'the rate-limited key stays in cooldown')
})

test('a rejected key is not tried again and the other key serves', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push(init.headers.authorization)
    if (seen.length === 1) return new Response('{"error":{"message":"invalid key"}}', { status: 401 })
    return new Response(ANSWER, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const { adapter, scheduler } = makeAdapter(
    { errorDelayMs: 1, maxAttempts: 3, idleTimeoutMs: 0, requestTimeoutMs: 0 },
    { keys: [keyOne, keyTwo], fetchImpl },
  )
  await collect(adapter.stream(REQUEST))
  assert.deepEqual(seen, ['Bearer nvapi-key-one', 'Bearer nvapi-key-two'])
  assert.equal(scheduler.stats()[0].disabled, true)
})

test('no configured key fails with MISSING_CREDENTIAL before any request', async () => {
  let called = 0
  const fetchImpl = async () => {
    called += 1
    return new Response(ANSWER, { status: 200 })
  }
  const settings = normalizeConfig({ discoverModels: false })
  const scheduler = new KeyScheduler({ keys: [] })
  const Adapter = createAdapterClass({
    LlmAdapter: BaseAdapter, settings, keys: [], scheduler, log: quietLog, fetchImpl,
  })
  await assert.rejects(collect(new Adapter().stream(REQUEST)), error => {
    assert.equal(error.code, 'MISSING_CREDENTIAL')
    return true
  })
  assert.equal(called, 0)
})

test('models combine the configured list with discovered ids, configured first', async () => {
  const fetchImpl = async url => {
    assert.match(String(url), /\/models$/)
    return new Response(JSON.stringify({ data: [{ id: 'zeta/model' }, { id: 'alpha/model' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const { adapter } = makeAdapter(
    { discoverModels: true, models: [{ id: 'configured/model', name: 'Configured', contextWindow: 4096, maxTokens: 256 }] },
    { fetchImpl },
  )
  const models = await adapter.listModels('nvidia-nim')
  assert.deepEqual(models.map(model => model.id), ['configured/model', 'alpha/model', 'zeta/model'])
  assert.equal(models[0].name, 'Configured')
  assert.deepEqual(models[0].inputModalities, ['text'])

  const resolved = await adapter.resolveModel('nvidia-nim', 'configured/model')
  assert.equal(resolved.context.contextWindow, 4096)
  assert.equal(resolved.defaultMaxTokens, 256)
  assert.equal(resolved.provider, 'nvidia-nim')
})

test('prepareCall binds the exact model metadata to the stream', async () => {
  const fetchImpl = async () => new Response(ANSWER, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const { adapter } = makeAdapter({ discoverModels: false, defaultContextWindow: 8192, defaultMaxTokens: 1024 }, { fetchImpl })
  const prepared = await adapter.prepareCall('nvidia-nim', 'meta/llama')
  assert.equal(prepared.model.context.contextWindow, 8192)
  assert.equal(prepared.model.defaultMaxTokens, 1024)
  const chunks = await collect(prepared.stream(REQUEST))
  assertChunkProtocol(chunks)
})

test('a caller abort surfaces as ABORTED without a retry', async () => {
  const controller = new AbortController()
  let attempts = 0
  const fetchImpl = async (url, init) => {
    attempts += 1
    controller.abort()
    throw init.signal.reason ?? new Error('aborted')
  }
  const { adapter } = makeAdapter({ errorDelayMs: 1, maxAttempts: 3, idleTimeoutMs: 0, requestTimeoutMs: 0 }, { fetchImpl })
  await assert.rejects(collect(adapter.stream({ ...REQUEST, signal: controller.signal })), error => {
    assert.equal(error.code, 'ABORTED')
    return true
  })
  assert.equal(attempts, 1)
})