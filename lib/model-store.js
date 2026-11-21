/**
 * Model-selection storage for the NVIDIA NIM plugin.
 *
 * The set of model ids offered in the pickers is a small, frequently changed
 * preference. It lives in a JSON sidecar next to the key file
 * (`nvidia-nim.keys.models.json`) rather than in the profile patch, so changing
 * it never restarts the plugin: the adapter reads the file on every catalog
 * listing, and the manager rewrites it in place.
 *
 * An empty list means "every model", which is also what a missing file means.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Sidecar path for one key file: `nvidia-nim.keys` → `nvidia-nim.keys.models.json`.
 * @param {string} keyFilePath
 * @returns {string}
 */
export function modelsPathFor(keyFilePath) {
  return `${keyFilePath}.models.json`
}

/**
 * Read the stored selection. A missing or malformed file reads as `undefined`
 * (meaning "every model").
 * @param {string} keyFilePath
 * @returns {string[] | undefined}
 */
export function readEnabledModels(keyFilePath) {
  let text
  try {
    text = readFileSync(modelsPathFor(keyFilePath), 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(text)
    const list = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === 'object' ? parsed.enabledModels : undefined
    if (!Array.isArray(list)) return undefined
    const ids = list.filter(value => typeof value === 'string' && value.trim() !== '').map(value => value.trim())
    return ids.length === 0 ? undefined : ids
  } catch {
    return undefined
  }
}

/**
 * Persist the selection. An empty list removes the sidecar (back to "every
 * model").
 * @param {string} keyFilePath
 * @param {readonly string[]} ids
 */
export function writeEnabledModels(keyFilePath, ids) {
  const path = modelsPathFor(keyFilePath)
  const clean = ids.map(id => id.trim()).filter(id => id !== '')
  if (clean.length === 0) {
    rmSync(path, { force: true })
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ enabledModels: clean }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}
