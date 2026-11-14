/**
 * client 半：DSH 浏览器侧的「节省面板」。
 *
 * 传输契约（与 host 半 src/panel.ts 一致，改一边必须改另一边）：
 *   POST api/dsh-context-manager/summary  →  { ok: true, schema, totals, workspaces, process, formula }
 *
 * 本文件是**经典脚本**，不是 ES 模块：DSH 的 shell 从模块表里加载它，
 * 所以只能 require('react')，不能有相对路径 require、不能用 export。
 */
window.__ModuleLoader__.load({
  id: 'dsh-context-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ROUTE = 'api/dsh-context-manager/summary'
    const PANEL_ID = 'dsh-context-manager'
    const PANEL_ORDER = 40
    const POLL_MS = 5000
    const CSS_ID = 'dcm-panel-css'

    // ---------------------------------------------------------------------
    // 格式化：只做数字→字符串，绝不重算金额（金额由 host 用实测 usage 算好）
    // ---------------------------------------------------------------------
    function group(digits) {
      return String(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    function fmtTokens(value) {
      const n = Number(value)
      if (!isFinite(n) || n <= 0) return '0'
      return group(Math.round(n))
    }

    function fmtMoney(value) {
      const n = Number(value)
      if (!isFinite(n) || n <= 0) return '¥0.0000'
      return '¥' + n.toFixed(4)
    }

    function pct(value) {
      const n = Number(value)
      if (!isFinite(n) || n <= 0) return '—'
      const scaled = n * 100
      return (scaled > 0 && scaled < 0.1 ? scaled.toFixed(2) : scaled.toFixed(1)) + '%'
    }

    function shortPath(target) {
      const text = typeof target === 'string' ? target : ''
      if (text.length <= 34) return text
      return '…' + text.slice(-33)
    }

    // ---------------------------------------------------------------------
    // 取数：失败时保留上一次成功的数据，只把错误挂在标题栏
    // ---------------------------------------------------------------------
    function useSummary(sessionId) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(true)

      React.useEffect(function () {
        let alive = true
        let timer = null

        function tick() {
          let request
          try {
            request = fetch(ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(sessionId ? { sessionId: sessionId } : {}),
            })
          } catch (thrown) {
            if (alive) {
              setError('请求失败：' + String(thrown && thrown.message ? thrown.message : thrown))
              setLoading(false)
            }
            return
          }
          request
            .then(function (response) {
              if (!response.ok) throw new Error('HTTP ' + response.status)
              return response.json()
            })
            .then(function (payload) {
              if (!alive) return
              if (!payload || payload.ok !== true) throw new Error('返回格式不符合契约')
              setData(payload)
              setError('')
              setLoading(false)
            })
            .catch(function (thrown) {
              if (!alive) return
              setError(String(thrown && thrown.message ? thrown.message : thrown))
              setLoading(false)
            })
        }

        tick()
        timer = setInterval(tick, POLL_MS)
        return function () {
          alive = false
          if (timer !== null) clearInterval(timer)
        }
      }, [sessionId])

      return { data: data, error: error, loading: loading }
    }

    // ---------------------------------------------------------------------
    // 小部件
    // ---------------------------------------------------------------------
    function StatCard(props) {
      return h(
        'div',
        { className: 'dcm-card' },
        h('div', { className: 'dcm-card-label' }, props.label),
        h('div', { className: 'dcm-card-value' }, props.value),
        props.hint ? h('div', { className: 'dcm-card-hint' }, props.hint) : null,
      )
    }

    function TabBar(props) {
      return h(
        'div',
        { className: 'dcm-tabs', role: 'tablist' },
        props.tabs.map(function (tab) {
          const active = tab.id === props.active
          return h(
            'button',
            {
              key: tab.id,
              type: 'button',
              role: 'tab',
              'aria-selected': active ? 'true' : 'false',
              className: active ? 'dcm-tab dcm-tab-active' : 'dcm-tab',
              onClick: function () {
                props.onSelect(tab.id)
              },
            },
            h('span', { className: 'dcm-tab-label' }, tab.label),
            h('span', { className: 'dcm-tab-money' }, tab.money),
          )
        }),
      )
    }

    function RangeSwitch(props) {
      const options = [
        { id: 'today', label: '当日' },
        { id: 'all', label: '累计' },
      ]
      return h(
        'div',
        { className: 'dcm-range', role: 'tablist' },
        options.map(function (option) {
          const active = option.id === props.range
          return h(
            'button',
            {
              key: option.id,
              type: 'button',
              role: 'tab',
              'aria-selected': active,
              className: 'dcm-range-btn' + (active ? ' dcm-range-btn-active' : ''),
              onClick: function () {
                props.onSelect(option.id)
              },
            },
            option.label,
          )
        }),
      )
    }

    function DayDetail(props) {
      const day = props.day
      if (day === null || day === undefined) {
        return h('div', { className: 'dcm-empty' }, '当日还没有实测数据。')
      }
      const rows = Array.isArray(day.workspaces) ? day.workspaces : []
      const shown = props.workspaceId
        ? rows.filter(function (row) {
            return row.id === props.workspaceId
          })[0] || null
        : null
      const target = props.workspaceId ? shown : day.totals
      return h(
        'div',
        { className: 'dcm-detail' },
        h('div', { className: 'dcm-detail-path' }, day.date + (props.workspaceId ? ' · ' + (shown ? shown.label : '该工作区') : ' · 全部工作区')),
        h(
          'div',
          { className: 'dcm-grid' },
          h(StatCard, {
            label: '当日省下 token',
            value: fmtTokens(target ? target.savedTokens : 0),
            hint: '含省下的输出 ' + fmtTokens(target ? target.savedOutTokens : 0),
          }),
          h(StatCard, {
            label: '当日省下',
            value: fmtMoney(target ? target.savedMoney : 0),
            hint: '逐请求累加，非按比例折算',
          }),
          h(StatCard, {
            label: '当日实花',
            value: fmtMoney(target ? target.actualMoney : 0),
            hint: '省下占应发 ' + pct(target ? target.savedShare : null),
          }),
          h(StatCard, {
            label: '当日轮次',
            value: fmtTokens(target ? target.turns : 0),
            hint: 'provider usage 实测',
          }),
        ),
        !props.workspaceId && day.unattributed && day.unattributed.turns > 0
          ? h(
              'div',
              { className: 'dcm-note' },
              '其中 ' + fmtMoney(day.unattributed.money) + '（' + fmtTokens(day.unattributed.turns) + ' 轮）来自启动前的日志补齐，无法归属到具体工作区，故只计入当日合计。',
            )
          : null,
        h(
          'div',
          { className: 'dcm-note' },
          '当日口径：按本地日期归集逐轮实测值；跨天不重算、不估算。',
        ),
      )
    }

    function WorkspaceDetail(props) {
      const row = props.row
      if (row === null || row === undefined) {
        return h('div', { className: 'dcm-empty' }, '该工作区还没有实测数据。')
      }
      return h(
        'div',
        { className: 'dcm-detail' },
        h('div', { className: 'dcm-path' }, shortPath(row.path) || '（未知路径）'),
        h(
          'div',
          { className: 'dcm-grid' },
          h(StatCard, { label: '省下 token', value: fmtTokens(row.savedTokens) }),
          h(StatCard, { label: '折算金额', value: fmtMoney(row.savedMoney) }),
          h(StatCard, {
            label: '其中命中缓存',
            value: fmtTokens(row.savedHitTokens),
            hint: '占节省 token 的 ' + pct(row.cachedShare),
          }),
          h(StatCard, { label: '未命中缓存', value: fmtTokens(row.savedMissTokens), hint: '单价 ¥1/M' }),
          h(StatCard, {
            label: '省下输出',
            value: fmtTokens(row.savedOutTokens),
            hint: '单价 ¥4/M（effort 反事实）',
          }),
          h(StatCard, {
            label: '实际花费',
            value: fmtMoney(row.actualMoney),
            hint: '省下占应发 ' + pct(row.savedShare),
          }),
          h(StatCard, { label: '计入轮次', value: fmtTokens(row.turns) }),
        ),
      )
    }

    function ProcessCard(props) {
      const bill = props.bill
      if (bill === null || bill === undefined) {
        return h(
          'div',
          { className: 'dcm-note' },
          '本进程还没有 provider 账单（重启后第一次请求完成才会出现）。',
        )
      }
      return h(
        'div',
        { className: 'dcm-process' },
        h('div', { className: 'dcm-section-title' }, '本进程实测账单'),
        h(
          'div',
          { className: 'dcm-grid' },
          h(StatCard, {
            label: '实际花费',
            value: fmtMoney(bill.actualCost),
            hint: bill.requests + ' 次请求',
          }),
          h(StatCard, {
            label: '不做压缩的反事实花费',
            value: fmtMoney(bill.counterfactualCost),
            hint: '同单价重算',
          }),
          h(StatCard, {
            label: '省下',
            value: fmtMoney(bill.savedCost),
            hint: '降幅 ' + pct(bill.reduction),
          }),
          h(StatCard, {
            label: '缓存命中率',
            value: pct(bill.cacheHitRate),
            hint: 'hit ' + fmtTokens(bill.hitTokens) + ' / miss ' + fmtTokens(bill.missTokens),
          }),
          h(StatCard, {
            label: '少发 prompt token',
            value: fmtTokens(bill.removedTokens),
            hint: '实发 ' + fmtTokens(bill.promptTokens),
          }),
        ),
      )
    }

    function FormulaNote(props) {
      const formula = props.formula
      if (!formula) return null
      return h(
        'div',
        { className: 'dcm-formula' },
        h('div', { className: 'dcm-formula-title' }, '金额口径'),
        h('div', { className: 'dcm-formula-line' }, formula.money),
        h('div', { className: 'dcm-formula-line' }, formula.price),
        h('div', { className: 'dcm-formula-line' }, formula.tokens),
        h('div', { className: 'dcm-formula-note' }, formula.note),
      )
    }

    // ---------------------------------------------------------------------
    // 主面板：标签页 = 合计 + 每个工作区
    // ---------------------------------------------------------------------
    function PanelPage(props) {
      const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : null
      const state = useSummary(sessionId)
      const [active, setActive] = React.useState('__all__')
      const [range, setRange] = React.useState('today')
      const data = state.data

      const workspaces = data && Array.isArray(data.workspaces) ? data.workspaces : []
      const totals = data && data.totals ? data.totals : null
      const today = data && data.today ? data.today : null
      const todayRows = today && Array.isArray(today.workspaces) ? today.workspaces : []
      const hero = range === 'today' && today ? today.totals : totals

      // 工作区可能消失（账本重写），选中的标签页要跟着回落，避免空白。
      React.useEffect(
        function () {
          if (active === '__all__') return
          const exists = workspaces.some(function (row) {
            return row.id === active
          })
          if (!exists) setActive('__all__')
        },
        [active, data],
      )

      const tabs = [
        {
          id: '__all__',
          label: '合计',
          money: fmtMoney(hero ? hero.savedMoney : 0),
        },
      ].concat(
        workspaces.map(function (row) {
          const dayRow = todayRows.filter(function (item) {
            return item.id === row.id
          })[0]
          const source = range === 'today' ? dayRow : row
          return { id: row.id, label: row.label, money: fmtMoney(source ? source.savedMoney : 0) }
        }),
      )

      const selected =
        workspaces.filter(function (row) {
          return row.id === active
        })[0] || null

      if (state.loading && data === null) {
        return h('div', { className: 'dcm-root' }, h('div', { className: 'dcm-empty' }, '正在读取账本…'))
      }

      if (data === null) {
        return h(
          'div',
          { className: 'dcm-root' },
          h('div', { className: 'dcm-empty' }, '面板数据不可用：' + (state.error || '未知原因')),
          h('div', { className: 'dcm-note' }, '请求地址：POST ' + ROUTE),
          h('div', { className: 'dcm-note' }, '插件本身不受影响；压缩与计费仍在正常运行。'),
        )
      }

      return h(
        'div',
        { className: 'dcm-root' },
        h(
          'div',
          { className: 'dcm-header' },
          h('div', { className: 'dcm-title' }, '节省'),
          h(
            'div',
            { className: 'dcm-subtitle' },
            data.since ? '账本起算：' + String(data.since).replace('T', ' ').slice(0, 19) : '账本还没有记录',
            state.error ? h('span', { className: 'dcm-error' }, '  ·  ' + state.error) : null,
          ),
        ),

        h(
          'div',
          { className: 'dcm-grid dcm-grid-hero' },
          h(StatCard, {
            label: range === 'today' ? '当日省下 token' : '省下 token',
            value: fmtTokens(hero ? hero.savedTokens : 0),
            hint: range === 'today' ? '按本地日期归集' : '命中 ' + fmtTokens(totals ? totals.savedHitTokens : 0) + ' / 未命中 ' + fmtTokens(totals ? totals.savedMissTokens : 0),
          }),
          h(StatCard, {
            label: range === 'today' ? '当日省下' : '折算省下',
            value: fmtMoney(hero ? hero.savedMoney : 0),
            hint: '按官方单价逐请求累加',
          }),
          h(StatCard, {
            label: range === 'today' ? '当日轮次' : '计入轮次',
            value: fmtTokens(hero ? hero.turns : 0),
            hint: 'provider usage 实测',
          }),
        ),

        h(RangeSwitch, { range: range, onSelect: setRange }),

        h(TabBar, { tabs: tabs, active: active, onSelect: setActive }),

        range === 'today'
          ? h(DayDetail, { day: today, workspaceId: active === '__all__' ? null : active })
          : active === '__all__'
          ? h(WorkspaceDetail, {
              row:
                totals === null
                  ? null
                  : {
                      path: '全部工作区合计',
                      savedTokens: totals.savedTokens,
                      savedMoney: totals.savedMoney,
                      savedHitTokens: totals.savedHitTokens,
                      savedMissTokens: totals.savedMissTokens,
                      cachedShare: totals.cachedShare,
                      turns: totals.turns,
                    },
            })
          : h(WorkspaceDetail, { row: selected }),

        h(ProcessCard, { bill: data.process }),
        h(FormulaNote, { formula: data.formula }),
      )
    }

    // ---------------------------------------------------------------------
    // 左侧栏入口图标
    // ---------------------------------------------------------------------
    function PanelIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M4 19V5' }),
        h('path', { d: 'M4 19h16' }),
        h('path', { d: 'M8 15v-4' }),
        h('path', { d: 'M12.5 15V8' }),
        h('path', { d: 'M17 15v-6' }),
      )
    }

    // ---------------------------------------------------------------------
    // 样式（注入一次；样式表 id 固定，重载不会叠加）
    // ---------------------------------------------------------------------
    const CSS = [
      '.dcm-root{display:flex;flex-direction:column;gap:14px;padding:18px 20px;font-size:13px;color:var(--dsh-fg,#1f2328);overflow:auto}',
      '.dcm-header{display:flex;flex-direction:column;gap:4px}',
      '.dcm-title{font-size:16px;font-weight:700}',
      '.dcm-subtitle{font-size:12px;opacity:.62}',
      '.dcm-error{color:#c0392b}',
      '.dcm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px}',
      '.dcm-grid-hero .dcm-card{background:rgba(31,122,82,.07);border-color:rgba(31,122,82,.28)}',
      '.dcm-card{border:1px solid rgba(128,128,128,.26);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:3px}',
      '.dcm-card-label{font-size:11px;opacity:.66}',
      '.dcm-card-value{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums}',
      '.dcm-card-hint{font-size:11px;opacity:.58;font-variant-numeric:tabular-nums}',
      '.dcm-range{display:inline-flex;gap:4px;padding:3px;border-radius:9px;background:rgba(128,128,128,.12);margin:4px 0 10px}' +
      '.dcm-range-btn{all:unset;cursor:pointer;font-size:12px;padding:4px 12px;border-radius:7px;color:inherit;opacity:.7}' +
      '.dcm-range-btn-active{background:rgba(120,170,255,.28);opacity:1;font-weight:600}' +
      '.dcm-tabs{display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid rgba(128,128,128,.24);padding-bottom:8px}',
      '.dcm-tab{display:flex;align-items:center;gap:8px;border:1px solid rgba(128,128,128,.26);background:transparent;color:inherit;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer}',
      '.dcm-tab:hover{background:rgba(128,128,128,.1)}',
      '.dcm-tab-active{border-color:rgba(31,122,82,.6);background:rgba(31,122,82,.12);font-weight:600}',
      '.dcm-tab-money{font-variant-numeric:tabular-nums;opacity:.72}',
      '.dcm-detail{display:flex;flex-direction:column;gap:10px}',
      '.dcm-path{font-size:11px;opacity:.6;font-family:ui-monospace,Consolas,monospace}',
      '.dcm-section-title{font-size:12px;font-weight:600;opacity:.8}',
      '.dcm-process{display:flex;flex-direction:column;gap:8px;padding-top:4px}',
      '.dcm-formula{border-top:1px solid rgba(128,128,128,.24);padding-top:10px;display:flex;flex-direction:column;gap:2px;font-size:11px;opacity:.6}',
      '.dcm-formula-title{font-weight:600;opacity:.85}',
      '.dcm-empty{padding:16px 0;opacity:.66}',
      '.dcm-note{font-size:11px;opacity:.6}',
    ].join('\n')

    function injectCss() {
      if (typeof document === 'undefined') return function () {}
      if (document.getElementById(CSS_ID) !== null) return function () {}
      const tag = document.createElement('style')
      tag.id = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return function () {
        tag.remove()
      }
    }

    // ---------------------------------------------------------------------
    // 装配
    // ---------------------------------------------------------------------
    function apply(ctx) {
      ctx.effect(injectCss, 'dsh-context-manager: styles')

      // 顺序很重要：先坐好 main 页面，再挂左侧栏条目——工具栏点击时目标 key 已存在，
      // 不会出现「点了没反应」的空白帧（对照 dsh-context 的注册顺序）。
      // 独立页面：main 是 keyed slot，只认 key（其它 key 不绑定会话）。
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PANEL_ID }, function () {
          return h(PanelPage, {})
        })
      })

      // 左侧栏入口：点击由 shell 转成 selectPanel(id)，id 必须等于上面 main 的 key。
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: function () {
              return '节省'
            },
          },
          function (props) {
            return h(PanelIcon, { size: props && props.size })
          },
        )
      })

      // 会话内标签页：与「对话 / 上下文 / 编队」并列。
      // id 用自己的名字 → 并肩新增一格；写 'chat' 会顶掉宿主那格。
      // order 40 落在 fleet(30) 之后；label 传函数，切语言会重新求值。
      ctx.slots.inject('conversation.view', function () {
        return ctx.slots.register(
          {
            name: 'conversation.view',
            id: 'savings',
            order: 40,
            label: function () {
              return '节省'
            },
          },
          function (props) {
            return h(PanelPage, props || {})
          },
        )
      })
    }

    const module = { exports: {} }
    module.exports = { name: 'dsh-context-manager', inject: ['slots'], apply: apply }
    return module.exports
  },
})
