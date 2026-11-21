/**
 * NVIDIA NIM plugin card for Web Settings → Plugins (and the bundle detail page).
 *
 * The card is plain browser code in the page's lazy-CJS module format: it needs
 * no build step, requires React from the shared module table, and talks to the
 * Host half's loopback manager (see `lib/manager.js`) because browser code
 * cannot write the key file itself.
 *
 * Two tabs mirror the reference plugin's account-management UX:
 *   - Accounts: add keys in a batch, then per key pause / resume / pin / rename
 *     / test / remove, each row showing its live status (usable, paused,
 *     rejected, cooling down, untested).
 *   - Models: pick which model ids the conversation model picker offers.
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
        tab: 'NVIDIA NIM',
        title: 'NVIDIA NIM',
        subtitle: '模型供给 · 多密钥池 · 每密钥限流',
        tabAccounts: '账号',
        tabModels: '模型',
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
        statusOk: '可用 · {models} 个模型',
        statusOkNoCount: '可用',
        statusRejected: '不可用 · {message}',
        statusPaused: '已暂停',
        statusCooldown: '冷却中 {seconds} 秒',
        statusUntested: '未测试',
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
        busyHint: '测试期间每个密钥会各发一次单 token 的模型请求，用来判断密钥是否真的可用。',
        pause: '暂停',
        resume: '恢复',
        pin: '置顶',
        unpin: '取消置顶',
        rename: '改备注',
        renamePlaceholder: '备注名（留空清除）',
        refresh: '刷新',
        testOne: '测试',
        testingOne: '测试中…',
        testOneOk: '该密钥可用 · {models} 个模型',
        testOneFail: '该密钥不可用 · {message}',
        pinned: '置顶',
        paused: '已暂停',
        accountNoLabel: '未命名密钥',
        modelsEmpty: '模型目录是空的',
        modelsEmptyHint: '配置或端点目录里还没有模型；可以先添加密钥，再点「刷新模型」。',
        refreshModels: '刷新模型',
        refreshing: '刷新中…',
        selectAll: '全选',
        invertSelection: '反选',
        clearSelection: '全不选',
        selectionAll: '全部模型都会出现在选择器里',
        selectionRestricted: '只显示勾选的模型',
        selectedCount: '已选 {selected}/{total}',
        modelEnabled: '已启用',
        versionLabel: '版本 {version}',
      },
      en: {
        tab: 'NVIDIA NIM',
        title: 'NVIDIA NIM',
        subtitle: 'Model supply · multi-key pool · per-key limits',
        tabAccounts: 'Accounts',
        tabModels: 'Models',
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
        statusOk: 'Usable · {models} models',
        statusOkNoCount: 'Usable',
        statusRejected: 'Unusable · {message}',
        statusPaused: 'Paused',
        statusCooldown: 'Cooling down {seconds}s',
        statusUntested: 'Not tested',
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
        busyHint: 'Testing sends one one-token chat completion per key.',
        pause: 'Pause',
        resume: 'Resume',
        pin: 'Pin',
        unpin: 'Unpin',
        rename: 'Rename',
        renamePlaceholder: 'Label (empty clears it)',
        refresh: 'Refresh',
        testOne: 'Test',
        testingOne: 'Testing…',
        testOneOk: 'This key works · {models} models',
        testOneFail: 'This key failed · {message}',
        pinned: 'Pinned',
        paused: 'Paused',
        accountNoLabel: 'Unnamed key',
        modelsEmpty: 'The model catalog is empty',
        modelsEmptyHint: 'No models are configured or discovered yet; add a key, then press "Refresh models".',
        refreshModels: 'Refresh models',
        refreshing: 'Refreshing…',
        selectAll: 'Select all',
        invertSelection: 'Invert',
        clearSelection: 'Select none',
        selectionAll: 'Every model is offered in the pickers',
        selectionRestricted: 'Only the checked models are offered',
        selectedCount: '{selected}/{total} selected',
        modelEnabled: 'Enabled',
        versionLabel: 'Version {version}',
      },
    }

    /** Shared styles; `currentColor` and translucent greys follow both themes. */
    const STYLES = {
      card: { display: 'flex', flexDirection: 'column', gap: 12, color: 'inherit', fontSize: 13, lineHeight: 1.5 },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
      headerMain: { display: 'flex', flexDirection: 'column', gap: 2 },
      title: { margin: 0, fontSize: 15, fontWeight: 600 },
      subtitle: { margin: 0, opacity: 0.7, fontSize: 12 },
      headerMeta: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' },
      tabs: { display: 'flex', gap: 4, borderBottom: '1px solid rgba(127,127,127,.28)', paddingBottom: 0 },
      tabButton: {
        font: 'inherit',
        padding: '6px 12px',
        border: 'none',
        borderBottom: '2px solid transparent',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        opacity: 0.7,
      },
      tabActive: { borderBottom: '2px solid currentColor', opacity: 1, fontWeight: 600 },
      section: { display: 'flex', flexDirection: 'column', gap: 8 },
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
      buttonSm: {
        font: 'inherit',
        padding: '2px 8px',
        fontSize: 12,
        borderRadius: 6,
        border: '1px solid rgba(127,127,127,.45)',
        background: 'rgba(127,127,127,.1)',
        color: 'inherit',
        cursor: 'pointer',
      },
      textarea: {
        width: '100%',
        minHeight: 80,
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
      input: {
        font: 'inherit',
        padding: '3px 8px',
        borderRadius: 6,
        border: '1px solid rgba(127,127,127,.45)',
        background: 'rgba(127,127,127,.06)',
        color: 'inherit',
        minWidth: 160,
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
      itemMain: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      itemTitle: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      itemMeta: { display: 'flex', gap: 10, flexWrap: 'wrap', opacity: 0.7, fontSize: 12 },
      actions: { display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' },
      dot: { width: 8, height: 8, borderRadius: 4, display: 'inline-block', flex: '0 0 auto' },
      tag: {
        fontSize: 11,
        padding: '0 6px',
        borderRadius: 4,
        border: '1px solid rgba(127,127,127,.4)',
        opacity: 0.9,
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 },
      muted: { opacity: 0.7, margin: 0 },
      mutedSmall: { opacity: 0.6, margin: 0, fontSize: 11 },
      ok: { color: '#3f9c3f' },
      bad: { color: '#d05555', margin: 0 },
      warn: { color: '#c08a2e', margin: 0 },
      modelRow: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 6px', borderRadius: 6, cursor: 'pointer' },
    }

    /** Status dot colour per status word. */
    const DOT_COLORS = {
      ok: '#3f9c3f',
      paused: '#9a9a9a',
      rejected: '#d05555',
      cooldown: '#c08a2e',
      untested: '#9a9a9a',
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

    /**
     * One row's status text, colour, and dot colour.
     * @param {(key: string, params?: Record<string, string | number>) => string} t
     * @param {any} key
     */
    function statusOf(t, key) {
      const status = key.status ?? (key.disabled ? 'rejected' : key.paused ? 'paused' : key.lastTest ? (key.lastTest.ok ? 'ok' : 'rejected') : 'untested')
      if (status === 'ok') {
        const models = key.lastTest && key.lastTest.models
        return {
          text: models === undefined ? t('statusOkNoCount') : format(t('statusOk'), { models }),
          style: STYLES.ok,
          dot: DOT_COLORS.ok,
        }
      }
      if (status === 'rejected') {
        const message = (key.lastTest && (key.lastTest.message || key.lastTest.code)) || t('statusRejected')
        return { text: format(t('statusRejected'), { message }), style: STYLES.bad, dot: DOT_COLORS.rejected }
      }
      if (status === 'paused') return { text: t('statusPaused'), style: STYLES.muted, dot: DOT_COLORS.paused }
      if (status === 'cooldown') {
        return { text: format(t('statusCooldown'), { seconds: Math.ceil((key.cooldownMs || 0) / 1000) }), style: STYLES.warn, dot: DOT_COLORS.cooldown }
      }
      return { text: t('statusUntested'), style: STYLES.muted, dot: DOT_COLORS.untested }
    }

    /** One account row with its inline actions. */
    function AccountRow(props) {
      const { t, account, busy, onAction } = props
      const [renaming, setRenaming] = React.useState(false)
      const [draft, setDraft] = React.useState(account.userLabel || '')
      const status = statusOf(t, account)
      const name = account.userLabel || account.label || t('accountNoLabel')
      const pending = busy !== ''
      return h('li', { style: STYLES.item },
        h('span', { style: { ...STYLES.dot, background: status.dot } }),
        h('div', { style: { ...STYLES.grow, ...STYLES.itemMain } },
          h('div', { style: STYLES.itemTitle },
            h('span', { style: STYLES.mono }, account.masked),
            h('span', { style: STYLES.mutedSmall }, name),
            account.pinned ? h('span', { style: STYLES.tag }, t('pinned')) : null,
            account.paused ? h('span', { style: STYLES.tag }, t('paused')) : null),
          h('span', { style: status.style }, status.text),
          renaming
            ? h('div', { style: STYLES.row },
              h('input', {
                style: STYLES.input,
                value: draft,
                placeholder: t('renamePlaceholder'),
                onChange: event => setDraft(event.target.value),
              }),
              h('button', {
                type: 'button',
                style: STYLES.buttonSm,
                disabled: pending,
                onClick: () => { onAction('rename', { label: draft }); setRenaming(false) },
              }, 'OK'),
              h('button', { type: 'button', style: STYLES.buttonSm, onClick: () => setRenaming(false) }, '×'))
            : null),
        h('div', { style: STYLES.actions },
          h('button', { type: 'button', style: STYLES.buttonSm, disabled: pending, onClick: () => setRenaming(v => !v) }, t('rename')),
          h('button', { type: 'button', style: STYLES.buttonSm, disabled: pending, onClick: () => onAction('refresh') }, busy === `refresh:${account.id}` ? t('testingOne') : t('testOne')),
          h('button', { type: 'button', style: STYLES.buttonSm, disabled: pending, onClick: () => onAction(account.pinned ? 'unpin' : 'pin') }, account.pinned ? t('unpin') : t('pin')),
          h('button', { type: 'button', style: STYLES.buttonSm, disabled: pending, onClick: () => onAction(account.paused ? 'resume' : 'pause') }, account.paused ? t('resume') : t('pause')),
          h('button', { type: 'button', style: STYLES.buttonSm, disabled: pending, onClick: () => onAction('remove') }, t('remove'))))
    }

    /** One model row with a checkbox. */
    function ModelRow(props) {
      const { model, busy, onToggle } = props
      return h('label', { style: STYLES.modelRow },
        h('input', {
          type: 'checkbox',
          checked: model.enabled === true,
          disabled: busy,
          onChange: event => onToggle(event.target.checked),
        }),
        h('span', { style: STYLES.mono }, model.name || model.id))
    }

    function NimCard(props) {
      const t = props.t
      const [connection, setConnection] = React.useState({ kind: 'loading' })
      const [tab, setTab] = React.useState('accounts')
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState(null)
      const [panel, setPanel] = React.useState(null)

      const load = React.useCallback(async () => {
        setConnection({ kind: 'loading' })
        try {
          const { port, state } = await connect()
          setConnection({ kind: 'ready', port, state })
          try {
            const models = await request(port, '/models')
            setPanel(models)
          } catch {
            setPanel(null)
          }
        } catch (error) {
          setConnection({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      const applyState = React.useCallback(state => {
        setConnection(current => current.kind === 'ready' && state !== undefined
          ? { kind: 'ready', port: current.port, state }
          : current)
      }, [])

      const addKeys = async () => {
        if (connection.kind !== 'ready' || busy !== '') return
        setBusy('add')
        setNotice(null)
        try {
          const result = await request(connection.port, '/keys/add', { text: draft })
          applyState(result.state)
          setDraft('')
          const parts = [format(t('added'), { added: result.added.length })]
          if (result.duplicates > 0) parts.push(format(t('skipped'), { duplicates: result.duplicates }))
          if (result.invalid.length > 0) parts.push(format(t('invalid'), { lines: result.invalid.join(', ') }))
          setNotice({ kind: result.added.length > 0 ? 'ok' : 'muted', text: result.added.length > 0 ? parts.join(' ') : t('nothingToAdd') })
          if (result.added.length > 0) void refreshPanel()
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
          applyState(result.state)
          const failed = result.results.filter(entry => !entry.ok).length
          setNotice({ kind: failed === 0 ? 'ok' : 'warn', text: format(t('testSummary'), { ok: result.results.length - failed, failed }) })
        } catch (error) {
          setNotice({ kind: 'bad', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }

      const accountAction = async (id, action, extra) => {
        if (connection.kind !== 'ready' || busy !== '') return
        if (action === 'remove') {
          if (typeof window.confirm === 'function' && !window.confirm(t('removeConfirm'))) return
          setBusy(`remove:${id}`)
          setNotice(null)
          try {
            const result = await request(connection.port, '/keys/remove', { id })
            applyState(result.state)
          } catch (error) {
            setNotice({ kind: 'bad', text: format(t('removeFailed'), { message: error instanceof Error ? error.message : String(error) }) })
          } finally {
            setBusy('')
          }
          return
        }
        setBusy(`${action}:${id}`)
        setNotice(null)
        try {
          const body = { id, ...extra }
          if (action === 'pause') body.paused = true
          if (action === 'resume') body.paused = false
          if (action === 'pin') body.pinned = true
          if (action === 'unpin') body.pinned = false
          if (action === 'refresh') body.refresh = true
          const result = await request(connection.port, '/accounts', body)
          applyState(result.state)
          if (action === 'refresh') {
            // The single-key test result is the newest lastTest for this key.
            const row = Array.isArray(result.state.keys) ? result.state.keys.find(entry => entry.id === id) : undefined
            const lastTest = row && row.lastTest
            if (lastTest && lastTest.ok === true) {
              setNotice({ kind: 'ok', text: format(t('testOneOk'), { models: lastTest.models === undefined ? '—' : lastTest.models }) })
            } else if (lastTest && lastTest.ok === false) {
              setNotice({ kind: 'bad', text: format(t('testOneFail'), { message: lastTest.message || lastTest.code || 'unknown' }) })
            }
          }
        } catch (error) {
          setNotice({ kind: 'bad', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }

      const refreshPanel = async () => {
        if (connection.kind !== 'ready') return
        try {
          setPanel(await request(connection.port, '/models'))
        } catch {
          // Keep the previous panel.
        }
      }

      const toggleModel = async (model, next) => {
        if (connection.kind !== 'ready' || panel === null || busy !== '') return
        const enabledIds = panel.models.filter(choice => choice.enabled).map(choice => choice.id)
        const set = new Set(enabledIds)
        if (next) set.add(model.id)
        else set.delete(model.id)
        const all = panel.models.map(choice => choice.id)
        // Select-all is the empty array ("every model"), not "none".
        const payload = set.size === all.length ? [] : [...set]
        setBusy('models')
        try {
          const result = await request(connection.port, '/models', { enabledModels: payload })
          setPanel(result.panel)
          applyState(result.state)
        } catch (error) {
          setNotice({ kind: 'bad', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }

      const refreshModels = async () => {
        if (connection.kind !== 'ready' || busy !== '') return
        setBusy('refresh-models')
        try {
          const result = await request(connection.port, '/models/refresh', {})
          setPanel(result.panel)
          applyState(result.state)
        } catch (error) {
          setNotice({ kind: 'bad', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }

      const selectAll = async () => {
        if (connection.kind !== 'ready' || busy !== '') return
        setBusy('models')
        try {
          const result = await request(connection.port, '/models', { enabledModels: [] })
          setPanel(result.panel)
          applyState(result.state)
        } catch (error) {
          setNotice({ kind: 'bad', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }

      const invertSelection = async () => {
        if (connection.kind !== 'ready' || panel === null || busy !== '') return
        // Flip every checkbox: currently-enabled ids become the disabled set.
        const next = panel.models.filter(choice => choice.enabled !== true).map(choice => choice.id)
        const all = panel.models.map(choice => choice.id)
        // Selecting everything is the empty array ("every model"), not "none".
        const payload = next.length === all.length ? [] : next
        setBusy('models')
        try {
          const result = await request(connection.port, '/models', { enabledModels: payload })
          setPanel(result.panel)
          applyState(result.state)
        } catch (error) {
          setNotice({ kind: 'bad', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }

      const tabButton = (value, label) => h('button', {
        type: 'button',
        style: value === tab ? { ...STYLES.tabButton, ...STYLES.tabActive } : STYLES.tabButton,
        onClick: () => setTab(value),
      }, label)

      if (connection.kind === 'loading') {
        return h('div', { style: STYLES.card }, h('p', { style: STYLES.muted }, t('loading')))
      }
      if (connection.kind === 'error') {
        return h('div', { style: STYLES.card },
          h('p', { style: STYLES.bad }, t('unavailable'), connection.message),
          h('p', { style: STYLES.muted }, t('unavailableHint')),
          h('button', { type: 'button', style: STYLES.button, onClick: () => void load() }, t('retry')))
      }

      const state = connection.state
      const keys = Array.isArray(state.keys) ? state.keys : []
      const models = panel !== null && Array.isArray(panel.models) ? panel.models : []

      return h('div', { style: STYLES.card },
        h('div', { style: STYLES.header },
          h('div', { style: STYLES.headerMain },
            h('h3', { style: STYLES.title }, t('title')),
            h('p', { style: STYLES.subtitle }, t('subtitle'))),
          h('div', { style: STYLES.headerMeta },
            h('span', { style: STYLES.mutedSmall }, format(t('limitsValue'), state.limits || { perSecond: 1, perMinute: 40 })))),
        h('div', { style: STYLES.tabs },
          tabButton('accounts', t('tabAccounts')),
          tabButton('models', t('tabModels'))),
        notice === null ? null : h('p', { style: notice.kind === 'bad' ? STYLES.bad : notice.kind === 'warn' ? STYLES.warn : notice.kind === 'ok' ? STYLES.ok : STYLES.muted }, notice.text),

        tab === 'accounts'
          ? h('div', { style: STYLES.section },
            h('p', { style: STYLES.mutedSmall }, `${t('keyFile')}: ${state.keyFile && state.keyFile.path ? state.keyFile.path : '—'}${state.keyFile && state.keyFile.writable === false ? ' (read-only)' : ''}`),
            h('p', { style: STYLES.muted }, t('hint')),
            h('textarea', {
              style: STYLES.textarea,
              value: draft,
              placeholder: t('placeholder'),
              spellCheck: false,
              rows: 4,
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
            busy === 'test' ? h('p', { style: STYLES.mutedSmall }, t('busyHint')) : null,
            keys.length === 0
              ? h('p', { style: STYLES.muted }, t('empty'))
              : h('ul', { style: STYLES.list }, keys.map(account => h(AccountRow, {
                key: account.id,
                t,
                account,
                busy,
                onAction: (action, extra) => void accountAction(account.id, action, extra),
              }))),
            h('p', { style: STYLES.mutedSmall }, t('envHint')))
          : null,

        tab === 'models'
          ? h('div', { style: STYLES.section },
            h('div', { style: STYLES.row },
              h('button', {
                type: 'button',
                style: STYLES.button,
                disabled: busy !== '',
                onClick: () => void refreshModels(),
              }, busy === 'refresh-models' ? t('refreshing') : t('refreshModels')),
              h('button', {
                type: 'button',
                style: STYLES.button,
                disabled: busy !== '' || panel === null,
                onClick: () => void selectAll(),
              }, t('selectAll')),
              h('button', {
                type: 'button',
                style: STYLES.button,
                disabled: busy !== '' || panel === null,
                onClick: () => void invertSelection(),
              }, t('invertSelection')),
              h('span', { style: STYLES.mutedSmall }, panel === null || panel.restricted !== true ? t('selectionAll') : t('selectionRestricted')),
              panel === null || models.length === 0 ? null : h('span', { style: STYLES.mutedSmall },
                format(t('selectedCount'), { selected: models.filter(model => model.enabled === true).length, total: models.length }))),
            models.length === 0
              ? h('div', null,
                h('p', { style: STYLES.muted }, t('modelsEmpty')),
                h('p', { style: STYLES.mutedSmall }, t('modelsEmptyHint')))
              : h('div', { style: STYLES.list }, models.map(model => h(ModelRow, {
                key: model.id,
                model,
                busy: busy === 'models',
                onToggle: next => void toggleModel(model, next),
              }))))
          : null)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'nvidia-nim: manager dictionaries')
        const t = ctx.locale.bind(NS)
        // Bundle detail page (Plugins → dsh-nvidia-nim): the primary entry point.
        // Keyed by package name, rendered between the description and the rows.
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-nvidia-nim',
          locale: NS,
        }, () => h(NimCard, { t })))
        // Also keep the Settings → Plugins tab so the card is reachable there too.
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'nvidia-nim-keys',
          order: 60,
          label: () => ctx.locale.bind(NS)('tab'),
          locale: NS,
          inject: () => ({ t: ctx.locale.bind(NS) }),
        }, NimCard))
      },
      /** Test seam: transport helpers the module loader never reads. */
      __test: { connect, request, statusOf, format, NS, PORTS },
    }
  },
})
