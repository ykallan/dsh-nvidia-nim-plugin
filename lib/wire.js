/**
 * Harness conversation → OpenAI Chat Completions request body.
 *
 * Projection rules:
 * - a leading system message becomes `role: "system"`; a later one becomes a
 *   user-role `<system-reminder>` because this route does not advertise native
 *   mid-conversation system updates,
 * - developer messages (tool additions/removals) are dropped: this route
 *   declares its complete tool list on every request,
 * - assistant history keeps visible text and tool calls; reasoning is never
 *   replayed,
 * - reasoning-effort identifiers are not sent: NVIDIA NIM gateways spell the
 *   thinking switch differently per model family, so the model's own default
 *   applies.
 *
 * The runtime already replaced file blocks with handle text and images with
 * per-image placeholders for a text-only model; the fallbacks below only cover
 * a hand-built request that skipped that projection.
 */

import { FAILURE_CODES, NimError } from './errors.js'

/**
 * Join the visible text of one content array.
 * @param {readonly Record<string, unknown>[]} content
 * @returns {string}
 */
export function textOf(content) {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      text += (text === '' ? '' : '\n') + block.text
      continue
    }
    if (block?.type === 'image') {
      text += (text === '' ? '' : '\n') + '[image omitted]'
      continue
    }
    if (block?.type === 'file') {
      const attachment = /** @type {{ name?: unknown }} */ (block.attachment)
      const name = typeof attachment?.name === 'string' && attachment.name !== '' ? attachment.name : 'file'
      text += (text === '' ? '' : '\n') + `[attached file: ${name}]`
    }
  }
  return text
}

/**
 * Tool calls of one assistant message, with unusable argument JSON replaced so
 * a provider cannot reject the whole request because an earlier call was cut
 * off at the output cap.
 * @param {readonly Record<string, unknown>[]} content
 * @returns {{ id: string, type: 'function', function: { name: string, arguments: string } }[]}
 */
function toolCallsOf(content) {
  const calls = []
  for (const block of content) {
    if (block?.type !== 'tool-call') continue
    const id = typeof block.id === 'string' && block.id !== '' ? block.id : `call_${calls.length + 1}`
    const name = typeof block.name === 'string' ? block.name : ''
    const raw = typeof block.arguments === 'string' ? block.arguments : ''
    let args = raw
    try {
      JSON.parse(raw === '' ? '{}' : raw)
    } catch {
      args = '{}'
    }
    calls.push({ id, type: 'function', function: { name, arguments: args === '' ? '{}' : args } })
  }
  return calls
}

/**
 * One assistant-role wire message, or nothing when it would be empty.
 * @param {readonly Record<string, unknown>[]} content
 * @returns {Record<string, unknown> | undefined}
 */
function assistantMessage(content) {
  const text = textOf(content)
  const toolCalls = toolCallsOf(content)
  if (text === '' && toolCalls.length === 0) return undefined
  /** @type {Record<string, unknown>} */
  const message = { role: 'assistant', content: text === '' ? null : text }
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  return message
}

/**
 * Build the request messages.
 * @param {{ messages: readonly Record<string, unknown>[], system?: string }} options
 * @returns {Record<string, unknown>[]}
 */
export function projectMessages(options) {
  const out = []
  let systemSeen = false
  if (typeof options.system === 'string' && options.system !== '') {
    out.push({ role: 'system', content: options.system })
    systemSeen = true
  }
  for (const message of options.messages ?? []) {
    const role = message?.role
    const content = Array.isArray(message?.content) ? message.content : []
    if (role === 'system') {
      const text = textOf(content)
      if (text === '') continue
      if (systemSeen) {
        out.push({ role: 'user', content: `<system-reminder>\n${text}\n</system-reminder>` })
      } else {
        out.push({ role: 'system', content: text })
        systemSeen = true
      }
      continue
    }
    if (role === 'developer') continue
    if (role === 'user') {
      const text = textOf(content)
      if (text === '') continue
      out.push({ role: 'user', content: text })
      continue
    }
    if (role === 'assistant') {
      const message = assistantMessage(content)
      if (message !== undefined) out.push(message)
      continue
    }
    if (role === 'tool') {
      const callId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
      if (callId === '') continue
      const text = textOf(content)
      out.push({
        role: 'tool',
        tool_call_id: callId,
        content: text === '' ? '(no output)' : text,
      })
    }
  }
  return out
}

/**
 * Map harness tool schemas to OpenAI function declarations.
 * @param {readonly Record<string, unknown>[] | undefined} tools
 * @returns {Record<string, unknown>[] | undefined}
 */
function projectTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const out = []
  for (const tool of tools) {
    if (typeof tool?.name !== 'string' || tool.name === '') continue
    out.push({
      type: 'function',
      function: {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: tool.parameters !== null && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
      },
    })
  }
  return out.length === 0 ? undefined : out
}

/**
 * Build the complete request body for one model call.
 * @param {Record<string, unknown>} options - `GenerateOptions`.
 * @param {import('./config.js').NvidiaNimSettings} settings
 * @returns {Record<string, unknown>}
 */
export function buildRequestBody(options, settings) {
  const messages = projectMessages(/** @type {{ messages: readonly Record<string, unknown>[], system?: string }} */ (options))
  if (messages.length === 0) {
    throw new NimError('NVIDIA NIM request has no model-visible messages', FAILURE_CODES.INVALID_REQUEST)
  }
  /** @type {Record<string, unknown>} */
  const body = {
    model: options.model,
    messages,
    stream: true,
  }
  if (settings.includeUsage) body.stream_options = { include_usage: true }

  const tools = projectTools(/** @type {readonly Record<string, unknown>[] | undefined} */ (options.tools))
  if (tools !== undefined) {
    body.tools = tools
    body.tool_choice = 'auto'
  }
  if (typeof options.temperature === 'number' && Number.isFinite(options.temperature)) {
    body.temperature = options.temperature
  }
  const maxTokens = typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens > 0
    ? options.maxTokens
    : settings.defaultMaxTokens
  if (maxTokens > 0) body[settings.maxTokensField] = Math.trunc(maxTokens)
  if (Array.isArray(options.stop) && options.stop.length > 0) {
    body.stop = options.stop.filter(value => typeof value === 'string' && value !== '')
  }
  if (body.stop !== undefined && /** @type {unknown[]} */ (body.stop).length === 0) delete body.stop
  return body
}