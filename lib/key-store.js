/**
 * Key file storage for the NVIDIA NIM key manager.
 *
 * The file the plugin already reads (`$DSH_HOME/nvidia-nim.keys` by default) is
 * the storage: one key per line, `#` starts a comment. The manager appends and
 * removes lines atomically, keeps comments and ordering, and never leaks a key
 * value to a caller — every listing is masked and identified by a hash prefix.
 */

import { createHash } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
 * Key-file editing for the manager.
 */
export class KeyFileStore {
  /** @param {string} path */
  constructor(path) {
    this.path = path
  }

  /**
   * Current keys in file order.
   * @returns {{ id: string, value: string, label: string }[]}
   */
  entries() {
    return readKeyLines(this.path).map((entry, index) => ({
      id: keyId(entry.value),
      value: entry.value,
      label: `file:${this.path.split(/[\\/]/u).pop()}[${index + 1}]`,
    }))
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