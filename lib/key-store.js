/**
 * Key file storage for the NVIDIA NIM key manager.
 *
 * The file the plugin already reads (`$DSH_HOME/nvidia-nim.keys` by default) is
 * the storage: one key per line, `#` starts a comment. The manager appends and
 * removes lines atomically, keeps comments and ordering, and never leaks a key
 * value to a caller — every listing is masked and identified by a hash prefix.
 *
 * Per-key metadata the file itself cannot express (a user label, a paused flag,
 * a pinned flag) lives in a sidecar JSON next to the key file, keyed by the same
 * hash id. The sidecar holds no key material, so it is safe to read and rewrite;
 * a key that is removed from the file simply loses its metadata on the next
 * read.
 */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

/** Directory created with the key file when the profile has no `.dsh` yet. */
const FILE_MODE = 0o600

/**
 * Stable identifier for one key value: a short hash prefix. Two listings of the
 * same key produce the same id, and the id reveals nothing usable about it.
 * @param {string} value
 * @returns {string}
 */
export function keyId(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Masked display form: enough to tell two keys apart in a list.
 * @param {string} value
 * @returns {string}
 */
export function maskKey(value) {
  if (value.length <= 12) return `${value.slice(0, 2)}…${value.slice(-2)}`
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

/**
 * Whether a value can be sent in an Authorization header.
 * @param {string} value
 * @returns {boolean}
 */
export function isUsableKey(value) {
  return /^[\x21-\x7e]+$/u.test(value)
}

/**
 * One stored key line.
 * @typedef {{ line: number, value: string }} KeyLine
 */

/**
 * Read the key lines of one file, skipping comments and blanks.
 * @param {string} path
 * @returns {KeyLine[]}
 */
export function readKeyLines(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code
    if (code === 'ENOENT') return []
    throw error
  }
  /** @type {KeyLine[]} */
  const lines = []
  for (const [index, raw] of text.replace(/^\uFEFF/u, '').split(/\r?\n/u).entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    lines.push({ line: index + 1, value: line })
  }
  return lines
}

/**
 * Sidecar path for one key file: `nvidia-nim.keys` → `nvidia-nim.keys.meta.json`.
 * @param {string} keyFilePath
 * @returns {string}
 */
export function metaPathFor(keyFilePath) {
  return `${keyFilePath}.meta.json`
}

/**
 * Per-key metadata the key file cannot hold.
 * @typedef {{ label?: string, paused?: boolean, pinned?: boolean }} KeyMeta
 */

/**
 * Read the sidecar metadata map (id → meta). A missing or malformed sidecar
 * reads as an empty map: metadata is a convenience, never a reason to fail.
 * @param {string} keyFilePath
 * @returns {Record<string, KeyMeta>}
 */
export function readKeyMeta(keyFilePath) {
  let text
  try {
    text = readFileSync(metaPathFor(keyFilePath), 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    /** @type {Record<string, KeyMeta>} */
    const out = {}
    for (const [id, value] of Object.entries(parsed)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const record = /** @type {Record<string, unknown>} */ (value)
      /** @type {KeyMeta} */
      const meta = {}
      if (typeof record.label === 'string' && record.label.trim() !== '') meta.label = record.label.trim()
      if (record.paused === true) meta.paused = true
      if (record.pinned === true) meta.pinned = true
      if (Object.keys(meta).length > 0) out[id] = meta
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Write the sidecar metadata map atomically, owner-only.
 * @param {string} keyFilePath
 * @param {Record<string, KeyMeta>} meta
 */
export function writeKeyMeta(keyFilePath, meta) {
  const path = metaPathFor(keyFilePath)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf8', mode: FILE_MODE })
  try {
    chmodSync(temporary, FILE_MODE)
  } catch {
    // A filesystem without POSIX modes keeps the process umask; not fatal.
  }
  try {
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * Key-file editing for the manager.
 */
export class KeyFileStore {
  /** @param {string} path */
  constructor(path) {
    this.path = path
  }

  /**
   * Current keys in file order, with their sidecar metadata merged in.
   * @returns {{ id: string, value: string, label: string, userLabel?: string, paused: boolean, pinned: boolean }[]}
   */
  entries() {
    const meta = readKeyMeta(this.path)
    return readKeyLines(this.path).map((entry, index) => {
      const id = keyId(entry.value)
      const extra = meta[id] ?? {}
      return {
        id,
        value: entry.value,
        label: extra.label ?? `file:${this.path.split(/[\\/]/u).pop()}[${index + 1}]`,
        ...extra.label === undefined ? {} : { userLabel: extra.label },
        paused: extra.paused === true,
        pinned: extra.pinned === true,
      }
    })
  }

  /**
   * Append every non-empty line that is not already stored.
   * @param {string} text - pasted batch, one key per line.
   * @returns {{ added: { id: string, masked: string }[], duplicates: number, invalid: number[] }}
   */
  add(text) {
    const existing = new Set(this.entries().map(entry => entry.value))
    /** @type {string[]} */
    const fresh = []
    let duplicates = 0
    /** @type {number[]} */
    const invalid = []
    const lines = text.split(/\r?\n/u)
    for (const [index, raw] of lines.entries()) {
      const line = raw.trim()
      if (line === '') continue
      const value = line.replace(/^(['"])(.*)\1$/u, '$2').trim()
      if (value === '') continue
      if (!isUsableKey(value)) {
        invalid.push(index + 1)
        continue
      }
      if (existing.has(value)) {
        duplicates += 1
        continue
      }
      existing.add(value)
      fresh.push(value)
    }
    if (fresh.length > 0) this.#append(fresh)
    return {
      added: fresh.map(value => ({ id: keyId(value), masked: maskKey(value) })),
      duplicates,
      invalid,
    }
  }

  /**
   * Remove the key with one id.
   * @param {string} id
   * @returns {boolean} whether a line was removed
   */
  remove(id) {
    let text
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return false
      throw error
    }
    const kept = []
    let removed = false
    for (const raw of text.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#')) {
        kept.push(raw)
        continue
      }
      if (!removed && keyId(line) === id) {
        removed = true
        continue
      }
      kept.push(raw)
    }
    if (!removed) return false
    // Drop trailing blank lines left by a removed last entry.
    while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
    this.#write(`${kept.join('\n')}\n`)
    // The metadata of a removed key is dead weight; drop it.
    const meta = readKeyMeta(this.path)
    if (id in meta) {
      delete meta[id]
      writeKeyMeta(this.path, meta)
    }
    return true
  }

  /**
   * Update one key's sidecar metadata. Returns false when the id is unknown.
   * @param {string} id
   * @param {KeyMeta} patch
   * @returns {boolean}
   */
  setMeta(id, patch) {
    if (!this.entries().some(entry => entry.id === id)) return false
    const meta = readKeyMeta(this.path)
    const current = meta[id] ?? {}
    /** @type {KeyMeta} */
    const next = { ...current }
    if (patch.label !== undefined) {
      const label = patch.label.trim()
      if (label === '') delete next.label
      else next.label = label
    }
    if (patch.paused !== undefined) {
      if (patch.paused) next.paused = true
      else delete next.paused
    }
    if (patch.pinned !== undefined) {
      if (patch.pinned) next.pinned = true
      else delete next.pinned
    }
    if (Object.keys(next).length === 0) delete meta[id]
    else meta[id] = next
    writeKeyMeta(this.path, meta)
    return true
  }

  /**
   * Append lines, creating the file (and its directory) when needed.
   * @param {string[]} values
   */
  #append(values) {
    let text = ''
    try {
      text = readFileSync(this.path, 'utf8').replace(/^\uFEFF/u, '')
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
      text = '# NVIDIA NIM API keys for dsh-nvidia-nim (one per line; # starts a comment)\n'
    }
    const body = text === '' || text.endsWith('\n') ? text : `${text}\n`
    this.#write(body + values.map(value => `${value}\n`).join(''))
  }

  /**
   * Replace the file atomically and keep it owner-only.
   * @param {string} content
   */
  #write(content) {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, content, { encoding: 'utf8', mode: FILE_MODE })
    try {
      chmodSync(temporary, FILE_MODE)
    } catch {
      // A filesystem without POSIX modes keeps the process umask; not fatal.
    }
    try {
      renameSync(temporary, this.path)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }
}

/**
 * Whether the file exists and can be appended to, without changing it.
 * @param {string} path
 * @returns {{ writable: boolean, reason?: string }}
 */
export function keyFileWritable(path) {
  try {
    const stat = statSync(path, { throwIfNoEntry: false })
    if (stat === undefined) return { writable: true }
    if (stat.isDirectory()) return { writable: false, reason: 'the key path is a directory' }
    const fd = openSync(path, 'a')
    closeSync(fd)
    return { writable: true }
  } catch (error) {
    return { writable: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
