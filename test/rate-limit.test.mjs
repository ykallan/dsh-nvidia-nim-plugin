import assert from 'node:assert/strict'
import { test } from 'node:test'
import { KeyScheduler } from '../lib/rate-limit.js'

/** A scheduler driven by a fake clock instead of real timers. */
function fakeScheduler(options) {
  const clock = { at: 0 }
  const sleeps = []
  const scheduler = new KeyScheduler({
    ...options,
    now: () => clock.at,
    sleep: async ms => {
      sleeps.push(ms)
      clock.at += ms
    },
  })
  return { scheduler, clock, sleeps }
}

const keyA = { value: 'nvapi-aaaaaaaa', label: 'env:A' }
const keyB = { value: 'nvapi-bbbbbbbb', label: 'env:B' }

test('one start per second on a single key', async () => {
  const { scheduler, clock } = fakeScheduler({ keys: [keyA], requestsPerSecond: 1, requestsPerMinute: 40, safetyMs: 0 })
  const starts = []
  for (let index = 0; index < 3; index++) {
    const lease = await scheduler.acquire()
    starts.push(clock.at)
    assert.equal(lease.key.value, keyA.value)
  }
  assert.deepEqual(starts, [0, 1000, 2000])
})

test('a second key serves while the first is inside its one-second gap', async () => {
  const { scheduler, clock } = fakeScheduler({ keys: [keyA, keyB], requestsPerSecond: 1, requestsPerMinute: 40, safetyMs: 0 })
  const first = await scheduler.acquire()
  const second = await scheduler.acquire()
  assert.equal(clock.at, 0, 'two keys cover the first instant')
  assert.notEqual(first.key.value, second.key.value)
  const third = await scheduler.acquire()
  assert.equal(clock.at, 1000, 'the third start waits for the earliest finished gap')
  assert.ok([keyA.value, keyB.value].includes(third.key.value))
})

test('forty starts fit in a minute and the forty-first waits until the window frees', async () => {
  const { scheduler, clock } = fakeScheduler({
    keys: [keyA],
    requestsPerSecond: 1000,
    requestsPerMinute: 40,
    windowMs: 60_000,
    safetyMs: 0,
  })
  const starts = []
  for (let index = 0; index < 41; index++) {
    await scheduler.acquire()
    starts.push(clock.at)
  }
  assert.equal(starts[39], 39, 'forty starts pass immediately')
  assert.equal(starts[40], 60_000, 'the forty-first waits for the first start to leave the window')
  const inLastMinute = starts.filter(at => at > starts[40] - 60_000 && at <= starts[40])
  assert.equal(inLastMinute.length, 40, 'the rolling minute never holds more than forty starts')
})

test('a rate-limited key cools down before it is used again', async () => {
  const { scheduler, clock } = fakeScheduler({ keys: [keyA], requestsPerSecond: 1, requestsPerMinute: 40, safetyMs: 0 })
  const lease = await scheduler.acquire()
  scheduler.report(lease.key, { kind: 'rate-limit', retryAfterMs: 5000 })
  await scheduler.acquire()
  assert.equal(clock.at, 5000)
})

test('a rejected key is dropped, and an all-rejected pool fails loudly', async () => {
  const { scheduler } = fakeScheduler({ keys: [keyA, keyB] })
  const first = await scheduler.acquire()
  scheduler.report(first.key, { kind: 'auth' })
  const second = await scheduler.acquire()
  assert.notEqual(second.key.value, first.key.value)
  scheduler.report(second.key, { kind: 'auth' })
  await assert.rejects(scheduler.acquire(), error => {
    assert.equal(error.code, 'AUTH')
    assert.match(error.message, /every configured NVIDIA NIM API key was rejected/)
    return true
  })
})

test('no keys reports a missing credential instead of hanging', async () => {
  const scheduler = new KeyScheduler({ keys: [] })
  await assert.rejects(scheduler.acquire(), error => {
    assert.equal(error.code, 'MISSING_CREDENTIAL')
    return true
  })
})

test('an aborted wait rejects with ABORTED', async () => {
  const scheduler = new KeyScheduler({ keys: [keyA], requestsPerSecond: 0.001 })
  await scheduler.acquire()
  const controller = new AbortController()
  const pending = scheduler.acquire(controller.signal)
  controller.abort()
  await assert.rejects(pending, error => {
    assert.equal(error.code, 'ABORTED')
    return true
  })
  scheduler.dispose()
})

test('stats report per-key usage without key material', async () => {
  const { scheduler } = fakeScheduler({ keys: [keyA] })
  await scheduler.acquire()
  const [stats] = scheduler.stats()
  assert.equal(stats.label, 'env:A')
  assert.equal(stats.requests, 1)
  assert.equal(stats.inWindow, 1)
  assert.equal(JSON.stringify(stats).includes('nvapi-'), false)
})