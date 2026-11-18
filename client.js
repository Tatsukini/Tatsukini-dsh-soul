/**
 * Client half of the soul bundle.
 *
 * Renders one settings page under Settings → 有灵 · 记忆: the knobs the forgetting curve and the
 * proactive auto-continue hook read, persisted through the Host's /soul/prefs route. A saved change
 * applies on the next turn without a restart. The DeepSeek balance that gates the hook is read-only
 * here; the API key field only ever round-trips masked, and the Host keeps the stored key when the
 * page echoes a masked value back.
 */
window.__ModuleLoader__.load({
  id: 'dsh-soul',
  factory(require) {
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback

    var PREFS_ROUTE = '/soul/prefs'

    function readPrefs() {
      return fetch(PREFS_ROUTE, { headers: { accept: 'application/json' } }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
    }

    function writePrefs(prefs) {
      return fetch(PREFS_ROUTE, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(prefs),
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (b) { throw new Error(b.error || 'HTTP ' + r.status) })
        return r.json()
      })
    }

    var S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 18, padding: '4px 0 24px' },
      intro: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: 1.6 },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      },
      cardTitle: { color: 'var(--dsw-alias-label-primary)', fontSize: 13, fontWeight: 700, margin: '0 0 2px' },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
      rowLabel: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      title: { color: 'var(--dsw-alias-label-primary)', fontSize: 13, fontWeight: 600 },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.5 },
      num: {
        width: 96,
        padding: '6px 8px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        textAlign: 'right',
      },
      text: {
        width: '100%',
        padding: '6px 8px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
      },
      toggle: { accentColor: 'var(--dsw-alias-brand-primary)', width: 18, height: 18, cursor: 'pointer' },
      footer: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      primary: {
        padding: '7px 16px',
        borderRadius: 8,
        border: 'none',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
      },
      ghost: {
        padding: '7px 14px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        cursor: 'pointer',
      },
      status: { fontSize: 12 },
      tag: {
        display: 'inline-block',
        padding: '2px 8px',
        margin: '0 6px 6px 0',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11.5,
      },
      balance: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
      },
    }

    function NumberRow(props) {
      return h('div', { style: S.row },
        h('div', { style: S.rowLabel },
          h('span', { style: S.title }, props.title),
          h('span', { style: S.hint }, props.hint)),
        h('input', {
          type: 'number',
          min: props.min === undefined ? 0 : props.min,
          max: props.max,
          step: props.step || 1,
          value: props.value,
          style: S.num,
          onChange: function (e) { props.onChange(Number(e.target.value)) },
        }))
    }

    function ToggleRow(props) {
      return h('div', { style: S.row },
        h('div', { style: S.rowLabel },
          h('span', { style: S.title }, props.title),
          h('span', { style: S.hint }, props.hint)),
        h('input', {
          type: 'checkbox',
          checked: props.value,
          style: S.toggle,
          onChange: function (e) { props.onChange(e.target.checked) },
        }))
    }

    function SoulSettings() {
      var state = useState(null)
      var prefs = state[0]
      var setPrefs = state[1]
      var statusState = useState({ kind: 'idle', text: '' })
      var status = statusState[0]
      var setStatus = statusState[1]
      var savedState = useState(null)
      var savedPath = savedState[0]
      var setSavedPath = savedState[1]
      var balanceState = useState(null)
      var balance = balanceState[0]
      var setBalance = balanceState[1]
      var balanceErrState = useState(null)
      var balanceErr = balanceErrState[0]
      var setBalanceErr = balanceErrState[1]

      useEffect(function () {
        var alive = true
        readPrefs().then(function (body) {
          if (!alive) return
          setPrefs(body.prefs)
          setSavedPath(body.path)
          setBalance(body.balance)
          setBalanceErr(body.balanceError || null)
        }).catch(function (error) {
          if (!alive) return
          setStatus({ kind: 'error', text: '读取失败：' + error.message })
        })
        return function () { alive = false }
      }, [])

      var update = useCallback(function (key, value) {
        setPrefs(function (current) {
          if (!current) return current
          var next = Object.assign({}, current)
          next[key] = value
          return next
        })
      }, [])

      var save = useCallback(function () {
        if (!prefs) return
        setStatus({ kind: 'busy', text: '保存中…' })
        writePrefs(prefs).then(function (body) {
          setPrefs(body.prefs)
          setStatus({ kind: 'ok', text: '已保存 · 下一轮生效，无需重启' })
        }).catch(function (error) {
          setStatus({ kind: 'error', text: '保存失败：' + error.message })
        })
      }, [prefs])

      var reset = useCallback(function () {
        setStatus({ kind: 'busy', text: '重置中…' })
        writePrefs({}).then(function (body) {
          setPrefs(body.prefs)
          setStatus({ kind: 'ok', text: '已恢复默认（密钥仍保留）' })
        }).catch(function (error) {
          setStatus({ kind: 'error', text: '重置失败：' + error.message })
        })
      }, [])

      var recheck = useCallback(function () {
        setStatus({ kind: 'busy', text: '查询余额…' })
        readPrefs().then(function (body) {
          setPrefs(body.prefs)
          setBalance(body.balance)
          setBalanceErr(body.balanceError || null)
          setStatus({ kind: 'ok', text: body.balance === null ? '查不到余额' : '余额已刷新' })
        }).catch(function (error) {
          setStatus({ kind: 'error', text: '查询失败：' + error.message })
        })
      }, [])

      if (!prefs) {
        return h('div', { style: S.wrap },
          h('p', { style: S.intro }, status.text || '正在读取设置…'))
      }

      var statusColor = status.kind === 'error'
        ? 'var(--dsw-alias-state-error-primary)'
        : status.kind === 'ok'
          ? 'var(--dsw-alias-state-success-primary)'
          : 'var(--dsw-alias-label-secondary)'

      var balanceText = balance === null
        ? (balanceErr ? ('不可用（' + balanceErr + '）') : '未查询')
        : (balance + (prefs.balanceBaseUrl && prefs.balanceBaseUrl.indexOf('deepseek') >= 0 ? ' ¥' : ''))

      return h('div', { style: S.wrap },
        h('p', { style: S.intro },
          '有灵把记忆存成磁盘上的 markdown，带遗忘曲线：越久不用越淡。下面的参数决定曲线多快、',
          '以及「记挂着的事」何时自动接续对话。改完点保存即可，下一轮生效，不需要重启。'),

        h('div', { style: S.card },
          h('h3', { style: S.cardTitle }, '遗忘曲线'),
          h(NumberRow, {
            title: '长期事实基准（天）',
            hint: '一条 facts 初次记住后的稳定期 S。调小→忘得更快，调大→记得更久。',
            value: prefs.baseFactDays, min: 1, max: 3650,
            onChange: function (v) { update('baseFactDays', v) },
          }),
          h(NumberRow, {
            title: '记挂的事基准（天）',
            hint: 'loops 的稳定期。默认比事实更短，因为搁下的事该更快重新浮现。',
            value: prefs.baseLoopDays, min: 1, max: 3650,
            onChange: function (v) { update('baseLoopDays', v) },
          }),
          h(NumberRow, {
            title: '零散观察基准（天）',
            hint: 'notes 的稳定期。零星线索忘得最快。',
            value: prefs.baseNoteDays, min: 1, max: 3650,
            onChange: function (v) { update('baseNoteDays', v) },
          }),
          h(NumberRow, {
            title: '强化倍率',
            hint: '每被 soul_touch 印证一次，稳定期乘以这个倍数（越大越记得牢）。',
            value: prefs.reviewMultiplier, min: 1, max: 10,
            onChange: function (v) { update('reviewMultiplier', v) },
          }),
          h(NumberRow, {
            title: '淡出阈值（%）',
            hint: '保持度低于这个百分比，就不再回灌进对话（working memory 里淡出）。',
            value: prefs.fadePercent, min: 1, max: 50,
            onChange: function (v) { update('fadePercent', v) },
          }),
          h(NumberRow, {
            title: '归档阈值（%）',
            hint: '且从未被强化时，低于此值搬进 faded 归档。设 0 表示永不自动归档。',
            value: prefs.prunePercent, min: 0, max: 50,
            onChange: function (v) { update('prunePercent', v) },
          }),
          h(NumberRow, {
            title: '宽限期（天）',
            hint: '新记忆这几天内保持度始终为 100%，不会衰减。',
            value: prefs.graceDays, min: 0, max: 90,
            onChange: function (v) { update('graceDays', v) },
          }),
          h(NumberRow, {
            title: '回灌上限（字符）',
            hint: '每轮注入的记忆块最长多少字符，防止记忆挤掉对话。',
            value: prefs.maxRecallChars, min: 500, max: 40000, step: 500,
            onChange: function (v) { update('maxRecallChars', v) },
          })),

        h('div', { style: S.card },
          h('h3', { style: S.cardTitle }, '自动接续对话'),
          h('p', { style: S.hint }, '当会话空闲、且某件「记挂的事」快要淡出时，自动抛出一轮由你发起的提醒。受冷却与去重保护，不会刷屏。'),
          h(ToggleRow, {
            title: '启用自动接续',
            hint: '关掉后只在每轮回灌里提示，绝不主动开新一轮对话。',
            value: prefs.autoEnabled,
            onChange: function (v) { update('autoEnabled', v) },
          }),
          h(ToggleRow, {
            title: '想起就去做（自动推进）',
            hint: '开着时，被唤起就去把那件事直接做掉（花钱/对外/删除/越界/不可逆的仍先问）；关掉则只来问你一句要不要做。',
            value: prefs.autoAct,
            onChange: function (v) { update('autoAct', v) },
          }),
          h(NumberRow, {
            title: '提醒窗口（天）',
            hint: '只主动提起距淡出不超过这么多天的事。',
            value: prefs.autoHorizonDays, min: 1, max: 365,
            onChange: function (v) { update('autoHorizonDays', v) },
          }),
          h(NumberRow, {
            title: '冷却（秒）',
            hint: '两次自动接续之间的最小间隔。',
            value: prefs.autoCooldownSec, min: 0, max: 86400,
            onChange: function (v) { update('autoCooldownSec', v) },
          })),

        h('div', { style: S.card },
          h('h3', { style: S.cardTitle }, '余额护栏'),
          h('p', { style: S.hint }, '自动接续会花 API 额度。余额过低时不要再抛钩子——只有查到确切余额低于下限时才拦截，查不到则放行。'),
          h(ToggleRow, {
            title: '启用余额护栏',
            hint: '关掉后不论余额都会按上面的规则抛钩子。',
            value: prefs.balanceGuardEnabled,
            onChange: function (v) { update('balanceGuardEnabled', v) },
          }),
          h(NumberRow, {
            title: '余额下限（¥）',
            hint: '已知余额低于这个数时，不抛钩子。默认 3 元。',
            value: prefs.balanceFloorYuan, min: 0, max: 100000, step: 0.5,
            onChange: function (v) { update('balanceFloorYuan', v) },
          }),
          h('div', { style: S.row },
            h('div', { style: S.rowLabel },
              h('span', { style: S.title }, 'DeepSeek API Key'),
              h('span', { style: S.hint },
                '留空则回落到环境变量 DEEPSEEK_API_KEY，再回落自动读取本机「梁文挂件」的 config.json。',
                '保存后只回显末 4 位，明文不会回传。')),
            h('input', {
              type: 'password',
              autoComplete: 'off',
              value: prefs.deepseekApiKey,
              placeholder: 'sk-…（可选）',
              style: S.text,
              onChange: function (e) { update('deepseekApiKey', e.target.value) },
            })),
          h('div', { style: S.row },
            h('div', { style: S.rowLabel },
              h('span', { style: S.title }, '余额接口地址'),
              h('span', { style: S.hint }, '默认 https://api.deepseek.com，会请求其 /user/balance。')),
            h('input', {
              type: 'text',
              value: prefs.balanceBaseUrl,
              style: S.text,
              onChange: function (e) { update('balanceBaseUrl', e.target.value) },
            })),
          h('div', { style: S.balance },
            h('span', { style: S.title }, '当前余额'),
            h('span', { style: S.tag }, balanceText),
            h('button', { style: S.ghost, onClick: recheck }, '查询余额'))),

        h('div', { style: S.footer },
          h('button', { style: S.primary, onClick: save }, '保存'),
          h('button', { style: S.ghost, onClick: reset }, '恢复默认'),
          status.text
            ? h('span', { style: Object.assign({}, S.status, { color: statusColor }) }, status.text)
            : null),

        savedPath
          ? h('p', { style: S.hint },
              '配置文件：', h('span', { style: S.tag }, savedPath))
          : null,

        h('div', { style: S.card },
          h('div', { style: S.rowLabel },
            h('span', { style: S.title }, '怎么读记忆'),
            h('span', { style: S.hint },
              '让我调用 soul_dashboard 重生成 ~/.dsh/soul/dashboard.html，或双击桌面「Soul 记忆可视化」快捷方式打开曲线视图。',
              '想捞回淡出的记忆，把行从 facts.faded.md 复制回 facts/loops/notes，或 soul_touch 打卡。'))))
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'soul',
            order: 61,
            label: function () { return '有灵 · 记忆' },
          }, SoulSettings)
        })
      },
    }
  },
})
