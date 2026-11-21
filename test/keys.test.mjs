import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readKeysFile, resolveApiKeys, splitKeys } from '../lib/keys.js'

test('splitKeys accepts commas, newlines, and quoted values', () => {
  assert.deepEqual(splitKeys('nvapi-one, nvapi-two\nnvapi-three;nvapi-four'), [
    'nvapi-one', 'nvapi-two', 'nvapi-three', 'nvapi-four',
  ])
  assert.deepEqual(splitKeys('"nvapi-quoted"'), ['nvapi-quoted'])
  assert.deepEqual(splitKeys("'nvapi-single'"), ['nvapi-single'])
  assert.deepEqual(splitKeys('   '), [])
})

test('environment variables supply several keys and duplicates collapse', () => {
  const result = resolveApiKeys(
    { apiKeyEnvs: ['NVIDIA_NIM_API_KEY', 'NVIDIA_NIM_API_KEYS'], apiKeys: [] },
    { env: { NVIDIA_NIM_API_KEY: 'nvapi-a', NVIDIA_NIM_API_KEYS: 'nvapi-b,nvapi-a' }, homeDir: '/nonexistent-dsh-home' },
  )
  assert.deepEqual(result.keys.map(key => key.value), ['nvapi-a', 'nvapi-b'])
  assert.deepEqual(result.keys.map(key => key.label), ['env:NVIDIA_NIM_API_KEY', 'env:NVIDIA_NIM_API_KEYS[1]'])
  assert.deepEqual(result.problems, [])
})

test('a key file adds keys and a missing variable is reported without echoing a secret', () => {
  const result = resolveApiKeys(
    { apiKeyEnvs: ['NVIDIA_NIM_API_KEY'], keysFile: '/keys/nvidia.keys', apiKeys: ['nvapi-inline'] },
    {
      env: {},
      homeDir: '/nonexistent-dsh-home',
      fileExists: () => true,
      readFile: () => ({ keys: ['nvapi-file-1', 'nvapi-file-2'] }),
    },
  )
  assert.deepEqual(result.keys.map(key => key.value), ['nvapi-file-1', 'nvapi-file-2', 'nvapi-inline'])
  assert.deepEqual(result.keys.map(key => key.label), ['file:nvidia.keys[1]', 'file:nvidia.keys[2]', 'config.apiKeys[1]'])
  assert.deepEqual(result.problems, ['environment variable NVIDIA_NIM_API_KEY is not set'])
  assert.equal(JSON.stringify(result.problems).includes('nvapi-'), false)
})

test('the default key file under DSH_HOME is read when it exists', () => {
  const result = resolveApiKeys(
    { apiKeyEnvs: [], apiKeys: [] },
    { env: {}, homeDir: 'C:/dsh-home', fileExists: () => true, readFile: () => ({ keys: ['nvapi-home'] }) },
  )
  assert.deepEqual(result.keys.map(key => key.value), ['nvapi-home'])
  assert.deepEqual(result.keys.map(key => key.label), ['file:nvidia-nim.keys'])
})

test('readKeysFile skips comments and blank lines', () => {
  const result = readKeysFile(fileURLToPath(new URL('./fixtures/keys.txt', import.meta.url)))
  assert.equal(result.error, undefined)
  assert.deepEqual(result.keys, ['nvapi-first', 'nvapi-second', 'nvapi-third'])
})

test('an unusable key value is reported by source, never by value', () => {
  const result = resolveApiKeys(
    { apiKeyEnvs: ['NVIDIA_NIM_API_KEY'], apiKeys: [] },
    { env: { NVIDIA_NIM_API_KEY: 'nvapi with space' }, homeDir: '/nonexistent-dsh-home' },
  )
  assert.equal(result.keys.length, 0)
  assert.equal(result.problems.length, 1)
  assert.match(result.problems[0], /not a usable API key/)
  assert.equal(result.problems[0].includes('nvapi with space'), false)
})