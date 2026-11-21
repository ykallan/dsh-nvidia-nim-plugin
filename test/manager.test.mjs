import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { KeyFileStore, keyId } from '../lib/key-store.js'
import { KeyScheduler } from '../lib/rate-limit.js'
import { normalizeConfig } from '../lib/config.js'
import { createKeyManager, MANAGER_HEADER } from '../lib/manager.js'

const GOOD = 'nvapi-good-key'
const BAD = 'nvapi-bad-key'

/** A fake endpoint: the public catalog answers for anybody, one key may complete. */
async function fakeFetch(url, init) {
  if (!String(url).endsWith('/chat/completions')) {
    return new Response(JSON.stringify({ data: [{ id: 'alpha/model' }, { id: 'beta/model' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const authorization = String(init.headers.authorization ?? '')
  if (authorization.endsWith(GOOD)) {
    return new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response('{"status":403,"title":"Forbidden","detail":"Authorization failed"}', {
    status: 403,
    headers: { 'content-type': 'application/json' },
  })
}

/** Build a started manager over a temporary key file. */
async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'nim-manager-'))
  const keyFile = join(dir, 'nvidia-nim.keys')
  writeFileSync(keyFile, `# test keys\n${GOOD}\n${BAD}\n`)
  const store = new KeyFileStore(keyFile)
  let runtime = store.entries().map(entry => ({ value: entry.value, label: entry.label }))
  const scheduler = new KeyScheduler({ keys: runtime })
  let changes = 0
  const manager = createKeyManager({
    settings: normalizeConfig({ discoverModels: false }),
    store,
    scheduler,
    keys: () => runtime,
    keyFile,
    fetchImpl: fakeFetch,
    onKeysChanged: () => {
      changes += 1
      runtime = store.entries().map(entry => ({ value: entry.value, label: entry.label }))
      scheduler.sync(runtime)
    },
    ports: [0],
    log: { debug() {}, warn() {} },
  })
  const port = await manager.start()
  assert.equal(typeof port, 'number')
  return {
    manager,
    port,
    scheduler,
    store,
    keyFile,
    changes: () => changes,
    cleanup: () => {
      manager.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Call one manager route. */
function call(port, path, { body, headers = {}, method } = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { [MANAGER_HEADER]: '1', 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

test('state lists masked keys without any key material', async () => {
  const h = await harness()
  try {
    const response = await call(h.port, '/state')
    assert.equal(response.status, 200)
    const state = await response.json()
    assert.equal(state.app, 'dsh-nvidia-nim-manager')
    assert.equal(state.keys.length, 2)
    assert.equal(JSON.stringify(state).includes(GOOD), false)
    assert.equal(JSON.stringify(state).includes(BAD), false)
    assert.ok(state.keys.every(key => key.masked.includes('…')))
    assert.equal(state.keyFile.path, h.keyFile)
    assert.equal(state.limits.perSecond, 1)
  } finally {
    h.cleanup()
  }
})

test('a pasted batch is added, deduplicated, and usable without a restart', async () => {
  const h = await harness()
  try {
    const response = await call(h.port, '/keys/add', { body: { text: 'nvapi-new-one\n\nnvapi-new-two\nnvapi-new-one\nnvapi new with space' } })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.added.length, 2)
    assert.equal(result.duplicates, 1)
    assert.deepEqual(result.invalid, [5])
    assert.equal(h.changes(), 1)
    // The live pool (not just the file) now carries the new keys.
    assert.deepEqual(h.scheduler.stats().length, 4)
    assert.equal(result.state.keys.length, 4)
    // The first request may already use a newly added key.
    const lease = await h.scheduler.acquire()
    assert.ok(lease.key.value.startsWith('nvapi-'))
  } finally {
    h.cleanup()
  }
})

test('testing every key reports which ones work and updates key health', async () => {
  const h = await harness()
  try {
    const response = await call(h.port, '/keys/test', { body: {} })
    assert.equal(response.status, 200)
    const { results, state } = await response.json()
    assert.equal(results.length, 2)
    const good = results.find(entry => entry.id === keyId(GOOD))
    const bad = results.find(entry => entry.id === keyId(BAD))
    assert.equal(good.ok, true)
    assert.equal(good.models, 2)
    assert.equal(bad.ok, false)
    assert.equal(bad.status, 403)
    assert.equal(bad.code, 'AUTH')
    assert.match(bad.message, /Authorization failed/u)
    // The rejected key is disabled, and the result is cached for the next render.
    const disabled = state.keys.find(key => key.id === keyId(BAD))
    assert.equal(disabled.disabled, true)
    assert.equal(disabled.lastTest.ok, false)
    assert.equal(h.scheduler.stats().find(stat => stat.label.includes('[1]'))?.disabled, false)
  } finally {
    h.cleanup()
  }
})

test('a healthy probe revives a key that an earlier request had rejected', async () => {
  const h = await harness()
  try {
    h.scheduler.report({ value: GOOD, label: 'file:nvidia-nim.keys[1]' }, { kind: 'auth' })
    await call(h.port, '/keys/test', { body: { ids: [keyId(GOOD)] } })
    const state = await (await call(h.port, '/state')).json()
    assert.equal(state.keys.find(key => key.id === keyId(GOOD)).disabled, false)
  } finally {
    h.cleanup()
  }
})

test('removing a key deletes its line and refreshes the pool', async () => {
  const h = await harness()
  try {
    const response = await call(h.port, '/keys/remove', { body: { id: keyId(BAD) } })
    const result = await response.json()
    assert.equal(result.removed, true)
    assert.equal(result.state.keys.length, 1)
    assert.equal(h.changes(), 1)
    assert.equal(h.scheduler.stats().length, 1)
    const missing = await (await call(h.port, '/keys/remove', { body: { id: 'nope' } })).json()
    assert.equal(missing.removed, false)
  } finally {
    h.cleanup()
  }
})

test('requests without the marker header, or from a foreign Host, are refused', async () => {
  const h = await harness()
  try {
    const plain = await fetch(`http://127.0.0.1:${h.port}/state`)
    assert.equal(plain.status, 403)

    const foreignHost = await new Promise(resolve => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: h.port,
        path: '/state',
        method: 'GET',
        headers: { host: 'example.com', [MANAGER_HEADER]: '1' },
      }, response => {
        response.resume()
        resolve(response.statusCode)
      })
      request.on('error', () => resolve('error'))
      request.end()
    })
    assert.equal(foreignHost, 403)
  } finally {
    h.cleanup()
  }
})

test('only loopback page origins receive CORS permission', async () => {
  const h = await harness()
  try {
    const allowed = await call(h.port, '/state', {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:51833' },
    })
    assert.equal(allowed.status, 204)
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://127.0.0.1:51833')
    assert.match(allowed.headers.get('access-control-allow-headers') ?? '', /x-nvidia-nim-manager/u)

    const desktop = await call(h.port, '/state', { method: 'OPTIONS', headers: { origin: 'null' } })
    assert.equal(desktop.headers.get('access-control-allow-origin'), 'null')

    // The Desktop renderer is a native application scheme, not an http origin.
    const appScheme = await call(h.port, '/state', { method: 'OPTIONS', headers: { origin: 'dsh-app://app' } })
    assert.equal(appScheme.headers.get('access-control-allow-origin'), 'dsh-app://app')

    const foreign = await call(h.port, '/state', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })
    assert.equal(foreign.headers.get('access-control-allow-origin'), null)

    const foreignHttp = await call(h.port, '/state', { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1.evil.example' } })
    assert.equal(foreignHttp.headers.get('access-control-allow-origin'), null)
  } finally {
    h.cleanup()
  }
})

test('unknown routes answer 404 and a malformed body answers 400', async () => {
  const h = await harness()
  try {
    assert.equal((await call(h.port, '/nope')).status, 404)
    const bad = await call(h.port, '/keys/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: undefined })
    // A POST without a body reaches the handler and adds nothing.
    assert.equal(bad.status, 200)
    const malformed = await fetch(`http://127.0.0.1:${h.port}/keys/add`, {
      method: 'POST',
      headers: { [MANAGER_HEADER]: '1', 'content-type': 'application/json' },
      body: 'not json',
    })
    assert.equal(malformed.status, 400)
  } finally {
    h.cleanup()
  }
})

test('disposing the manager releases the port', async () => {
  const h = await harness()
  const port = h.port
  h.cleanup()
  await assert.rejects(fetch(`http://127.0.0.1:${port}/state`, { headers: { [MANAGER_HEADER]: '1' } }))
})