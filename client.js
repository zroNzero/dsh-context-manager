/*
 * dsh-context-manager — 节省面板（client plugin）。
 *
 * Registers three things, all reading the same snapshot endpoint:
 *
 *   conversation.view      a tab beside 轨迹 (Trajectory registers order 10)
 *   sidebar.panellist      a row in the workspace sidebar
 *   main (keyed)           the full-bleed page the sidebar row selects
 *
 * Gating: this bundle is loaded by the client kernel whenever the package is
 * installed, so it probes /dsh-savings/panels.json first and registers nothing
 * when the panel feature flag is off (that route 404s). Nothing renders and no
 * timers start.
 *
 * Data: docs/PANEL-PROTOCOL.md; this surface only renders panels whose id it
 * knows, so another producer can take over later by publishing a panel with
 * the same id.
 */
window.__ModuleLoader__.load({
  id: 'dsh-context-manager-savings',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useEffect = React.useEffect
    const useState = React.useState

    const NS = 'savings'
    const SNAPSHOT_URL = '/dsh-savings/panels.json'
    const PANEL_ID = 'token-savings'
    const POLL_MS = 5000
    const LABEL = '节省'

    // 视觉语言对齐 DSH 设置页 / 上下文洞察：alias token、12px 圆角卡片、
    // KPI 数字用 tabular-nums、面板标题 12px 600 次级色。
    const MODULE_META = {
      rewrite: { label: '历史重写', color: '#536ba9' },
      fold: { label: '历史折叠', color: '#6f86c9' },
      extraction: { label: '输出压缩', color: '#2f9e6b' },
      admission: { label: '落盘指针', color: '#d99b2b' },
      dedup: { label: '重复去重', color: '#8a6fd1' },
      schema: { label: '工具 schema', color: '#d1688a' },
    }
    const moduleLabel = (key) => (MODULE_META[key] ? MODULE_META[key].label : key)
    const moduleColor = (key, index) =>
      MODULE_META[key] ? MODULE_META[key].color : ['#536ba9', '#2f9e6b', '#d99b2b', '#8a6fd1', '#d1688a'][index % 5]

    const CSS = [
      '.dshwsv{box-sizing:border-box;width:100%;height:100%;overflow:auto;padding:18px 20px 28px;font:inherit;color:var(--dsw-alias-label-primary,#1d2129);background:transparent}',
      '.dshwsv-inner{max-width:920px;margin:0 auto;display:flex;flex-direction:column;gap:14px}',

      // 页头
      '.dshwsv-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dshwsv-title{font-size:15px;font-weight:650;letter-spacing:.01em}',
      '.dshwsv-scope{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#4e5969);background:var(--dsw-alias-bg-layer-2,#f7f8fa);border:1px solid var(--dsw-alias-border-l2,#eceef2);border-radius:999px;padding:2px 9px;max-width:260px}',
      '.dshwsv-scope i{display:block;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-brand-primary,#536ba9);flex:none}',
      '.dshwsv-scope span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshwsv-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a919c)}',

      // KPI 卡片
      '.dshwsv-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px}',
      '.dshwsv-kpi{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#eceef2);border-radius:12px;padding:11px 13px;min-width:0}',
      '.dshwsv-kpi-k{font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary,#8a919c);margin-bottom:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshwsv-kpi-v{font-size:20px;font-weight:680;line-height:1.15;font-variant-numeric:tabular-nums;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshwsv-kpi-v small{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary,#8a919c);margin-left:3px;letter-spacing:0}',
      '.dshwsv-kpi-c{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a919c);margin-top:4px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshwsv-kpi.good .dshwsv-kpi-v{color:var(--dsw-alias-state-success-primary,#2f9e6b)}',
      '.dshwsv-kpi.brand .dshwsv-kpi-v{color:var(--dsw-alias-brand-primary,#3b5bdb)}',

      // 面板
      '.dshwsv-panel{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#eceef2);border-radius:12px;padding:13px 15px 15px}',
      '.dshwsv-panel-h{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}',
      '.dshwsv-panel-t{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:650;color:var(--dsw-alias-label-primary,#1d2129)}',
      '.dshwsv-panel-n{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a919c);font-variant-numeric:tabular-nums}',

      // 环形图 + 图例
      '.dshwsv-split{display:flex;align-items:center;gap:20px;flex-wrap:wrap}',
      '.dshwsv-donut{position:relative;width:112px;height:112px;flex:none}',
      '.dshwsv-donut svg{display:block;width:112px;height:112px;transform:rotate(-90deg)}',
      '.dshwsv-donut-c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;pointer-events:none}',
      '.dshwsv-donut-v{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em}',
      '.dshwsv-donut-k{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a919c)}',
      '.dshwsv-legend{flex:1 1 260px;min-width:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(150px,100%),1fr));gap:4px 14px}',
      '.dshwsv-lg{display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:center;gap:6px;padding:4px 6px;border-radius:6px;transition:background var(--ds-transition-duration,.15s) var(--ds-ease-in-out,ease)}',
      '.dshwsv-lg:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f4f8)}',
      '.dshwsv-lg i{display:block;width:8px;height:8px;border-radius:2px;flex:none}',
      '.dshwsv-lg-n{font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary,#4e5969);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshwsv-lg-v{font-size:12px;font-weight:650;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}',
      '.dshwsv-lg-s{grid-column:2 / -1;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a919c);font-variant-numeric:tabular-nums;margin-top:-1px}',

      // 工作区列表
      '.dshwsv-rows{display:flex;flex-direction:column}',
      '.dshwsv-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:4px 10px;padding:9px 6px;border-radius:6px;transition:background var(--ds-transition-duration,.15s) var(--ds-ease-in-out,ease)}',
      '.dshwsv-row:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f4f8)}',
      '.dshwsv-row + .dshwsv-row{border-top:1px solid var(--dsw-alias-border-l1,#f4f5f7)}',
      '.dshwsv-row-k{font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshwsv-row-v{font-size:13px;font-weight:680;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dshwsv-row-s{grid-column:1 / -1;display:flex;justify-content:space-between;gap:10px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a919c);font-variant-numeric:tabular-nums}',
      '.dshwsv-track{grid-column:1 / -1;height:3px;border-radius:2px;background:var(--dsw-alias-border-l1,#f0f1f4);overflow:hidden;margin-top:2px}',
      '.dshwsv-track > i{display:block;height:3px;border-radius:2px;background:var(--dsw-alias-brand-primary,#536ba9)}',

      // 页脚
      '.dshwsv-foot{font-size:10.5px;line-height:1.65;color:var(--dsw-alias-label-tertiary,#8a919c);word-break:break-word}',
      '.dshwsv-foot b{font-weight:600;color:var(--dsw-alias-label-secondary,#4e5969)}',
      '.dshwsv-empty{display:flex;flex-direction:column;gap:6px;align-items:center;justify-content:center;padding:40px 20px;text-align:center}',
      '.dshwsv-empty-t{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,#4e5969)}',
      '.dshwsv-empty-s{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a919c);line-height:1.6;max-width:320px}',
      '.dshwsv-err{margin-top:10px;font-size:11px;color:var(--dsw-alias-state-error-primary,#c45656)}',
    ].join('\n')

    function StyleOnce() {
      useEffect(() => {
        if (document.getElementById('dshwsv-style')) return
        const el = document.createElement('style')
        el.id = 'dshwsv-style'
        el.textContent = CSS
        document.head.appendChild(el)
      }, [])
      return null
    }

    function installStyles() {
      if (document.getElementById('dshwsv-style')) return
      const style = document.createElement('style')
      style.id = 'dshwsv-style'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function formatNumber(value) {
      const num = Number(value)
      if (!Number.isFinite(num)) return '--'
      const negative = num < 0
      const abs = Math.abs(num)
      const fixed = abs >= 100 ? String(Math.round(abs)) : String(Math.round(abs * 100) / 100)
      const parts = fixed.split('.')
      const whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      return (negative ? '-' : '') + (parts.length > 1 ? whole + '.' + parts[1] : whole)
    }

    function formatPercent(value) {
      const num = Number(value)
      if (!Number.isFinite(num)) return '--'
      return (Math.round(num * 10) / 10) + '%'
    }

    function formatTime(iso) {
      const at = Date.parse(iso)
      if (!Number.isFinite(at)) return ''
      const diff = Date.now() - at
      if (diff < 60_000) return '刚刚更新'
      if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前更新'
      if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前更新'
      return Math.floor(diff / 86_400_000) + ' 天前更新'
    }

    /** Poll the snapshot endpoint; the pet's SSE stream is not shared. */
    function useSnapshot() {
      const [state, setState] = useState({ panel: null, error: '', loaded: false })

      useEffect(() => {
        let alive = true
        let timer = null

        async function refresh() {
          try {
            const res = await fetch(SNAPSHOT_URL, { cache: 'no-store', headers: { accept: 'application/json' } })
            if (!res.ok) throw new Error('HTTP ' + res.status)
            const doc = await res.json()
            if (!alive) return
            const list = doc && Array.isArray(doc.panels) ? doc.panels : []
            const panel = list.find((item) => item && item.id === PANEL_ID) || null
            setState({ panel, error: '', loaded: true })
          } catch (err) {
            if (!alive) return
            setState((prev) => ({ ...prev, error: String((err && err.message) || err), loaded: true }))
          }
        }

        function tick() {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          refresh()
        }

        refresh()
        timer = setInterval(tick, POLL_MS)
        const onVisible = () => {
          if (document.visibilityState !== 'hidden') refresh()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive = false
          if (timer) clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [])

      return state
    }


    /**
     * 节省面板：两个入口共用同一个组件，数据都直接来自 dsh-context-manager 的账本
     * （widget 的 token-savings producer 读 savings.json，原样转发 byWorkspace/bySession）。
     *
     * - 侧栏「节省」页（main slot，无 sessionId）→ 全局总量 + 各工作区 + 分项
     * - 会话内「节省」标签（conversation.view，有 sessionId）→ 只显示本工作区明细
     */
    function Summary(props) {
      const { panel, error } = useSnapshot()
      const scope = props || {}
      const sessionId = typeof scope.sessionId === 'string' ? scope.sessionId : ''
      const scoped = sessionId.length > 0

      const shell = (title, body, note) =>
        h('div', { className: 'dshwsv' },
          h('div', { className: 'dshwsv-head' },
            h('div', { className: 'dshwsv-headtext' },
              h('div', { className: 'dshwsv-title' }, title),
              h('div', { className: 'dshwsv-sub' }, '少发 prompt'),
            ),
          ),
          body,
          note ? h('div', { className: 'dshwsv-foot' }, note) : null,
        )

      if (!panel) {
        return shell('Token 节省',
          h('div', { className: 'dshwsv-empty' }, '暂无数据'),
          error ? '快照接口不可用：' + error : '正在读取 dsh-context-manager 的账本…')
      }
      if (panel.status === 'empty') {
        return shell('Token 节省',
          h('div', { className: 'dshwsv-empty' }, '暂无数据'),
          'dsh-context-manager 还没有产生节省记录')
      }

      const payload = panel.payload || {}
      const meta = payload.meta || {}
      const list = Array.isArray(payload.workspaces) ? payload.workspaces : []
      const slice = scoped ? pickWorkspace(payload, scope.cwd, sessionId) : null
      const money = payload.money || {}

      // 口径统一：token 与金额取自同一个 scope。会话内只看本工作区，
      // 拿不到本工作区切片就一律为空——绝不拿全局金额去配 0 token。
      const tokens = scoped ? (slice ? num(slice.value) : 0) : num(payload.value)
      const cny = scoped
        ? slice && slice.cny !== undefined && slice.cny !== null
          ? num(slice.cny)
          : null
        : money.savedCny !== undefined
          ? num(money.savedCny)
          : money.saved !== undefined
            ? num(money.saved)
            : null
      const pct = scoped ? (slice ? num(slice.percent) : null) : payload.percent ? num(payload.percent.value) : null
      const turns = scoped ? (slice ? num(slice.turns) : 0) : num(money.turns)
      const items = (scoped ? (slice && Array.isArray(slice.items) ? slice.items : []) : Array.isArray(payload.items) ? payload.items : [])
        .filter((item) => num(item.value) > 0)

      const scopeLabel = scoped
        ? (slice ? String(slice.label || '本工作区') : workspaceLabel(scope.cwd) || '本工作区')
        : ''
      const title = scoped ? 'Token 节省 · ' + scopeLabel : 'Token 节省'
      const nothing = scoped && (!slice || tokens <= 0)

      const kpi = (label, value, unit, caption) =>
        h('div', { className: 'dshwsv-kpi' },
          h('div', { className: 'dshwsv-kpi-label' }, label),
          h('div', { className: 'dshwsv-kpi-value' },
            value,
            unit ? h('span', { className: 'dshwsv-kpi-unit' }, unit) : null,
          ),
          caption ? h('div', { className: 'dshwsv-kpi-cap' }, caption) : null,
        )

      const kpis = h('div', { className: 'dshwsv-kpis' },
        kpi('少发 prompt', formatNumber(tokens), 'tokens', turns > 0 ? turns + ' 轮' : ''),
        kpi('压缩率', pct === null ? '—' : formatPercent(pct), '', '输入侧'),
        kpi('省下', cny === null ? '—' : '¥' + cny.toFixed(4), '', '逐轮计价'),
        kpi('命中率', money.effectiveHitRate !== undefined && money.effectiveHitRate !== null
          ? formatPercent(num(money.effectiveHitRate) * 100)
          : '—', '', scoped ? '本工作区' : '加权'),
      )

      const donut = items.length > 0 ? buildDonut(items) : null
      const modulePanel = h('div', { className: 'dshwsv-panel' },
        h('div', { className: 'dshwsv-panel-h' },
          h('div', { className: 'dshwsv-panel-title' }, '分项'),
          h('div', { className: 'dshwsv-panel-note' }, '按来源占比'),
        ),
        donut
          ? h('div', { className: 'dshwsv-donut-wrap' },
              h('div', { className: 'dshwsv-donut' },
                donut.svg,
                h('div', { className: 'dshwsv-donut-center' },
                  h('div', { className: 'dshwsv-donut-total' }, shortNumber(tokens)),
                  h('div', { className: 'dshwsv-donut-cap' }, 'tokens'),
                ),
              ),
              h('div', { className: 'dshwsv-legend' },
                donut.segments.map((seg) =>
                  h('div', { className: 'dshwsv-legend-item', key: seg.label },
                    h('span', { className: 'dshwsv-dot', style: { background: seg.color } }),
                    h('span', { className: 'dshwsv-legend-label' }, moduleLabel(seg.label)),
                    h('span', { className: 'dshwsv-legend-pct' }, formatPercent(seg.pct)),
                    h('span', { className: 'dshwsv-legend-sub' }, formatNumber(seg.value)),
                  ),
                ),
              ),
            )
          : h('div', { className: 'dshwsv-empty' }, nothing ? '本工作区暂无节省记录' : '暂无分项数据'),
      )

      const workspaceRows = scoped
        ? null
        : (() => {
            const rows = list.slice().sort((a, b) => num(b.value) - num(a.value)).slice(0, 12)
            const max = rows.reduce((top, item) => Math.max(top, num(item.value)), 0) || 1
            return rows.length === 0
              ? h('div', { className: 'dshwsv-panel' },
                  h('div', { className: 'dshwsv-panel-h' }, h('div', { className: 'dshwsv-panel-title' }, '各工作区')),
                  h('div', { className: 'dshwsv-empty' }, '暂无工作区记录'),
                )
              : h('div', { className: 'dshwsv-panel' },
                  h('div', { className: 'dshwsv-panel-h' },
                    h('div', { className: 'dshwsv-panel-title' }, '各工作区'),
                    h('div', { className: 'dshwsv-panel-note' }, list.length + ' 个'),
                  ),
                  rows.map((item) => {
                    const share = Math.max(0, Math.min(1, num(item.value) / max))
                    return h('div', { className: 'dshwsv-row', key: String(item.id || item.label) },
                      h('div', { className: 'dshwsv-row-top' },
                        h('span', { className: 'dshwsv-row-label' }, String(item.label || '未命名')),
                        h('span', { className: 'dshwsv-row-value' }, formatNumber(item.value)),
                      ),
                      h('div', { className: 'dshwsv-row-meta' },
                        h('span', null, item.percent !== undefined && item.percent !== null ? formatPercent(item.percent) : '—'),
                        h('span', { className: 'dshwsv-row-cny' },
                          item.cny !== undefined && item.cny !== null ? '¥' + num(item.cny).toFixed(4) : '—'),
                      ),
                      h('div', { className: 'dshwsv-bar' },
                        h('div', { className: 'dshwsv-bar-fill', style: { width: (share * 100).toFixed(1) + '%' } })),
                    )
                  }),
                )
          })()

      const footBits = []
      if (meta.revision) footBits.push('rev ' + meta.revision)
      if (meta.updatedAt) footBits.push(formatAge(Date.now() - Number(meta.updatedAt)).replace(/前$/, '') + '前更新')
      if (money.turns) footBits.push(money.turns + ' 轮逐轮计价')
      if (money.avgPricePerMillion) footBits.push('均价 ¥' + num(money.avgPricePerMillion) + '/M')

      return h('div', { className: 'dshwsv' },
        h('div', { className: 'dshwsv-head' },
          h('div', { className: 'dshwsv-headtext' },
            h('div', { className: 'dshwsv-title' }, title),
            h('div', { className: 'dshwsv-sub' }, '少发 prompt'),
          ),
          pct !== null && tokens > 0
            ? h('span', { className: 'dshwsv-badge' }, '↓ ' + formatPercent(pct))
            : null,
        ),
        kpis,
        h('div', { className: 'dshwsv-grid' },
          modulePanel,
          workspaceRows,
        ),
        h('div', { className: 'dshwsv-foot' }, footBits.join(' · ') || '数据来自 dsh-context-manager 账本'),
      )
    }

    /** 数字兜底：null/NaN/字符串统一成 0，避免 NaN 渗进渲染。 */
    function num(value) {
      const n = Number(value)
      return Number.isFinite(n) ? n : 0
    }

    /** 1.2M 这类紧凑写法，用在大号数字旁边省空间。 */
    function shortNumber(value) {
      const n = num(value)
      if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
      return String(Math.round(n))
    }

    const DONUT_COLORS = ['#4c6ef5', '#2f9e6b', '#d99b2b', '#8a6fd1', '#d1688a', '#3aa8b8']

    /** 环形图：用 SVG 圆环的 stroke-dasharray 拼段，不依赖任何图表库。 */
    function buildDonut(items) {
      const total = items.reduce((sum, item) => sum + num(item.value), 0) || 1
      const radius = 42
      const circumference = 2 * Math.PI * radius
      let offset = 0
      const segments = items.map((item, index) => {
        const value = num(item.value)
        const pct = (value / total) * 100
        const color = DONUT_COLORS[index % DONUT_COLORS.length]
        const length = (value / total) * circumference
        const seg = { label: item.label, value, pct, color, offset, length }
        offset += length
        return seg
      })
      const svg = h('svg', { width: 110, height: 110, viewBox: '0 0 110 110', className: 'dshwsv-donut-svg' },
        h('circle', {
          cx: 55, cy: 55, r: radius, fill: 'none',
          stroke: 'var(--dsw-alias-border-l2, rgba(0,0,0,0.08))', strokeWidth: 12,
        }),
        h('g', { transform: 'rotate(-90 55 55)' },
          segments.map((seg) =>
            h('circle', {
              key: seg.label,
              cx: 55, cy: 55, r: radius, fill: 'none',
              stroke: seg.color,
              strokeWidth: 12,
              strokeDasharray: seg.length.toFixed(2) + ' ' + (circumference - seg.length).toFixed(2),
              strokeDashoffset: (-seg.offset).toFixed(2),
              strokeLinecap: 'butt',
            }),
          ),
        ),
      )
      return { svg, segments }
    }

    function formatAge(ms) {
      if (!Number.isFinite(ms) || ms < 0) return ''
      if (ms < 60_000) return '刚刚'
      if (ms < 3_600_000) return Math.floor(ms / 60_000) + ' 分钟前'
      if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + ' 小时前'
      return Math.floor(ms / 86_400_000) + ' 天前'
    }

    function workspaceLabel(cwd) {
      const normalized = normalizeWorkspacePath(cwd)
      if (!normalized) return ''
      const parts = normalized.split(/[\\/]/).filter(Boolean)
      return parts.length > 0 ? parts[parts.length - 1] : ''
    }

    /** Sidebar glyph: a compact savings mark, no text to keep the row tidy. */
    function SidebarEntry(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      const active = Boolean(props && props.active)
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.72 },
      },
        h('circle', { cx: 8, cy: 8, r: 6.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', {
          d: 'M8 11.2V4.8M5.6 7.2 8 4.8l2.4 2.4',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** Resolve the current workspace cwd for a workspace-bound surface. */
    function resolveSessionCwd(ctx, sessionId) {
      try {
        const binding = ctx.sessions && typeof ctx.sessions.binding === 'function' ? ctx.sessions.binding(sessionId) : null
        const session = binding && binding.session
        const cwd = session && (session.cwd || (session.header && session.header.cwd))
        return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
      } catch (error) {
        return undefined
      }
    }

    function normalizeWorkspacePath(value) {
      return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    }

    /** Pick this workspace's slice; null means "show the cross-workspace total". */
    function pickWorkspace(payload, cwd, sessionId) {
      const list = Array.isArray(payload.workspaces) ? payload.workspaces : []
      // 首选 sessionId → workspaceId 映射：不依赖客户端能否解析 cwd。
      const map = payload.bySession
      if (sessionId && map && typeof map === 'object') {
        const workspaceId = map[sessionId]
        const direct = workspaceId ? list.find((item) => item.id === workspaceId) : undefined
        if (direct && Number.isFinite(Number(direct.value ?? direct.total))) return direct
      }
      const target = normalizeWorkspacePath(cwd)
      if (!target) return null
      const hit = list.find((item) => normalizeWorkspacePath(item.workspace) === target)
      return hit && Number.isFinite(Number(hit.value ?? hit.total)) ? hit : null
    }

    /** Resolve the flag by probing the snapshot route (404 = feature off). */
    async function panelsEnabled() {
      try {
        const res = await fetch(SNAPSHOT_URL, { cache: 'no-store', headers: { accept: 'application/json' } })
        return res.ok
      } catch (err) {
        return false
      }
    }

    return {
      inject: ['slots', 'sessions'],
      apply(ctx) {
        installStyles()

        panelsEnabled().then((enabled) => {
          if (!enabled) return
          try {
            // A tab beside 轨迹 (Trajectory registers order 10).
            ctx.slots.inject('conversation.view', () =>
              ctx.slots.register(
                {
                  name: 'conversation.view',
                  id: NS,
                  order: 20,
                  locale: NS,
                  label: () => LABEL,
                  inject: (sessionId) => ({ sessionId, cwd: resolveSessionCwd(ctx, sessionId) }),
                },
                Summary,
              ),
            )

            // A row in the workspace sidebar, plus the page it selects.
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                { name: 'sidebar.panellist', id: NS, order: 20, locale: NS, label: () => LABEL },
                SidebarEntry,
              ),
            )
            ctx.slots.inject('main', () =>
              ctx.slots.register({ name: 'main', key: NS, locale: NS }, Summary),
            )
          } catch (err) {
            console.warn('[dsh-context-manager] could not register savings surfaces:', String((err && err.message) || err))
          }
        })
      },
    }
  },
})
