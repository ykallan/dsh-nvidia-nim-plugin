import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { KeyFileStore, isUsableKey, keyFileWritable, keyId, maskKey, readKeyLines } from '../lib/key-store.js'

/** One isolated directory per test. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'nim-keys-'))
  return { dir, path: join(dir, 'nvidia-nim.keys'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('a missing key file reads as an empty list', () => {
  const { path } = workspace()
  assert.deepEqual(readKeyLines(path), [])
  assert.deepEqual(new KeyFileStore(path).entries(), [])
})

test('comments, blank lines, and BOM are ignored when reading', () => {
  const { path, cleanup } = workspace()
  writeFileSync(path, '\uFEFF# header\n\nnvapi-one\n  # comment\nnvapi-two\n')
  assert.deepEqual(readKeyLines(path).map(entry => entry.value), ['nvapi-one', 'nvapi-two'])
  cleanup()
})

test('a pasted batch adds each non-empty line once and reports the rest', () => {
  const { path, cleanup } = workspace()
  const store = new KeyFileStore(path)
  const outcome = store.add([
    'nvapi-alpha',
    '',
    'nvapi-beta',
    'nvapi-alpha',
    'nvapi with space',
    '# not a key line is still a key attempt',
    'nvapi-gamma',
  ].join('\n'))
  assert.deepEqual(outcome.added.map(entry => entry.masked.endsWith('ha')), [true, false, false])
  assert.equal(outcome.added.length, 3)
  assert.equal(outcome.duplicates, 1)
  assert.deepEqual(outcome.invalid, [5, 6])
  assert.equal(JSON.stringify(outcome.added).includes('nvapi-alpha'), false, 'listings never carry a key')
  assert.deepEqual(store.entries().map(entry => entry.value), ['nvapi-alpha', 'nvapi-beta', 'nvapi-gamma'])
  assert.match(readFileSync(path, 'utf8'), /^# NVIDIA NIM API keys/m)
  cleanup()
})

test('a second batch skips keys that are already stored', () => {
  const { path, cleanup } = workspace()
  const store = new KeyFileStore(path)
  store.add('nvapi-one\nnvapi-two')
  const outcome = store.add('nvapi-two\nnvapi-three')
  assert.equal(outcome.added.length, 1)
  assert.equal(outcome.duplicates, 1)
  assert.deepEqual(store.entries().map(entry => entry.value), ['nvapi-one', 'nvapi-two', 'nvapi-three'])
  cleanup()
})

test('remove deletes one key and keeps comments and neighbours', () => {
  const { path, cleanup } = workspace()
  writeFileSync(path, '# keep this comment\nnvapi-one\nnvapi-two\n')
  const store = new KeyFileStore(path)
  const removed = store.remove(keyId('nvapi-two'))
  assert.equal(removed, true)
  assert.deepEqual(store.entries().map(entry => entry.value), ['nvapi-one'])
  assert.match(readFileSync(path, 'utf8'), /# keep this comment/)
  assert.equal(store.remove(keyId('nvapi-missing')), false)
  cleanup()
})

test('ids are stable, distinct, and reveal nothing usable', () => {
  assert.equal(keyId('nvapi-one'), keyId('nvapi-one'))
  assert.notEqual(keyId('nvapi-one'), keyId('nvapi-two'))
  assert.match(keyId('nvapi-one'), /^[0-9a-f]{16}$/u)
  assert.equal(keyId('nvapi-one').includes('nvapi'), false)
})

test('masking keeps the ends so two keys stay distinguishable', () => {
  assert.equal(maskKey('nvapi-0123456789abcdef'), 'nvapi-…cdef')
  assert.equal(maskKey('short'), 'sh…rt')
})

test('usable keys are visible ASCII without spaces', () => {
  assert.equal(isUsableKey('nvapi-abc_123'), true)
  assert.equal(isUsableKey('nvapi abc'), false)
  assert.equal(isUsableKey('nvapi-\u00e9'), false)
  assert.equal(isUsableKey(''), false)
})

test('writability is reported without changing the file', () => {
  const { dir, path, cleanup } = workspace()
  assert.deepEqual(keyFileWritable(path), { writable: true })
  writeFileSync(path, 'nvapi-one\n')
  const before = readFileSync(path, 'utf8')
  assert.deepEqual(keyFileWritable(path), { writable: true })
  assert.equal(readFileSync(path, 'utf8'), before)
  assert.equal(keyFileWritable(dir).writable, false)
  cleanup()
})