/**
 * Server-sent-events framing for OpenAI-compatible endpoints.
 *
 * The harness ships `eventsource-parser`, but this plugin stays free of runtime
 * dependencies, so the framing rules it needs are implemented here: blank-line
 * separated frames, `field: value` lines, `:` comments (used as heartbeats),
 * multi-line `data`, CRLF or LF endings, and a final frame without a trailing
 * blank line. Nothing is decoded while a frame is incomplete.
 */

import { FAILURE_CODES, NimError } from './errors.js'

/**
 * Normalize line endings inside one decoder batch. A lone trailing CR is held
 * back, because the matching LF may arrive in the next chunk.
 * @param {string} text
 * @returns {string}
 */
function normalizeNewlines(text) {
  return text.replace(/\r\n?/gu, '\n')
}

/**
 * @typedef {{ event?: string, data: string, id?: string }} SseFrame
 */

/**
 * Parse an SSE body into frames.
 * @param {AsyncIterable<Uint8Array | string> | ReadableStream<Uint8Array>} body
 * @param {{ onActivity?: () => void }} [options]
 * @returns {AsyncGenerator<SseFrame>}
 */
export async function* parseSse(body, options = {}) {
  const decoder = new TextDecoder()
  const onActivity = options.onActivity ?? (() => {})
  let buffer = ''

  /** @type {Iterator<SseFrame, void, unknown>} */
  for await (const chunk of body) {
    onActivity()
    buffer += normalizeNewlines(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }))

    for (;;) {
      const end = buffer.indexOf('\n\n')
      if (end === -1) break
      const raw = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const frame = parseFrame(raw, onActivity)
      if (frame !== undefined) yield frame
    }
  }

  buffer += normalizeNewlines(decoder.decode())
  if (buffer.trim() !== '') {
    const frame = parseFrame(buffer, onActivity)
    if (frame !== undefined) yield frame
  }
}

/**
 * Decode one complete frame.
 * @param {string} raw
 * @param {() => void} onActivity
 * @returns {SseFrame | undefined}
 */
function parseFrame(raw, onActivity) {
  /** @type {SseFrame} */
  const frame = { data: '' }
  const data = []
  let hasData = false
  for (const line of raw.split('\n')) {
    if (line === '') continue
    if (line.startsWith(':')) {
      onActivity()
      continue
    }
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    // A single leading space after the colon is part of the framing, not data.
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /u, '')
    if (field === 'data') {
      data.push(value)
      hasData = true
    } else if (field === 'event') {
      frame.event = value
    } else if (field === 'id') {
      frame.id = value
    }
    // `retry` and unknown fields carry nothing this client needs.
  }
  if (!hasData) return undefined
  frame.data = data.join('\n')
  return frame
}

/**
 * Decode JSON payloads from an SSE body, ending with {@link STREAM_DONE} when
 * the endpoint sends the `[DONE]` sentinel.
 * @param {AsyncIterable<Uint8Array | string> | ReadableStream<Uint8Array>} body
 * @param {{ onActivity?: () => void }} [options]
 * @returns {AsyncGenerator<Record<string, unknown> | typeof STREAM_DONE>}
 */
export async function* parseJsonStream(body, options = {}) {
  for await (const frame of parseSse(body, options)) {
    if (frame.data === '[DONE]') {
      yield STREAM_DONE
      return
    }
    let parsed
    try {
      parsed = JSON.parse(frame.data)
    } catch {
      throw new NimError(
        `NVIDIA NIM sent an SSE frame that is not JSON: ${frame.data.slice(0, 200)}`,
        FAILURE_CODES.MALFORMED_RESPONSE,
      )
    }
    if (parsed !== null && typeof parsed === 'object') yield parsed
  }
}

/** Terminal sentinel yielded for the `[DONE]` marker. */
export const STREAM_DONE = Symbol('nvidia-nim.sse.done')