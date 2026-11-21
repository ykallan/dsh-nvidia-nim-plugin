/**
 * NVIDIA NIM key manager tab for Web Settings → Plugins.
 *
 * The tab is plain browser code in the page's lazy-CJS module format: it needs
 * no build step, requires React from the shared module table, and talks to the
 * Host half's loopback manager (see `lib/manager.js`) because browser code
 * cannot write the key file itself.
 *
 * Visible text comes from a locale namespace this package owns, so both shipped
 * languages render without hardcoded copy.
 */

window.__ModuleLoader__.load({
  id: 'dsh-nvidia-nim',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'nvidiaNim.manager'
    /** Loopback ports the Host half may bind, in order. */
    const PORTS = [19871, 19872, 19873, 19874, 19875]
    /** Marker header the Host half requires on every request. */
    const HEADER = 'x-nvidia-nim-manager'

    /** Dictionaries; the tab label and every visible string resolve through these. */
    const DICTIONARIES = {
      zh: {
        tab: 'NVIDIA NIM 密钥',
        title: 'API 密钥',
        hint: '每行一个密钥，空行会被忽略。添加后会写入密钥文件，下一次请求即可使用新密钥。',
        placeholder: 'nvapi-xxxxxxxx\nnvapi-yyyyyyyy',
        add: '批量添加',
        adding: '正在添加…',
        test: '批量测试',
        testing: '正在测试…',
        remove: '删除',
        removeConfirm: '从密钥文件删除这个密钥？',
        retry: '重试',
        loading: '正在连接密钥管理服务…',
        unavailable: '密钥管理服务不可用：',
        unavailableHint: '插件未启用、端口被占用，或页面以 https 打开而服务是 http。',
        empty: '还没有配置任何密钥。',
        noTest: '未测试',
        usable: '可用 · {models} 个模型',
        usableNoCount: '可用',
        unusable: '不可用 · {message}',
        keyFile: '密钥文件',
        limits: '限流',
        limitsValue: '每密钥 {perSecond}/秒、{perMinute}/分钟',
        envHint: '环境变量或插件配置里声明的密钥也列在这里，但只能从对应来源移除。',
        added: '已添加 {added} 个密钥。',
        skipped: '跳过 {duplicates} 个重复行。',
        invalid: '第 {lines} 行不是合法密钥（含空格或不可见字符），已忽略。',
        nothingToAdd: '没有可添加的新密钥。',
        removeFailed: '删除失败：{message}',
        testSummary: '{ok} 个可用，{failed} 个不可用。',
        disabled: '已被拒绝',
        cooldown: '冷却中 {seconds} 秒',
        busyHint: '测试期间每个密钥会各发一次单 token 的模型请求，用来判断密钥是否真的可用。',
      },
      en: {
        tab: 'NVIDIA NIM keys',
        title: 'API keys',
        hint: 'One key per line; blank lines are ignored. Added keys are written to the key file and usable on the next request.',
        placeholder: 'nvapi-xxxxxxxx\nnvapi-yyyyyyyy',
        add: 'Add keys',
        adding: 'Adding…',
        test: 'Test all keys',
        testing: 'Testing…',
        remove: 'Remove',
        removeConfirm: 'Remove this key from the key file?',
        retry: 'Retry',
        loading: 'Connecting to the key manager…',
        unavailable: 'The key manager is unavailable: ',
        unavailableHint: 'The plugin is disabled, its loopback ports are taken, or the page is https while the manager is http.',
        empty: 'No keys are configured yet.',
        noTest: 'Not tested',
        usable: 'Usable · {models} models',
        usableNoCount: 'Usable',
        unusable: 'Unusable · {message}',
        keyFile: 'Key file',
        limits: 'Limits',
        limitsValue: '{perSecond}/s and {perMinute}/min per key',
        envHint: 'Keys from environment variables or plugin configuration appear here too, but can only be removed at their source.',
        added: 'Added {added} key(s).',
        skipped: 'Skipped {duplicates} duplicate line(s).',
        invalid: 'Line {lines} is not a usable key (a space or hidden character); ignored.',
        nothingToAdd: 'No new keys to add.',
        removeFailed: 'Removal failed: {message}',
        testSummary: '{ok} usable, {failed} unusable.',
        disabled: 'Rejected',
        cooldown: 'Cooling down {seconds}s',
        busyHint: 'Testing sends one model-catalog request (GET /models) per key.',
      },
    }

    /** Shared styles; `currentColor` and translucent greys follow both themes. */
    const STYLES = {
      section: { display: 'flex', flexDirection: 'column', gap: 8, color: 'inherit', fontSize: 13, lineHeight: 1.5 },
      heading: { margin: 0, fontSize: 14, fontWeight: 600 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      grow: { flex: 1, minWidth: 0 },
      button: {
        font: 'inherit',
        padding: '4px 12px',
        borderRadius: 6,
        border: '1px solid rgba(127,127,127,.45)',
        background: 'rgba(127,127,127,.1)',
        color: 'inherit',
        cursor: 'pointer',
      },
      textarea: {
        width: '100%',
        minHeight: 96,
        boxSizing: 'border-box',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12,
        padding: 8,
        borderRadius: 6,
        border: '1px solid rgba(127,127,127,.45)',
        background: 'rgba(127,127,127,.06)',
        color: 'inherit',
        resize: 'vertical',
      },
      list: { display: 'flex', flexDirection: 'column', gap: 6, margin: 0, padding: 0, listStyle: 'none' },
      item: {
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        padding: '6px 8px',
        border: '1px solid rgba(127,127,127,.28)',
        borderRadius: 6,
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 },
      muted: { opacity: 0.7, margin: 0 },
      mutedSmall: { opacity: 0.6, margin: 0, fontSize: 11 },
      ok: { color: '#3f9c3f' },
      bad: { color: '#d05555', margin: 0 },
      warn: { color: '#c08a2e', margin: 0 },
    }

    /**
     * Fill `{name}` placeholders.
     * @param {string} template
     * @param {Record<string, string | number>} values
     */
    function format(template, values) {
      return template.replace(/\{(\w+)\}/gu, (match, name) => (name in values ? String(values[name]) : match))
    }

    /**
     * One manager call on one port.
     * @param {number} port
     * @param {string} path
     * @param {Record<string, unknown>} [body]
     */
    async function request(port, path, body) {
      /** @type {RequestInit} */
      const init = {
        headers: { [HEADER]: '1', 'content-type': 'application/json' },
        cache: 'no-store',
      }
      if (body !== undefined) {
        init.method = 'POST'
        init.body = JSON.stringify(body)
      }
      const response = await fetch(`http://127.0.0.1:${port}${path}`, init)
      const payload = await response.json().catch(() => null)
      if (payload === null) throw new Error(`HTTP ${response.status}`)
      if (response.ok !== true) throw new Error((payload.error && payload.error.message) || `HTTP ${response.status}`)
      return payload
    }

    /**
     * Find the manager among the ports the Host may have bound.
     * @returns {Promise<{ port: number, state: any }>}
     */
    async function connect() {
      let lastError
      for (const port of PORTS) {
        try {
          const state = await request(port, '/state')
          if (state && state.app === 'dsh-nvidia-nim-manager') return { port, state }
        } catch (error) {
          lastError = error
        }
      }
      throw lastError || new Error('no manager answered')
    }

    /** One row's status text and colour. */
    function statusOf(t, key) {
      if (key.lastTest) {
        if (key.lastTest.ok) {
          return {
            text: key.lastTest.models === undefined
              ? t('usableNoCount')
              : format(t('usable'), { models: key.lastTest.models }),
            style: STYLES.ok,
          }
        }
        return { text: format(t('unusable'), { message: key.lastTest.message || key.lastTest.code }), style: STYLES.bad }
      }
      if (key.disabled) return { text: t('disabled'), style: STYLES.bad }
      return { text: t('noTest'), style: STYLES.muted }
    }

    function KeysTab(props) {
      const t = props.t
      const [connection, setConnection] = React.useState({ kind: 'loading' })
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState(null)

      const load = React.useCallback(async () => {
        setConnection({ kind: 'loading' })
        try {
          const { port, state } = await connect()
          setConnection({ kind: 'ready', port, state })
        } catch (error) {
          setConnection({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      const applyResult = React.useCallback(result => {
        setConnection(current => current.kind === 'ready' && result && result.state !== undefined
          ? { kind: 'ready', port: current.port, state: result.state }
          : current)
      }, [])

      const addKeys = async () => {
        if (connection.kind !== 'ready' || busy !== '') return
        setBusy('add')
        setNotice(null)
        try {
          const result = await request(connection.port, '/keys/add', { text: draft })
          applyResult(result)
          setDraft('')
          const parts = [format(t('added'), { added: result.added.length })]
          if (result.duplicates > 0) parts.push(format(t('skipped'), { duplicates: result.duplicates }))
          if (result.invalid.length > 0) parts.push(format(t('invalid'), { lines: result.invalid.join(', ') }))
          setNotice({ kind: result.added.length > 0 ? 'ok' : 'muted', text: result.added.length > 0 ? parts.join(' ') : t('nothingToAdd') })
        } catch (error) {
          setNotice({ kind: 'bad', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }

      const testKeys = async () => {
        if (connection.kind !== 'ready' || busy !== '') return
        setBusy('test')
        setNotice(null)
        try {
          const result = await request(connection.port, '/keys/test', {})
          applyResult(result)
          const failed = result.results.filter(entry => !entry.ok).length
          setNotice({ kind: failed === 0 ? 'ok' : 'warn', text: format(t('testSummary'), { ok: result.results.length - failed, failed }) })
        } catch (error) {
          setNotice({ kind: 'bad', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }

      const removeKey = async id => {
        if (connection.kind !== 'ready' || busy !== '') return
        if (typeof window.confirm === 'function' && !window.confirm(t('removeConfirm'))) return
        setBusy(`remove:${id}`)
        setNotice(null)
        try {
          const result = await request(connection.port, '/keys/remove', { id })
          applyResult(result)
        } catch (error) {
          setNotice({ kind: 'bad', text: format(t('removeFailed'), { message: error instanceof Error ? error.message : String(error) }) })
        } finally {
          setBusy('')
        }
      }

      if (connection.kind === 'loading') {
        return h('div', { style: STYLES.section }, h('p', { style: STYLES.muted }, t('loading')))
      }
      if (connection.kind === 'error') {
        return h('div', { style: STYLES.section },
          h('p', { style: STYLES.bad }, t('unavailable'), connection.message),
          h('p', { style: STYLES.muted }, t('unavailableHint')),
          h('button', { type: 'button', style: STYLES.button, onClick: () => void load() }, t('retry')))
      }

      const state = connection.state
      const keys = Array.isArray(state.keys) ? state.keys : []
      return h('div', { style: STYLES.section },
        h('h3', { style: STYLES.heading }, t('title')),
        h('p', { style: STYLES.muted }, format(t('limitsValue'), state.limits || { perSecond: 1, perMinute: 40 })),
        h('p', { style: STYLES.muted }, `${t('keyFile')}: ${state.keyFile && state.keyFile.path ? state.keyFile.path : '—'}${state.keyFile && state.keyFile.writable === false ? ' (read-only)' : ''}`),
        h('p', { style: STYLES.muted }, t('hint')),
        h('textarea', {
          style: STYLES.textarea,
          value: draft,
          placeholder: t('placeholder'),
          spellCheck: false,
          rows: 5,
          onChange: event => setDraft(event.target.value),
        }),
        h('div', { style: STYLES.row },
          h('button', {
            type: 'button',
            style: STYLES.button,
            disabled: busy !== '' || draft.trim() === '',
            onClick: () => void addKeys(),
          }, busy === 'add' ? t('adding') : t('add')),
          h('button', {
            type: 'button',
            style: STYLES.button,
            disabled: busy !== '' || keys.length === 0,
            onClick: () => void testKeys(),
          }, busy === 'test' ? t('testing') : t('test'))),
        busy === 'test' ? h('p', { style: STYLES.muted }, t('busyHint')) : null,
        notice === null ? null : h('p', { style: notice.kind === 'bad' ? STYLES.bad : notice.kind === 'warn' ? STYLES.warn : notice.kind === 'ok' ? STYLES.ok : STYLES.muted }, notice.text),
        keys.length === 0
          ? h('p', { style: STYLES.muted }, t('empty'))
          : h('ul', { style: STYLES.list }, keys.map(key => {
            const status = statusOf(t, key)
            return h('li', { key: key.id, style: STYLES.item },
              h('span', { style: STYLES.mono }, key.masked),
              h('span', { style: STYLES.grow },
                h('span', { style: status.style }, status.text),
                h('br'),
                h('span', { style: STYLES.mutedSmall }, `${key.label}${key.cooldownMs > 0 ? ` · ${format(t('cooldown'), { seconds: Math.ceil(key.cooldownMs / 1000) })}` : ''}`)),
              h('button', {
                type: 'button',
                style: STYLES.button,
                disabled: busy !== '',
                onClick: () => void removeKey(key.id),
              }, busy === `remove:${key.id}` ? '…' : t('remove')))
          })),
        h('p', { style: STYLES.mutedSmall }, t('envHint')))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'nvidia-nim: manager dictionaries')
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'nvidia-nim-keys',
          order: 60,
          label: () => ctx.locale.bind(NS)('tab'),
          locale: NS,
          inject: () => ({ t: ctx.locale.bind(NS) }),
        }, KeysTab))
      },
      /** Test seam: transport helpers the module loader never reads. */
      __test: { connect, request, statusOf, format, NS, PORTS },
    }
  },
})