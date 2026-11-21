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

test('the bundle registers the detail-page card and a settings tab with localized copy', () => {
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
  // The detail page (plugins.bundle.config) is the primary entry point.
  const bundle = registered.find(entry => entry.spec.name === 'plugins.bundle.config')
  assert.ok(bundle, 'registers a plugins.bundle.config entry')
  assert.equal(bundle.spec.key, 'dsh-nvidia-nim')
  assert.equal(bundle.spec.locale, 'nvidiaNim.manager')
  // The settings tab is kept as a secondary entry point.
  const tab = registered.find(entry => entry.spec.name === 'settings.plugins.tab')
  assert.ok(tab, 'registers a settings.plugins.tab entry')
  assert.equal(tab.spec.id, 'nvidia-nim-keys')
  assert.equal(tab.spec.label(), 'nvidiaNim.manager.tab')
  assert.equal(tab.spec.inject().t('add'), 'nvidiaNim.manager.add')
  assert.equal(tab.spec.inject().t('title'), 'nvidiaNim.manager.title')
  assert.equal(registered.length, 2)
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
  // The detail-page component is a wrapper that renders NimCard; unwrap it.
  const wrapper = registered[0].component
  const element = wrapper({ view: 'page' })
  const tree = react.__render(element.type, element.props)
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