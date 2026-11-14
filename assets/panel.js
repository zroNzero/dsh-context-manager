/*
 * dsh-context-manager savings panel layer (client).
 *
 * Loaded only when the panel feature flag is on: the host appends a bootstrap
 * to /dsh-savings/widget.js that injects this file. When the flag is off this
 * file is never requested and the whale is byte-for-byte the old widget.
 *
 * Contract with the host (docs/PANEL-PROTOCOL.md):
 *   GET /dsh-savings/panels.json          snapshot
 *   GET /dsh-savings/panels/events        SSE frames {reason, v, now, revision, panels}
 *
 * Rendering rules that are not negotiable:
 *   - every string reaches the DOM through textContent; never innerHTML;
 *   - the layer is pointer-events:none, so dragging, clicking, and the size
 *     buttons keep working exactly as before;
 *   - a failure here can only hide the panel layer, never throw into the page
 *     or stop the whale's own timers.
 */
(function () {
  'use strict'

  if (window.__dshSavingsPanels) return
  var GUARD = { version: 1, mounted: false, mode: 'idle' }

  var SNAPSHOT_URL = '/dsh-savings/panels.json'
  var EVENTS_URL = '/dsh-savings/panels/events'
  var POLL_MS = 10000
  var SSE_WATCHDOG_MS = 25000
  var MAX_RENDER = 4
  var VIS_KEY = 'dshw-panels-visible'

  function readVisibility() {
    try {
      var stored = window.localStorage ? window.localStorage.getItem(VIS_KEY) : null
      if (stored === '0') return false
      if (stored === '1') return true
    } catch (err) {}
    return true
  }

  function writeVisibility(value) {
    try {
      if (window.localStorage) window.localStorage.setItem(VIS_KEY, value ? '1' : '0')
    } catch (err) {}
  }

  var state = {
    panels: [],
    revision: -1,
    now: 0,
    receivedAt: 0,
    lastFailureAt: 0,
    fails: 0,
    timer: null,
    es: null,
    watchdog: null,
    layoutFrame: null,
    renderHash: '',
    whale: null,
    watching: false,
    // Per-page visibility of the panel stack, toggled by the chip on the pet.
    visible: readVisibility(),
  }

  function safe(fn) {
    try {
      return fn()
    } catch (err) {
      return undefined
    }
  }

  function isObject(v) {
    return v !== null && typeof v === 'object'
  }

  function text(value) {
    if (typeof value === 'string') return value
    if (value === null || value === undefined) return ''
    return String(value)
  }

  function formatNumber(value) {
    var num = Number(value)
    if (!isFinite(num)) return '--'
    var negative = num < 0
    var abs = Math.abs(num)
    var fixed = abs >= 100 ? Math.round(abs).toString() : (Math.round(abs * 100) / 100).toString()
    var parts = fixed.split('.')
    var whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    var out = parts.length > 1 ? whole + '.' + parts[1] : whole
    return negative ? '-' + out : out
  }

  function make(tag, className) {
    var node = document.createElement(tag)
    if (className) node.className = className
    return node
  }

  /* ------------------------------------------------------------------------ */
  /* Styles                                                                   */
  /* ------------------------------------------------------------------------ */

  function installStyles() {
    if (document.getElementById('dshwp-style')) return
    var css = [
      '.dshwp-layer{position:fixed;left:0;top:0;width:0;height:0;z-index:9998;pointer-events:none;font-family:inherit;color:#536ba9}',
      '.dshwp-card{position:absolute;box-sizing:border-box;background:rgba(255,255,255,.96);border:2px solid #dfe8fb;border-radius:14px;padding:8px 10px;box-shadow:0 6px 18px rgba(83,107,169,.18);pointer-events:none;overflow:hidden}',
      '.dshwp-card.dshwp-toast{background:#536ba9;border-color:#536ba9;color:#fff;border-radius:12px;padding:6px 10px;max-width:230px}',
      '.dshwp-title{font-size:12px;font-weight:700;letter-spacing:.04em;line-height:1.2;margin-bottom:4px;color:#536ba9}',
      '.dshwp-card.dshwp-toast .dshwp-title{display:none}',
      '.dshwp-value{font-size:17px;font-weight:800;line-height:1.15;letter-spacing:.02em;word-break:break-all}',
      '.dshwp-value .dshwp-unit{font-size:10px;font-weight:600;margin-left:3px;color:#8fa2cf}',
      '.dshwp-value .dshwp-pct{font-size:10px;font-weight:700;margin-left:2px;color:#2f9e6b}',
      '.dshwp-sublabel{font-size:10px;font-weight:600;color:#8fa2cf;margin:-1px 0 4px}',
      '.dshwp-row{display:flex;justify-content:space-between;gap:8px;font-size:10px;line-height:1.45;font-variant-numeric:tabular-nums}',
      '.dshwp-row .dshwp-row-label{color:#6b7fae;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshwp-row .dshwp-row-value{font-weight:700;color:#536ba9;white-space:nowrap}',
      '.dshwp-note{font-size:9px;color:#9fb0d9;margin-top:4px;line-height:1.3}',
      '.dshwp-empty{font-size:11px;font-weight:700;color:#9fb0d9;line-height:1.3}',
      '.dshwp-lines{font-size:10px;line-height:1.45;color:#536ba9;word-break:break-word}',
      '.dshwp-more{font-size:9px;color:#9fb0d9;margin-top:2px}',
      '.dshwp-rate{display:inline-block;font-size:9px;font-weight:700;color:#2f9e6b;background:#eaf7f0;border-radius:8px;padding:1px 6px;margin:2px 0 4px}',
      '.dshwp-toggle{position:absolute;box-sizing:border-box;min-width:22px;height:20px;padding:0 6px;border:2px solid #dfe8fb;border-radius:10px;background:rgba(255,255,255,.96);color:#536ba9;font-size:10px;font-weight:700;line-height:16px;text-align:center;pointer-events:auto;cursor:pointer;box-shadow:0 2px 8px rgba(83,107,169,.18);user-select:none;white-space:nowrap}',
      '.dshwp-toggle:hover{background:#eef3ff}',
    ].join('\n')
    var style = make('style')
    style.id = 'dshwp-style'
    style.textContent = css
    ;(document.head || document.documentElement).appendChild(style)
  }

  /* ------------------------------------------------------------------------ */
  /* Rendering                                                                */
  /* ------------------------------------------------------------------------ */

  function renderPanel(panel) {
    var card = make('div', 'dshwp-card')
    if (panel.kind === 'toast') card.className += ' dshwp-toast'

    if (panel.kind !== 'toast') {
      var title = make('div', 'dshwp-title')
      title.textContent = text(panel.title)
      card.appendChild(title)
    }

    if (panel.status === 'empty') {
      var empty = make('div', 'dshwp-empty')
      empty.textContent = '暂无数据'
      card.appendChild(empty)
      var reason = isObject(panel.payload) ? text(panel.payload.emptyReason) : ''
      if (reason) {
        var reasonEl = make('div', 'dshwp-note')
        reasonEl.textContent = reason
        card.appendChild(reasonEl)
      }
      return card
    }

    var payload = isObject(panel.payload) ? panel.payload : {}

    if (panel.kind === 'metric') {
      var value = make('div', 'dshwp-value')
      value.textContent = formatNumber(payload.value)
      if (payload.unit) {
        var unit = make('span', 'dshwp-unit')
        unit.textContent = text(payload.unit)
        value.appendChild(unit)
      }
      // The savings ratio belongs next to the number, not only in the detail
      // surface: "省了 10%" is the question the card answers. A whole-period
      // ratio (percent) beats the per-turn rate (rate) when both exist.
      var ratio = ratioOf(payload)
      if (ratio !== null) {
        var pct = make('span', 'dshwp-pct')
        pct.textContent = '（-' + formatNumber(ratio) + '%' + (payload.percent && payload.percent.estimate ? '，估算' : '') + '）'
        value.appendChild(pct)
      }
      card.appendChild(value)
      // 只有一行钱：文本由下发层拼好，渲染层不重算、不翻译单位。
      // 金额缺失（干净纪元刚开始）也要显示 ¥0.0000，不能整行消失。
      var moneyText =
        typeof payload.moneyText === 'string' && payload.moneyText ? payload.moneyText : '省钱 ¥0.0000'
      var moneyRow = make('div', 'dshwp-row dshwp-money-row')
      var moneyVal = make('span', 'dshwp-row-value dshwp-money-value')
      moneyVal.textContent = moneyText
      moneyRow.appendChild(moneyVal)
      card.appendChild(moneyRow)
      return card
    }

    if (panel.kind === 'progress') {
      var label2 = make('div', 'dshwp-sublabel')
      label2.textContent = text(payload.label) || text(panel.title)
      card.appendChild(label2)
      var pct = payload.max > 0 ? Math.round((payload.value / payload.max) * 100) : 0
      var bar = make('div', 'dshwp-value')
      bar.textContent = pct + '%'
      card.appendChild(bar)
      var detail = make('div', 'dshwp-note')
      detail.textContent = formatNumber(payload.value) + ' / ' + formatNumber(payload.max)
      card.appendChild(detail)
      return card
    }

    if (panel.kind === 'badge') {
      var badge = make('div', 'dshwp-value')
      badge.textContent = text(payload.text)
      card.appendChild(badge)
      return card
    }

    if (panel.kind === 'list') {
      appendItems(card, payload.items)
      return card
    }

    if (panel.kind === 'text') {
      var lines = make('div', 'dshwp-lines')
      var list = Array.isArray(payload.lines) ? payload.lines : []
      for (var i = 0; i < list.length; i++) {
        var line = make('div')
        line.textContent = text(list[i])
        lines.appendChild(line)
      }
      card.appendChild(lines)
      return card
    }

    if (panel.kind === 'toast') {
      var toast = make('div', 'dshwp-value')
      toast.textContent = text(payload.text)
      card.appendChild(toast)
      return card
    }

    return card
  }

  function sumItemValues(items) {
    if (!Array.isArray(items)) return 0
    var total = 0
    for (var i = 0; i < items.length; i++) {
      var item = items[i]
      if (!isObject(item) || typeof item.value !== 'number') continue
      total += item.value
    }
    return total
  }

  /** Whole-period ratio first, then the per-turn rate. */
  function ratioOf(payload) {
    if (isObject(payload.percent) && typeof payload.percent.value === 'number') return payload.percent.value
    if (isObject(payload.rate) && typeof payload.rate.percent === 'number') return payload.rate.percent
    return null
  }

  function appendItems(card, items, shareBase) {
    if (!Array.isArray(items)) return
    for (var i = 0; i < items.length; i++) {
      var item = items[i]
      if (!isObject(item)) continue
      var row = make('div', 'dshwp-row')
      var key = make('span', 'dshwp-row-label')
      key.textContent = text(item.label)
      var val = make('span', 'dshwp-row-value')
      var valueText = item.value === undefined || item.value === null
        ? ''
        : (typeof item.value === 'number' ? formatNumber(item.value) : text(item.value))
      if (typeof item.percent === 'number') {
        // "saved 50% of what this dimension used to cost"
        valueText += '  -' + formatNumber(item.percent) + '%'
      }
      val.textContent = valueText
      row.appendChild(key)
      row.appendChild(val)
      card.appendChild(row)
    }
  }

  function visiblePanels(at) {
    var out = []
    for (var i = 0; i < state.panels.length; i++) {
      var panel = state.panels[i]
      if (!isObject(panel)) continue
      var expires = Date.parse(panel.expiresAt)
      if (isFinite(expires) && expires < at) continue
      out.push(panel)
    }
    return out
  }

  function toastDuration(panel) {
    var ms = isObject(panel.payload) ? Number(panel.payload.durationMs) : NaN
    if (!isFinite(ms) || ms < 1000) ms = 4500
    return Math.min(15000, ms)
  }

  function render() {
    if (!state.layer) return
    var at = Date.now()
    var panels = visiblePanels(at)
    var shown = []
    var toasts = []
    for (var i = 0; i < panels.length; i++) {
      if (panels[i].kind === 'toast') {
        toasts.push(panels[i])
      } else if (shown.length < MAX_RENDER) {
        shown.push(panels[i])
      }
    }

    renderToggle(panels, shown)

    if (!state.visible) {
      // Collapsed: the chip alone stays on the pet and carries the headline
      // number, so the total is never lost.
      clearLayer()
      state.renderHash = ''
      layout()
      return
    }

    var hash = JSON.stringify([at - (at % 30000), shown, toasts.map(function (t) { return t.updatedAt + t.id })])
    if (hash === state.renderHash) return
    state.renderHash = hash

    clearLayer()

    for (var s = 0; s < shown.length; s++) {
      var card = renderPanel(shown[s])
      card.setAttribute('data-panel', text(shown[s].id))
      state.layer.appendChild(card)
    }
    if (shown.length > 0 && panels.length - toasts.length > shown.length) {
      var more = make('div', 'dshwp-more')
      more.textContent = '+' + (panels.length - toasts.length - shown.length) + ' 个面板'
      state.layer.appendChild(more)
    }
    for (var t = 0; t < toasts.length; t++) {
      var toast = renderPanel(toasts[t])
      toast.setAttribute('data-panel', text(toasts[t].id))
      toast.setAttribute('data-toast', '1')
      state.layer.appendChild(toast)
      scheduleToastRemoval(toast, toastDuration(toasts[t]))
    }
    if (state.toggle) state.layer.appendChild(state.toggle)

    layout()
  }

  /** Remove every card but keep the toggle chip. */
  function clearLayer() {
    var children = state.layer.children
    for (var i = children.length - 1; i >= 0; i--) {
      var node = children[i]
      if (node === state.toggle) continue
      state.layer.removeChild(node)
    }
  }

  function compactNumber(value) {
    var num = Number(value)
    if (!isFinite(num)) return '--'
    var abs = Math.abs(num)
    if (abs >= 100000000) return (Math.round(num / 10000000) / 10) + ' 亿'
    if (abs >= 10000) return (Math.round(num / 1000) / 10) + ' 万'
    return formatNumber(num)
  }

  /**
   * The chip on the pet: shows the headline total while collapsed and a
   * collapse control while expanded. Its label is built from the first metric
   * panel, so a different headline producer needs no client change.
   */
  function renderToggle(panels, shown) {
    if (!state.toggle) return
    var headline = shown[0] || panels[0] || null
    var label
    if (state.visible) {
      label = '−'
      state.toggle.setAttribute('title', '收起面板')
      state.toggle.setAttribute('aria-label', '收起面板')
    } else {
      var summary = '--'
      if (headline && headline.status === 'ok' && isObject(headline.payload)) {
        // Collapsed, the chip answers "how much did I save": the ratio when the
        // producer reports one, otherwise the absolute figure.
        var ratio = ratioOf(headline.payload)
        if (ratio !== null) {
          summary = '-' + formatNumber(ratio) + '%'
        } else if (typeof headline.payload.value === 'number') {
          summary = compactNumber(headline.payload.value)
        }
      }
      label = summary
      state.toggle.setAttribute('title', '展开面板')
      state.toggle.setAttribute('aria-label', '展开面板')
    }
    if (state.toggle.textContent !== label) state.toggle.textContent = label
    state.toggle.setAttribute('data-open', state.visible ? '1' : '0')
  }

  function toggleVisible() {
    state.visible = !state.visible
    writeVisibility(state.visible)
    state.renderHash = ''
    render()
    scheduleLayout()
  }

  function scheduleToastRemoval(node, ms) {
    setTimeout(function () {
      safe(function () {
        if (node.parentNode) node.parentNode.removeChild(node)
      })
      scheduleLayout()
    }, ms)
  }

  /* ------------------------------------------------------------------------ */
  /* Layout: glue the cards to the pet                                        */
  /* ------------------------------------------------------------------------ */

  function findWhale() {
    var whale = document.querySelector ? document.querySelector('.dshwv-root') : null
    return whale || null
  }

  function layout() {
    if (!state.layer) return
    var whale = state.whale || findWhale()
    state.whale = whale
    if (!whale || typeof whale.getBoundingClientRect !== 'function') {
      hideLayer()
      return
    }
    var rect = whale.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) {
      hideLayer()
      return
    }
    state.layer.style.display = ''

    var vw = window.innerWidth || document.documentElement.clientWidth || 1280
    var vh = window.innerHeight || document.documentElement.clientHeight || 800
    var width = Math.round(Math.max(170, Math.min(300, rect.width * 1.1)))

    // Order for stacking: ordinary panels first, then transient toasts, so a
    // toast always sits closest to the pet.
    var normal = []
    var toasts = []
    var children = state.layer.children
    for (var i = 0; i < children.length; i++) {
      var node = children[i]
      if (node === state.toggle) continue
      var isToast = node.getAttribute && node.getAttribute('data-toast') === '1'
      node.style.width = (isToast ? Math.min(230, width) : width) + 'px'
      if (isToast) toasts.push(node)
      else normal.push(node)
    }

    // The chip always hugs the pet's top-right corner.
    if (state.toggle) {
      var chipWidth = state.toggle.offsetWidth || 24
      var chipLeft = Math.round(rect.right - chipWidth - 2)
      chipLeft = Math.max(4, Math.min(vw - chipWidth - 4, chipLeft))
      var chipTop = Math.round(rect.top - 24)
      if (chipTop < 4) chipTop = Math.round(rect.top + 4)
      state.toggle.style.left = chipLeft + 'px'
      state.toggle.style.top = chipTop + 'px'
    }

    var stack = normal.concat(toasts)
    if (stack.length === 0) return

    var GAP = 6
    var total = 0
    for (var m = 0; m < stack.length; m++) total += stack[m].offsetHeight + (m > 0 ? GAP : 0)

    var margin = 10
    var top = rect.top - total - margin
    if (top < 8) top = rect.bottom + margin
    if (top + total > vh - 8) top = Math.max(8, vh - 8 - total)

    var left = Math.round(rect.left + rect.width / 2 - width / 2)
    left = Math.max(8, Math.min(vw - width - 8, left))

    var cursor = top
    for (var k = 0; k < stack.length; k++) {
      var item = stack[k]
      item.style.left = left + 'px'
      item.style.top = cursor + 'px'
      cursor += item.offsetHeight + GAP
    }
  }

  function hideLayer() {
    if (state.layer) state.layer.style.display = 'none'
  }

  function scheduleLayout() {
    if (state.layoutFrame !== null) return
    state.layoutFrame = requestAnimationFrame(function () {
      state.layoutFrame = null
      safe(layout)
    })
  }

  function watchWhale() {
    if (state.watching) return
    state.whale = findWhale()
    if (!state.whale) return
    state.watching = true
    var observer = new MutationObserver(function () {
      state.whale = findWhale()
      scheduleLayout()
    })
    safe(function () {
      observer.observe(state.whale, { attributes: true, attributeFilter: ['style', 'class'] })
    })
    safe(function () {
      var ro = new ResizeObserver(function () { scheduleLayout() })
      ro.observe(state.whale)
      state.resizeObserver = ro
    })
  }

  /* ------------------------------------------------------------------------ */
  /* Data                                                                     */
  /* ------------------------------------------------------------------------ */

  function applySnapshot(doc, channel) {
    if (!isObject(doc)) return
    if (Array.isArray(doc.panels)) {
      if (typeof doc.revision === 'number' && doc.revision === state.revision && channel === 'poll') {
        return
      }
      state.panels = doc.panels
      state.revision = typeof doc.revision === 'number' ? doc.revision : state.revision
      state.receivedAt = Date.now()
      state.fails = 0
      state.mode = channel
      GUARD.mode = channel
      GUARD.panels = state.panels.length
      render()
    }
  }

  function fetchSnapshot() {
    if (typeof fetch !== 'function') return
    var options = { cache: 'no-store', headers: { accept: 'application/json' } }
    safe(function () {
      if (typeof AbortController === 'function') {
        var ctrl = new AbortController()
        options.signal = ctrl.signal
        setTimeout(function () { safe(function () { ctrl.abort() }) }, 8000)
      }
    })
    safe(function () {
      fetch(SNAPSHOT_URL, options)
        .then(function (res) { return res.json() })
        .then(function (doc) {
          applySnapshot(doc, 'poll')
        })
        .catch(function () {
          state.fails++
          state.lastFailureAt = Date.now()
          // Keep the last snapshot on screen: a single failed poll is normal
          // while the host restarts. Cards disappear on their own once their
          // expiresAt passes.
        })
    })
  }

  function startPolling() {
    if (state.timer !== null) return
    fetchSnapshot()
    state.timer = setInterval(fetchSnapshot, POLL_MS)
  }

  function stopPolling() {
    if (state.timer === null) return
    clearInterval(state.timer)
    state.timer = null
  }

  function startEvents() {
    if (typeof window.EventSource !== 'function') {
      startPolling()
      return
    }
    var es
    try {
      es = new window.EventSource(EVENTS_URL)
    } catch (err) {
      startPolling()
      return
    }
    state.es = es
    state.mode = 'sse'
    GUARD.mode = 'sse'

    function onFrame(event) {
      if (state.watchdog !== null) {
        clearTimeout(state.watchdog)
        state.watchdog = null
      }
      stopPolling()
      var payload
      try {
        payload = JSON.parse(event.data)
      } catch (err) {
        return
      }
      applySnapshot(payload, 'sse')
    }

    safe(function () { es.addEventListener('snapshot', onFrame) })
    safe(function () { es.addEventListener('panels', onFrame) })
    safe(function () {
      es.addEventListener('error', function () {
        // EventSource retries on its own; poll meanwhile so the pet never
        // goes blank just because the stream is unhealthy.
        startPolling()
      })
    })
    // A buffering proxy can hold the stream open with no frames; fall back to
    // polling rather than trusting a dead-looking surface.
    state.watchdog = setTimeout(function () {
      state.watchdog = null
      if (state.receivedAt === 0) startPolling()
    }, SSE_WATCHDOG_MS)
  }

  /* ------------------------------------------------------------------------ */
  /* Boot                                                                     */
  /* ------------------------------------------------------------------------ */

  function tick() {
    // Expire panels locally and re-glue the layer when the pet moves.
    render()
    watchWhale()
    scheduleLayout()
  }

  function boot() {
    if (state.mounted) return
    state.mounted = true
    GUARD.mounted = true

    installStyles()

    var layer = make('div', 'dshwp-layer')
    layer.setAttribute('data-dshw-panels', '1')
    ;(document.body || document.documentElement).appendChild(layer)
    state.layer = layer

    var toggle = make('div', 'dshwp-toggle')
    toggle.setAttribute('data-dshw-panels', 'toggle')
    toggle.setAttribute('role', 'button')
    toggle.setAttribute('tabindex', '0')
    toggle.addEventListener('click', function (event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
      safe(toggleVisible)
    })
    toggle.addEventListener('keydown', function (event) {
      if (!event || (event.key !== 'Enter' && event.key !== ' ')) return
      if (typeof event.preventDefault === 'function') event.preventDefault()
      safe(toggleVisible)
    })
    layer.appendChild(toggle)
    state.toggle = toggle

    if (typeof window.addEventListener === 'function') {
      window.addEventListener('resize', scheduleLayout)
      window.addEventListener('orientationchange', scheduleLayout)
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') return
        fetchSnapshot()
        scheduleLayout()
      })
    }

    startEvents()
    // The SSE path only polls on demand; this timer keeps expiry honest and
    // re-anchors the layer if the pet was replaced (e.g. HMR of the widget).
    setInterval(tick, 5000)
    tick()
  }

  GUARD.debug = function () {
    return {
      mode: state.mode,
      panels: state.panels.length,
      revision: state.revision,
      receivedAt: state.receivedAt,
      fails: state.fails,
      whale: Boolean(state.whale),
    }
  }

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { safe(boot) })
    } else {
      safe(boot)
    }
  } catch (err) {
    GUARD.error = String((err && err.message) || err)
  }

  window.__dshSavingsPanels = GUARD
})()
