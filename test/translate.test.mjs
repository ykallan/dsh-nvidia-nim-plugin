import assert from 'node:assert/strict'
import { test } from 'node:test'
import { translateCompletions } from '../lib/translate.js'
import { STREAM_DONE } from '../lib/sse.js'
import { assembleBlocks, assertChunkProtocol, collect } from './helpers.mjs'

/** @param {any[]} events */
async function translate(events) {
  return collect(translateCompletions((async function* () { yield* events })(), { model: 'test/model' }))
}

test('reasoning, text, and tool calls become ordered blocks with one usage and one finish', async () => {
  const chunks = await translate([
    { choices: [{ delta: { reasoning_content: 'Let me think.' } }] },
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"SF"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    STREAM_DONE,
  ])
  assertChunkProtocol(chunks)
  const blocks = assembleBlocks(chunks)
  assert.deepEqual(blocks.map(block => block.type), ['reasoning', 'text', 'tool-call'])
  assert.equal(blocks[0].text, 'Let me think.')
  assert.equal(blocks[1].text, 'Hello')
  assert.equal(blocks[2].name, 'get_weather')
  assert.equal(blocks[2].arguments, '{"city":"SF"}')
  assert.equal(blocks[2].id, 'call_1')
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('interleaved tool calls keep their own block and provider index', async () => {
  const chunks = await translate([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'one', arguments: '{}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'two', arguments: '{}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    STREAM_DONE,
  ])
  assertChunkProtocol(chunks)
  const blocks = assembleBlocks(chunks)
  assert.deepEqual(blocks.map(block => block.name), ['one', 'two'])
  assert.deepEqual(blocks.map(block => block.id), ['a', 'b'])
})

test('cached prompt tokens are reported separately from fresh input', async () => {
  const chunks = await translate([
    { choices: [{ delta: { content: 'x' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 3 } } },
    STREAM_DONE,
  ])
  const usage = chunks.find(chunk => chunk.type === 'usage').usage
  assert.deepEqual(usage, { inputTokens: 60, outputTokens: 7, totalTokens: 107, cacheReadTokens: 40, reasoningTokens: 3 })
})

test('an empty completion fails with EMPTY_RESPONSE', async () => {
  await assert.rejects(translate([{ choices: [{ delta: {}, finish_reason: 'stop' }] }, STREAM_DONE]), error => {
    assert.equal(error.code, 'EMPTY_RESPONSE')
    return true
  })
})

test('a stream that ends without a completion marker fails with STREAM_CLOSED', async () => {
  await assert.rejects(translate([{ choices: [{ delta: { content: 'partial' } }] }]), error => {
    assert.equal(error.code, 'STREAM_CLOSED')
    return true
  })
})

test('an in-band error object becomes a server failure', async () => {
  await assert.rejects(translate([{ error: { message: 'upstream exploded' } }]), error => {
    assert.equal(error.code, 'SERVER')
    assert.match(error.message, /upstream exploded/)
    return true
  })
})

test('invalid tool arguments fail unless the output cap truncated them', async () => {
  await assert.rejects(
    translate([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{"a":' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      STREAM_DONE,
    ]),
    error => {
      assert.equal(error.code, 'MALFORMED_RESPONSE')
      return true
    },
  )
  const truncated = await translate([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{"a":' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
    STREAM_DONE,
  ])
  assert.deepEqual(truncated.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
})

test('a content filter rejection is reported as CONTENT_REFUSED', async () => {
  await assert.rejects(
    translate([{ choices: [{ delta: {}, finish_reason: 'content_filter' }] }, STREAM_DONE]),
    error => {
      assert.equal(error.code, 'CONTENT_REFUSED')
      return true
    },
  )
})

test('a model without a finish reason settles as a normal stop', async () => {
  const chunks = await translate([{ choices: [{ delta: { content: 'done' } }] }, STREAM_DONE])
  assertChunkProtocol(chunks)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})