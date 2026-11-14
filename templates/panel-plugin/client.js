/**
 * 通用面板骨架 · 客户端半（DSH UI 插件的标准形状）
 *
 * 形状要求（宿主用 window.__ModuleLoader__ 加载 UI 半）：
 *   - 自注册到模块表，factory 末尾返回 module.exports；
 *   - 单文件：不能有相对路径 require，只能 require('react')；
 *   - 不能有顶层 import / export。
 *
 * 复用只改三处：
 *   1. PLUGIN_ID / PANEL_TITLE / PANEL_ORDER
 *   2. ROUTE（必须与 host 侧 PANEL_ROUTE 一致，客户端用相对地址）
 *   3. Page 里的取数与渲染
 */
window.__ModuleLoader__.load({
  id: 'my-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PLUGIN_ID = 'my-plugin'
    const PANEL_TITLE = '我的面板'
    const PANEL_ORDER = 40
    const ROUTE = 'api/my-plugin/summary'
    const POLL_MS = 5000

    /** 轮询取数：同一份 hook 可同时被独立页面与会话标签页复用。 */
    function useSummary() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(true)

      React.useEffect(function () {
        let alive = true
        let timer = null

        function fail(thrown) {
          if (!alive) return
          setError(String(thrown && thrown.message ? thrown.message : thrown))
          setLoading(false)
        }

        function tick() {
          let request
          try {
            request = fetch(ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            })
          } catch (thrown) {
            fail(thrown)
            return
          }
          request
            .then(function (response) {
              if (!response.ok) throw new Error('HTTP ' + response.status)
              return response.json()
            })
            .then(function (body) {
              if (!body || body.ok !== true) throw new Error('响应缺少 ok')
              if (!alive) return
              setData(body)
              setError('')
              setLoading(false)
            })
            .catch(fail)
        }

        tick()
        timer = setInterval(tick, POLL_MS)
        return function () {
          alive = false
          if (timer !== null) clearInterval(timer)
        }
      }, [])

      return { data: data, error: error, loading: loading }
    }

    function Card(props) {
      return h(
        'div',
        { className: 'skel-card' },
        h('div', { className: 'skel-card-label' }, props.label),
        h('div', { className: 'skel-card-value' }, props.value),
        props.hint ? h('div', { className: 'skel-card-hint' }, props.hint) : null,
      )
    }

    function Page() {
      const state = useSummary()
      const data = state.data

      if (data === null) {
        return h(
          'div',
          { className: 'skel-root' },
          h('div', { className: 'skel-title' }, PANEL_TITLE),
          h('div', { className: 'skel-note' }, state.error ? '面板数据不可用：' + state.error : '加载中…'),
          h('div', { className: 'skel-note' }, '请求地址：POST ' + ROUTE),
        )
      }

      return h(
        'div',
        { className: 'skel-root' },
        h('div', { className: 'skel-title' }, PANEL_TITLE),
        h('div', { className: 'skel-note' }, '起算：' + String(data.since || '—')),
        h(
          'div',
          { className: 'skel-cards' },
          h(Card, { label: '示例指标', value: String(data.value == null ? '—' : data.value) }),
          h(Card, { label: '请求次数', value: String(data.turns == null ? '—' : data.turns) }),
        ),
      )
    }

    /** 左侧栏图标：只吃 props.size，颜色/描边交给 shell 的 currentColor。 */
    function Icon(props) {
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
        },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }),
        h('path', { d: 'M7 10h10M7 14h6' }),
      )
    }

    const CSS_ID = 'dsh-skel-panel-css'
    function injectCss() {
      if (document.getElementById(CSS_ID) !== null) return function () {}
      const tag = document.createElement('style')
      tag.id = CSS_ID
      tag.dataset.plugin = PLUGIN_ID
      tag.textContent = [
        '.skel-root{display:flex;flex-direction:column;gap:12px;padding:18px 20px;font-size:13px}',
        '.skel-title{font-size:16px;font-weight:700}',
        '.skel-note{font-size:12px;opacity:.68}',
        '.skel-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}',
        '.skel-card{display:flex;flex-direction:column;gap:4px;padding:12px 14px;border:1px solid rgba(128,128,128,.24);border-radius:10px}',
        '.skel-card-label{font-size:12px;opacity:.7}',
        '.skel-card-value{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}',
        '.skel-card-hint{font-size:11px;opacity:.55}',
      ].join('\n')
      document.head.appendChild(tag)
      return function () {
        tag.remove()
      }
    }

    function apply(ctx) {
      ctx.effect(injectCss, PLUGIN_ID + ': styles')

      // 顺序固定：先 main 再 sidebar.panellist，否则首帧点击会切到空白页。
      // main 是 keyed slot（scope root），只认 key，不要写 id / order。
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PLUGIN_ID }, function () {
          return h(Page)
        })
      })

      // 左侧栏条目：id 必须等于 main 的 key，点击由 shell 转成 selectPanel(id)。
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PLUGIN_ID,
            order: PANEL_ORDER,
            label: function () {
              return PANEL_TITLE
            },
          },
          function (props) {
            return h(Icon, { size: props && props.size })
          },
        )
      })

      // 可选：会话内标签页（与「对话 / 上下文 / 编队」并列）。
      // id 用自己的名字：新 id 并列新增一格；复用已占用的 id 会替换那一格。
      // label 传函数，切换语言时会被重新求值；order 留间隔（10/20/30/40）。
      //
      // ctx.slots.inject('conversation.view', function () {
      //   return ctx.slots.register(
      //     {
      //       name: 'conversation.view',
      //       id: PLUGIN_ID + '-tab',
      //       order: 40,
      //       label: function () {
      //         return PANEL_TITLE
      //       },
      //     },
      //     function (props) {
      //       return h(Page, props)
      //     },
      //   )
      // })
    }

    const module = { exports: {} }
    module.exports = { name: PLUGIN_ID, inject: ['slots'], apply: apply }
    return module.exports
  },
})
