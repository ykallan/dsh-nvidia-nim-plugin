/**
 * OpenAI Chat Completions stream events → harness `StreamChunk` protocol.
 *
 * The harness protocol is ordered blocks: `block-start`, deltas carrying the
 * block index, then `block-end` with the assembled block, followed by one
 * `usage` chunk and one terminal `finish` chunk. OpenAI deltas arrive in one
 * flat sequence, so this translator allocates a harness index per block as the
 * first delta of that block appears:
 *
 * - `reasoning_content` / `reasoning` / `thinking` deltas become one reasoning
 *   block (the model families NVIDIA serves spell it three ways),
 * - `content` deltas become one text block,
 * - each `tool_calls[i]` becomes its own tool-call block, addressed by its
 *   provider index so interleaved argument fragments still land in order.
 *
 * A text or reasoning block is closed and ended as soon as a different kind
 * starts; tool-call blocks stay open until the response settles, because their
 * argument fragments may be interrupted by another call's fragments.
 */

import { FAILURE_CODES, NimError, httpError } from './errors.js'
import { STREAM_DONE } from './sse.js'

/**
 * Read a string field, treating anything else as absent.
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Content may arrive as a plain string or as an array of parts.
 * @param {unknown} value
 * @returns {string}
 */
function contentText(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  let out = ''
  for (const part of value) {
    if (typeof part === 'string') out += part
    else if (part !== null && typeof part === 'object' && typeof part.text === 'string') out += part.text
  }
  return out
}

/**
 * Merge OpenAI usage counters into the harness vocabulary. Counts are
 * disjoint: cached prompt tokens are reported separately.
 * @param {{ inputTokens: number, outputTokens: number, totalTokens?: number, cacheReadTokens?: number, reasoningTokens?: number }} usage
 * @param {unknown} raw
 */
function mergeUsage(usage, raw) {
  if (raw === null || typeof raw !== 'object') return
  const fields = /** @type {Record<string, unknown>} */ (raw)
  const prompt = Number.isSafeInteger(fields.prompt_tokens) ? /** @type {number} */ (fields.prompt_tokens) : undefined
  const completion = Number.isSafeInteger(fields.completion_tokens) ? /** @type {number} */ (fields.completion_tokens) : undefined
  const total = Number.isSafeInteger(fields.total_tokens) ? /** @type {number} */ (fields.total_tokens) : undefined
  const details = fields.prompt_tokens_details
  const cached = details !== null && typeof details === 'object' && Number.isSafeInteger(/** @type {Record<string, unknown>} */ (details).cached_tokens)
    ? /** @type {number} */ (/** @type {Record<string, unknown>} */ (details).cached_tokens)
    : 0
  const completionDetails = fields.completion_tokens_details
  const reasoning = completionDetails !== null && typeof completionDetails === 'object'
    && Number.isSafeInteger(/** @type {Record<string, unknown>} */ (completionDetails).reasoning_tokens)
    ? /** @type {number} */ (/** @type {Record<string, unknown>} */ (completionDetails).reasoning_tokens)
    : 0
  if (prompt !== undefined) {
    usage.inputTokens = Math.max(0, prompt - cached)
    if (cached > 0) usage.cacheReadTokens = cached
  }
  if (completion !== undefined) usage.outputTokens = completion
  if (total !== undefined) usage.totalTokens = total
  if (reasoning > 0) usage.reasoningTokens = reasoning
}

/**
 * Map one provider stop reason onto the harness finish vocabulary.
 * @param {unknown} raw
 * @returns {{ kind: string } | undefined}
 */
function finishReason(raw) {
  switch (raw) {
    case 'stop':
      return { kind: 'stop' }
    case 'length':
      return { kind: 'max-tokens' }
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'content_filter':
      throw new NimError('NVIDIA NIM declined the request under its content filter', FAILURE_CODES.CONTENT_REFUSED)
    case null:
    case undefined:
    case '':
      return undefined
    default:
      // Unknown provider vocabulary is treated as a normal stop rather than a
      // failure: the content already streamed is usable.
      return { kind: 'stop' }
  }
}

/**
 * Turn one in-band error object into a failure.
 * @param {unknown} payload
 * @returns {NimError}
 */
function inBandError(payload) {
  const error = /** @type {Record<string, unknown>} */ (payload)?.error
  const message = typeof error === 'string'
    ? error
    : typeof error?.message === 'string'
      ? error.message
      : 'NVIDIA NIM reported an error inside the stream'
  const status = typeof error === 'object' && error !== null && typeof error.status === 'number' ? error.status : undefined
  if (status !== undefined) return httpError(status, JSON.stringify({ error }), undefined)
  return new NimError(`NVIDIA NIM stream error: ${message}`, FAILURE_CODES.SERVER)
}

/**
 * Translate decoded provider events into the harness stream protocol.
 * @param {AsyncIterable<Record<string, unknown> | typeof STREAM_DONE>} events
 * @param {{ model: string }} options
 * @returns {AsyncGenerator<Record<string, unknown>>}
 */
