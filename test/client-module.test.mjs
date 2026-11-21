import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(fileURLToPath(new URL('../client/index.js', import.meta.url)), 'utf8')

/** Minimal hook-capable React stand-in; enough to render one branch. */
function makeReact() {
  const hooks = []
  let cursor = 0
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (!(index in hooks)) hooks[index] = initial
      return [hooks[index], () => {}]
    },
    useCallback(fn) {
      cursor += 1
      return fn
    },
    useMemo(fn) {
      cursor += 1
      return fn()
    },
    useEffect() {
      cursor += 1
    },
    __render(component, props) {
      cursor = 0
      return component(props)
    },
  }
}

/** Load the bundle the way the page does, and return its factory result. */
function loadClient(react) {
  /** @type {any} */
  let spec
  const window = { __ModuleLoader__: { load: value => { spec = value } } }
  // The bundle is a classic script whose only global read is the loader facade.
  new Function('window', SOURCE)(window)
  assert.equal(spec.id, 'dsh-nvidia-nim')
  const module = spec.factory(name => {
    if (name === 'react') return react
    throw new Error(`unexpected require: ${name}`)
  })
  return { spec, module }
}

/** Collect every string in a rendered tree. */
function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node === null || node === undefined || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join(' ')
}

test('the bundle registers one settings tab with localized copy', () => {
  const react = makeReact()
  const { module } = loadClient(react)
  assert.deepEqual(module.inject, ['slots', 'locale'])

  const registered = []
  const dictionaries = []
  const ctx = {
    effect: factory => { factory(); return () => {} },
    locale: {
      register: (namespace, values) => { dictionaries.push({ namespace, values }); return () => {} },
      bind: namespace => keyword => `${namespace}.${keyword}`,
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (spec, component) => { registered.push({ spec, component }); return () => {} },
    },
  }
  module.apply(ctx)

  assert.deepEqual(dictionaries.map(entry => entry.namespace), ['nvidiaNim.manager'])
  assert.equal(dictionaries[0].values.zh.tab, 'NVIDIA NIM')
  assert.ok(dictionaries[0].values.zh.tabAccounts.includes('账号'))
  assert.ok(dictionaries[0].values.en.tabAccounts.toLowerCase().includes('account'))
  assert.equal(registered.length, 1)
  assert.equal(registered[0].spec.name, 'settings.plugins.tab')
  assert.equal(registered[0].spec.id, 'nvidia-nim-keys')
  assert.equal(registered[0].spec.locale, 'nvidiaNim.manager')
  assert.equal(registered[0].spec.label(), 'nvidiaNim.manager.tab')
  assert.equal(registered[0].spec.inject().t('add'), 'nvidiaNim.manager.add')
  assert.equal(registered[0].spec.inject().t('title'), 'nvidiaNim.manager.title')
})

test('the component renders a loading line', () => {
  const react = makeReact()
  const { module } = loadClient(react)
  const registered = []
  const ctx = {
    effect: factory => { factory(); return () => {} },
    locale: {
      register: () => () => {},
      bind: namespace => keyword => `${namespace}.${keyword}`,
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (spec, component) => { registered.push({ spec, component }); return () => {} },
    },
  }
  module.apply(ctx)
  const tree = react.__render(registered[0].component, { t: keyword => keyword })
  const text = textOf(tree)
  assert.match(text, /loading/u)
  assert.equal(tree.type, 'div')
})

test('connect() finds the manager by its app marker and reports failure otherwise', async () => {
  const react = makeReact()
  const { module } = loadClient(react)
  const { connect } = module.__test

  const original = globalThis.fetch
  try {
    const seen = []
    globalThis.fetch = async url => {
      seen.push(String(url))
      const port = Number(new URL(String(url)).port)
      if (port !== 19872) throw new Error('connection refused')
      return new Response(JSON.stringify({ app: 'dsh-nvidia-nim-manager', keys: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const { port, state } = await connect()
    assert.equal(port, 19872)
    assert.equal(state.app, 'dsh-nvidia-nim-manager')
    assert.deepEqual(seen.map(url => new URL(url).port), ['19871', '19872'])

    // A port that answers with somebody else's JSON is skipped.
    globalThis.fetch = async url => {
      const port = Number(new URL(String(url)).port)
      return new Response(JSON.stringify(port === 19873 ? { app: 'not-our-manager' } : {}), { status: 200 })
    }
    await assert.rejects(connect())

    globalThis.fetch = async () => {
      throw new Error('connection refused')
    }
    await assert.rejects(connect(), /connection refused/u)
  } finally {
    globalThis.fetch = original
  }
})

test('format fills named placeholders and leaves unknown ones', () => {
  const react = makeReact()
  const { module } = loadClient(react)
  assert.equal(module.__test.format('{ok} good, {failed} bad', { ok: 2, failed: 1 }), '2 good, 1 bad')
  assert.equal(module.__test.format('{missing}', {}), '{missing}')
})