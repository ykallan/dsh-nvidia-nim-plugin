/**
 * API-key discovery for the NVIDIA NIM adapter.
 *
 * Keys reach the plugin from three places, in this order: environment
 * variables, a key file, and inline configuration. Sources are de-duplicated by
 * value and labelled, so diagnostics can name which source to fix without ever
 * echoing the secret itself.
 *
 * Recommended: `NVIDIA_NIM_API_KEY`, `NVIDIA_NIM_API_KEY_2`, … or one
 * `NVIDIA_NIM_API_KEYS` holding a comma/newline separated list, or a key file
 * outside the repository.
 */

import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

/** Header-safe key characters: printable ASCII without spaces or control codes. */
const USABLE_KEY = /^[\x21-\x7e]+$/

/**
 * Split one raw value into keys: a list may be comma, semicolon, or newline
 * separated. Spaces are not separators, because a key with a space is malformed
 * and must be reported instead of silently becoming two keys.
 * @param {string} raw
 * @returns {string[]}
 */
export function splitKeys(raw) {
  return raw
    .split(/[\r\n,;]+/u)
    .map(part => part.trim().replace(/^(['"])(.*)\1$/u, '$2'))
    .filter(part => part !== '')
}

/**
 * Validate one key and describe it by source.
 * @param {string} value
 * @param {string} label
 * @param {{ keys: { value: string, label: string }[], problems: string[] }} into
 */
function addKey(value, label, into) {
  if (!USABLE_KEY.test(value)) {
    into.problems.push(`${label} is not a usable API key (expected visible ASCII without spaces); fix that source`)
    return
  }
  if (into.keys.some(existing => existing.value === value)) return
  into.keys.push({ value, label })
}

/**
 * Read one key file: one key per line, `#` starts a comment.
 * @param {string} path
 * @returns {{ keys: string[], error?: string }}
 */
export function readKeysFile(path) {
  try {
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/u, '')
    const keys = []
    for (const rawLine of text.split(/\r?\n/u)) {
      const line = rawLine.replace(/#.*$/u, '').trim()
      if (line === '') continue
      for (const key of splitKeys(line)) keys.push(key)
    }
    return { keys }
  } catch (error) {
    return { keys: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Resolve the complete key pool for one plugin activation.
 * @param {{
 *   apiKeys?: readonly string[],
 *   apiKeyEnvs?: readonly string[],
 *   keysFile?: string,
 *   home?: string,
 * }} config
 * @param {{ env?: NodeJS.ProcessEnv, homeDir?: string, fileExists?: (path: string) => boolean, readFile?: typeof readKeysFile }} [options]
 * @returns {{ keys: { value: string, label: string }[], problems: string[] }}
 */
export function resolveApiKeys(config, options = {}) {
  const env = options.env ?? process.env
  const home = options.homeDir ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const fileExists = options.fileExists ?? isFile
  const readFile = options.readFile ?? readKeysFile
  /** @type {{ keys: { value: string, label: string }[], problems: string[] }} */
  const into = { keys: [], problems: [] }

  for (const name of config.apiKeyEnvs ?? []) {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') {
      into.problems.push(`environment variable ${name} is not set`)
      continue
    }
    const found = splitKeys(raw)
    if (found.length === 0) into.problems.push(`environment variable ${name} is empty`)
    found.forEach((value, index) => addKey(value, found.length > 1 ? `env:${name}[${index + 1}]` : `env:${name}`, into))
  }

  const configuredFile = (config.keysFile ?? '').trim()
  const filePath = configuredFile === ''
    ? join(home, 'nvidia-nim.keys')
    : resolve(configuredFile.replace(/^~(?=$|[\\/])/u, home))
  if (configuredFile !== '' || fileExists(filePath)) {
    const read = readFile(filePath)
    if (read.error !== undefined) {
      into.problems.push(`key file ${filePath} could not be read: ${read.error}`)
    } else if (read.keys.length === 0) {
      into.problems.push(`key file ${filePath} contains no keys`)
    } else {
      const label = `file:${filePath.split(/[\\/]/u).pop()}`
      read.keys.forEach((value, index) => addKey(value, read.keys.length > 1 ? `${label}[${index + 1}]` : label, into))
    }
  }

  for (const [index, value] of (config.apiKeys ?? []).entries()) {
    addKey(String(value).trim(), `config.apiKeys[${index + 1}]`, into)
  }

  return into
}

/**
 * Whether one path exists as a regular file.
 * @param {string} path
 * @returns {boolean}
 */
export function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}