export async function* translateCompletions(events, options) {
  /** @type {{ index: number, type: string, text: string, id: string, name: string, json: string, closed: boolean }[]} */
  const blocks = []
  /** Provider tool-call index → harness block. @type {Map<number, typeof blocks[number]>} */
  const toolBlocks = new Map()
  /** @type {typeof blocks[number] | undefined} */
  let openText
  /** @type {typeof blocks[number] | undefined} */
  let openReasoning
  /** @type {Record<string, number>} */
  const usage = { inputTokens: 0, outputTokens: 0 }
  /** @type {{ kind: string } | undefined} */
  let finish
  let sawDone = false
  let generatedId = 0

  /**
   * Create one block and announce it.
   * @param {string} type
   */
  function* startBlock(type) {
    const block = { index: blocks.length, type, text: '', id: '', name: '', json: '', closed: false }
    blocks.push(block)
    yield { type: 'block-start', index: block.index, blockType: type }
    return block
  }

  /** Close one block and publish it. */
  function* endBlock(block) {
    if (block.closed) return
    block.closed = true
    if (block.type === 'text') yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
    else if (block.type === 'reasoning') yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
    else {
      const argumentsJson = block.json === '' ? '{}' : block.json
      yield {
        type: 'block-end',
        index: block.index,
        block: { type: 'tool-call', id: block.id, name: block.name, arguments: argumentsJson },
      }
    }
  }

  function* closeOpenText() {
    if (openText !== undefined) {
      yield* endBlock(openText)
      openText = undefined
    }
  }

  function* closeOpenReasoning() {
    if (openReasoning !== undefined) {
      yield* endBlock(openReasoning)
      openReasoning = undefined
    }
  }

  for await (const event of events) {
    if (event === STREAM_DONE) {
      sawDone = true
      break
    }
    const record = /** @type {Record<string, unknown>} */ (event)
    if (record.error !== undefined && record.error !== null) throw inBandError(record)
    if (record.usage !== undefined) mergeUsage(usage, record.usage)
    const choices = record.choices
    if (!Array.isArray(choices) || choices.length === 0) continue
    const choice = /** @type {Record<string, unknown>} */ (choices[0])
    const delta = /** @type {Record<string, unknown>} */ (
      choice.delta !== null && typeof choice.delta === 'object' ? choice.delta : (choice.message ?? {})
    )

    const reasoningDelta = text(delta.reasoning_content) || text(delta.reasoning) || text(delta.thinking)
    if (reasoningDelta !== '') {
      yield* closeOpenText()
      if (openReasoning === undefined) {
        const block = yield* startBlock('reasoning')
        openReasoning = block
      }
      openReasoning.text += reasoningDelta
      yield { type: 'reasoning-delta', index: openReasoning.index, text: reasoningDelta }
    }

    const textDelta = contentText(delta.content)
    if (textDelta !== '') {
      yield* closeOpenReasoning()
      if (openText === undefined) {
        const block = yield* startBlock('text')
        openText = block
      }
      openText.text += textDelta
      yield { type: 'text-delta', index: openText.index, text: textDelta }
    }

    const calls = delta.tool_calls
    if (Array.isArray(calls) && calls.length > 0) {
      yield* closeOpenText()
      yield* closeOpenReasoning()
      for (const rawCall of calls) {
        const call = /** @type {Record<string, unknown>} */ (rawCall ?? {})
        const providerIndex = Number.isSafeInteger(call.index) ? /** @type {number} */ (call.index) : 0
        const fn = /** @type {Record<string, unknown>} */ (call.function ?? {})
        const fragment = text(fn.arguments)
        let block = toolBlocks.get(providerIndex)
        if (block === undefined) {
          const created = yield* startBlock('tool-call')
          block = created
          block.id = text(call.id) || `call_nim_${++generatedId}`
          block.name = text(fn.name)
          toolBlocks.set(providerIndex, block)
          yield { type: 'tool-call-delta', index: block.index, id: block.id, name: block.name, argumentsDelta: fragment }
        } else {
          if (block.name === '') block.name = text(fn.name)
          yield { type: 'tool-call-delta', index: block.index, id: block.id, argumentsDelta: fragment }
        }
        block.json += fragment
      }
    }

    const reason = finishReason(choice.finish_reason)
    if (reason !== undefined) finish = reason
  }

  if (!sawDone && finish === undefined) {
    throw new NimError('NVIDIA NIM closed the response before its completion marker', FAILURE_CODES.STREAM_CLOSED)
  }

  // Settle every remaining block in creation order.
  for (const block of blocks) {
    if (block.closed) continue
    if (block.type === 'tool-call' && block.json === '') block.json = '{}'
    yield* endBlock(block)
  }

  const toolCallBlocks = blocks.filter(block => block.type === 'tool-call')
  finish ??= { kind: toolCallBlocks.length > 0 ? 'tool-calls' : 'stop' }
  if (finish.kind === 'tool-calls' && toolCallBlocks.length === 0) finish = { kind: 'stop' }

  // Truncated tool JSON at the output cap is kept for the shared assembler to
  // prune; any other unparsable call is a provider defect.
  if (finish.kind !== 'max-tokens') {
    for (const block of toolCallBlocks) {
      try {
        JSON.parse(block.json)
      } catch {
        throw new NimError(`NVIDIA NIM produced invalid tool arguments for ${block.name || 'a tool'}`, FAILURE_CODES.MALFORMED_RESPONSE)
      }
    }
  }

  if (blocks.length === 0 && finish.kind === 'stop') {
    yield { type: 'usage', usage }
    throw new NimError('NVIDIA NIM returned an empty response', FAILURE_CODES.EMPTY_RESPONSE)
  }

  yield { type: 'usage', usage }
  yield { type: 'finish', reason: finish }
}