import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRequestBody, projectMessages, textOf } from '../lib/wire.js'
import { normalizeConfig } from '../lib/config.js'

const settings = normalizeConfig({})

/** Durable-looking messages; only fields the projector reads are present. */
const history = [
  { role: 'system', content: [{ type: 'text', text: 'You are helpful.' }], id: 's1', source: { kind: 'system-prompt' } },
  { role: 'user', content: [{ type: 'text', text: 'Hi' }], id: 'u1', source: { kind: 'user' } },
  {
    role: 'assistant',
    content: [{ type: 'reasoning', text: 'secret plan' }, { type: 'text', text: 'Let me check.' }],
    id: 'a1',
    source: { kind: 'model', provider: 'nvidia-nim', model: 'meta/llama' },
  },
  { role: 'tool', content: [{ type: 'text', text: '{"ok":true}' }], toolCallId: 'call_1', id: 't1', source: { kind: 'tool', callId: 'call_1' } },
]

test('system, user, assistant, and tool roles map onto the OpenAI vocabulary', () => {
  assert.deepEqual(projectMessages({ messages: history }), [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Let me check.' },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
  ])
})

test('a later system message becomes a system reminder, developer messages are dropped', () => {
  const messages = projectMessages({
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'first' }] },
      { role: 'system', content: [{ type: 'text', text: 'changed' }] },
      { role: 'developer', content: [{ type: 'tool-addition', toolName: 'x' }] },
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
    ],
  })
  assert.deepEqual(messages, [
    { role: 'system', content: 'first' },
    { role: 'user', content: '<system-reminder>\nchanged\n</system-reminder>' },
    { role: 'user', content: 'go' },
  ])
})

test('assistant tool calls are replayed with their id and validated arguments', () => {
  const messages = projectMessages({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 'call_9', name: 'read', arguments: '{"path":"a.txt"}' },
          { type: 'tool-call', id: 'call_10', name: 'read', arguments: '{"path":' },
        ],
      },
    ],
  })
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content, null)
  assert.deepEqual(messages[0].tool_calls, [
    { id: 'call_9', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } },
    { id: 'call_10', type: 'function', function: { name: 'read', arguments: '{}' } },
  ])
})

test('an assistant message with only reasoning is not sent back', () => {
  assert.deepEqual(projectMessages({ messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'x' }] }] }), [])
})

test('request body carries tools, sampling, the output cap, and usage streaming', () => {
  const body = buildRequestBody({
    model: 'meta/llama-3.3-70b-instruct',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }],
    temperature: 0.2,
    maxTokens: 512,
    stop: ['END', ''],
  }, settings)
  assert.equal(body.model, 'meta/llama-3.3-70b-instruct')
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(body.temperature, 0.2)
  assert.equal(body.max_tokens, 512)
  assert.deepEqual(body.stop, ['END'])
  assert.equal(body.tool_choice, 'auto')
  assert.deepEqual(body.tools, [{
    type: 'function',
    function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } },
  }])
})

test('the configured default output cap and cap field drive the body', () => {
  const custom = normalizeConfig({ defaultMaxTokens: 2048, maxTokensField: 'max_completion_tokens', includeUsage: false })
  const body = buildRequestBody({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, custom)
  assert.equal(body.max_completion_tokens, 2048)
  assert.equal(body.max_tokens, undefined)
  assert.equal(body.stream_options, undefined)
})

test('textOf joins visible blocks and keeps a placeholder for unexpected media', () => {
  assert.equal(textOf([
    { type: 'text', text: 'a' },
    { type: 'image', attachment: { id: 'img' } },
    { type: 'text', text: 'b' },
  ]), 'a\n[image omitted]\nb')
  assert.equal(textOf(undefined), '')
})