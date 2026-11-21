import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseJsonStream, parseSse, STREAM_DONE } from '../lib/sse.js'
import { collect } from './helpers.mjs'

/** Feed strings as an async iterable, the way a socket delivers bytes. */
async function* feed(parts) {
  for (const part of parts) yield part
}

test('frames split across chunks, CRLF endings, and comment heartbeats', async () => {
  const frames = await collect(parseSse(feed([
    ': keep-alive\r\n\r\n',
    'data: {"a":1}\r\n\r\n',
    'data: {"b"',
    ':2}\r\n\r\n',
  ])))
  assert.deepEqual(frames.map(frame => frame.data), ['{"a":1}', '{"b":2}'])
})

test('multi-line data joins with a newline and the final frame needs no blank line', async () => {
  const frames = await collect(parseSse(feed([
    'event: ping\ndata: one\ndata: two\n\n',
    'data: {"tail":true}',
  ])))
  assert.equal(frames[0].event, 'ping')
  assert.equal(frames[0].data, 'one\ntwo')
  assert.equal(frames[1].data, '{"tail":true}')
})

test('the [DONE] sentinel terminates JSON decoding', async () => {
  const events = await collect(parseJsonStream(feed([
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    'data: [DONE]\n\n',
    'data: {"ignored":true}\n\n',
  ])))
  assert.equal(events.length, 2)
  assert.equal(events[0].choices[0].delta.content, 'hi')
  assert.equal(events[1], STREAM_DONE)
})

test('a non-JSON frame fails with a provider-neutral code', async () => {
  await assert.rejects(
    collect(parseJsonStream(feed(['data: not-json\n\n']))),
    error => {
      assert.equal(error.code, 'MALFORMED_RESPONSE')
      return true
    },
  )
})