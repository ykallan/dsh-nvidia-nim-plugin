/** Shared assertions for stream-protocol tests. */

/**
 * Drain an async iterable.
 * @param {AsyncIterable<any>} iterable
 * @returns {Promise<any[]>}
 */
export async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

/**
 * Assert the harness `StreamChunk` ordering contract: blocks are announced
 * once, deltas only address open blocks, every block is closed, and the stream
 * ends with exactly one usage chunk followed by one finish chunk.
 * @param {any[]} chunks
 */
export function assertChunkProtocol(chunks) {
  const open = new Map()
  const seen = new Set()
  let sawFinish = false
  let usageCount = 0
  for (const [position, chunk] of chunks.entries()) {
    if (sawFinish) throw new Error(`chunk ${position} (${chunk.type}) arrived after finish`)
    switch (chunk.type) {
      case 'block-start': {
        if (seen.has(chunk.index)) throw new Error(`block ${chunk.index} was announced twice`)
        seen.add(chunk.index)
        open.set(chunk.index, chunk.blockType)
        break
      }
      case 'text-delta':
      case 'reasoning-delta':
      case 'tool-call-delta': {
        if (!open.has(chunk.index)) throw new Error(`${chunk.type} for a block that is not open: ${chunk.index}`)
        break
      }
      case 'block-end': {
        if (!open.has(chunk.index)) throw new Error(`block-end for a closed or unknown block: ${chunk.index}`)
        open.delete(chunk.index)
        if (chunk.block === undefined) throw new Error(`block-end without a block at index ${chunk.index}`)
        break
      }
      case 'usage': {
        usageCount += 1
        break
      }
      case 'finish': {
        sawFinish = true
        if (usageCount !== 1) throw new Error(`finish after ${usageCount} usage chunks; expected exactly one`)
        break
      }
      default:
        throw new Error(`unknown chunk type ${String(chunk.type)}`)
    }
  }
  if (!sawFinish) throw new Error('stream ended without a finish chunk')
  if (open.size > 0) throw new Error(`unclosed blocks: ${[...open.keys()].join(', ')}`)
}

/**
 * Rebuild the assistant blocks the way the harness assembler does, for cheap
 * assertions on translated output.
 * @param {any[]} chunks
 */
export function assembleBlocks(chunks) {
  const blocks = new Map()
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') blocks.set(chunk.index, { type: chunk.blockType, text: '', arguments: '' })
    else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') blocks.get(chunk.index).text += chunk.text
    else if (chunk.type === 'tool-call-delta') {
      const block = blocks.get(chunk.index)
      block.id = chunk.id
      block.name = chunk.name ?? block.name
      block.arguments += chunk.argumentsDelta
    } else if (chunk.type === 'block-end') blocks.set(chunk.index, { ...chunk.block })
  }
  return [...blocks.values()]
}