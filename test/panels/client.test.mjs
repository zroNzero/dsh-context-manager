// Client-side test: run assets/panel.js inside a real DOM (jsdom) and assert
// what the pet actually shows.
//
// The important assertions are not cosmetic: panel text must arrive through
// textContent (so a hostile producer string can never become markup), an empty
// panel must say 暂无数据, and neither the polling nor the streaming path may
// throw when the host is unreachable.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'

import { INDEX_ROW_TEXT } from '../../panels/plugin.js'

const SCRIPT = fs.readFileSync(new URL('../../assets/panel.js', import.meta.url), 'utf8')

const openWindows = []
after(() => {
  for (const window of openWindows) {
    try {
      window.close()
    } catch (err) {}
  }
})

const snapshot = {
  ok: true,
  v: 1,
  now: new Date().toISOString(),
  revision: 7,
  panels: [
    {
      v: 1,
      id: 'token-savings',
      producer: 'dsh-context-manager',
      kind: 'metric',
      title: 'Token 节省',
      status: 'ok',
      ttlMs: 900_000,
      priority: 8,
      order: 10,
      updatedAt: new Date().toISOString(),
      ageMs: 1000,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      payload: {
        value: 197531,
        unit: 'tokens',
        label: '累计节省',
        items: [
          { label: 'fold', value: 160610 },
          { label: 'schema', value: 32448 },
        ],
        note: '2 分钟前更新 · 14 事件',
      },
    },
  ],
}

function makeWindow(fetchImpl, options = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'http://127.0.0.1:59989/',
  })
  const window = dom.window
  openWindows.push(window)

  // jsdom has no layout engine: give the pet a plausible rect.
  const whale = window.document.createElement('div')
  whale.className = 'dshwv-root'
  whale.getBoundingClientRect = () => ({ left: 1100, top: 700, right: 1200, bottom: 800, width: 100, height: 100, x: 1100, y: 700 })
  window.document.body.appendChild(whale)

  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true })

  if (fetchImpl) {
    window.fetch = fetchImpl
  } else {
    window.fetch = () => Promise.reject(new Error('offline'))
  }
  if (options.EventSource) window.EventSource = options.EventSource

  window.eval(SCRIPT)
  return { window, whale }
}

const flush = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

test('renders the token panel: title, total with ratio, money, and nothing else', async () => {
  const doc = {
    ...snapshot,
    panels: [
      {
        ...snapshot.panels[0],
        payload: {
          value: 197531,
          unit: 'tokens',
          label: '今日节省',
          percent: { value: 61.4 },
          moneyText: '省钱 ¥0.6514',
          // A stale producer may still ship the breakdown; the renderer must ignore it.
          items: [
            { label: 'schema', value: 32448, percent: 40 },
            { label: 'fold', value: 160610 },
          ],
          rate: { percent: 3.3, label: '本轮' },
          note: '2 分钟前更新 · 14 事件',
        },
      },
    ],
  }
  const { window } = makeWindow(() => Promise.resolve({ json: () => Promise.resolve(doc) }))
  await flush(60)

  const layer = window.document.querySelector('.dshwp-layer')
  assert.ok(layer, 'the panel layer must be mounted')
  const card = layer.querySelector('.dshwp-card')
  assert.ok(card, 'a card must be rendered')

  assert.equal(card.querySelector('.dshwp-title').textContent, 'Token 节省')
  assert.equal(card.querySelector('.dshwp-value').textContent, '197,531tokens（-61.4%）')

  const rows = [...card.querySelectorAll('.dshwp-row')].map((row) => row.textContent)
  assert.deepEqual(rows, ['省钱 ¥0.6514'], 'only the money row survives')
  assert.equal(card.querySelector('.dshwp-note'), null, 'the note line is gone')
})

test('an empty panel renders 暂无数据 and the reason', async () => {
  const empty = {
    ...snapshot,
    panels: [
      {
        ...snapshot.panels[0],
        status: 'empty',
        payload: { emptyReason: '找不到 savings.json' },
      },
    ],
  }
  const { window } = makeWindow(() => Promise.resolve({ json: () => Promise.resolve(empty) }))
  await flush(60)
  const card = window.document.querySelector('.dshwp-card')
  assert.equal(card.querySelector('.dshwp-empty').textContent, '暂无数据')
  assert.match(card.querySelector('.dshwp-note').textContent, /找不到 savings\.json/)
})

test('panel text is never interpreted as HTML', async () => {
  const hostile = {
    ...snapshot,
    panels: [
      {
        ...snapshot.panels[0],
        title: '<img src=x onerror="window.__pwned=1">',
        payload: {
          value: 1,
          label: '<b>bold</b>',
          items: [{ label: '<script>window.__pwned=2</script>', value: 1 }],
          note: '<svg/onload=window.__pwned=3>',
        },
      },
    ],
  }
  const { window } = makeWindow(() => Promise.resolve({ json: () => Promise.resolve(hostile) }))
  await flush(60)
  const layer = window.document.querySelector('.dshwp-layer')
  assert.equal(layer.querySelectorAll('img, svg, b, script').length, 0, 'no element may come from panel text')
  assert.equal(window.__pwned, undefined)
  assert.match(layer.textContent, /<img src=x/)
})

test('the layer never captures pointer events, so dragging the pet still works', async () => {
  const { window } = makeWindow(() => Promise.resolve({ json: () => Promise.resolve(snapshot) }))
  await flush(60)
  const css = window.document.getElementById('dshwp-style').textContent
  assert.match(css, /\.dshwp-layer\{[^}]*pointer-events:none/)
  assert.match(css, /\.dshwp-card\{[^}]*pointer-events:none/)
})

test('the layer is anchored above the pet and clamped into the viewport', async () => {
  const { window } = makeWindow(() => Promise.resolve({ json: () => Promise.resolve(snapshot) }))
  await flush(80)
  const card = window.document.querySelector('.dshwp-card')
  const left = Number.parseInt(card.style.left, 10)
  assert.ok(Number.isFinite(left))
  assert.ok(left >= 8)
  assert.ok(left <= 1400 - 170 - 8)
})

test('a failed fetch keeps the last snapshot and does not throw', async () => {
  let call = 0
  const flaky = () => {
    call++
    if (call === 1) return Promise.resolve({ json: () => Promise.resolve(snapshot) })
    return Promise.reject(new Error('host restarting'))
  }
  const { window } = makeWindow(flaky)
  await flush(60)
  assert.ok(window.document.querySelector('.dshwp-card'))
  window.document.dispatchEvent(new window.Event('visibilitychange'))
  await flush(60)
  assert.ok(window.document.querySelector('.dshwp-card'), 'the panel must survive a failed poll')
  assert.ok(window.__dshSavingsPanels.debug().fails >= 1, 'the failure should be counted, not thrown')
})

test('expired panels disappear without any host call', async () => {
  const expired = {
    ...snapshot,
    panels: [{ ...snapshot.panels[0], expiresAt: new Date(Date.now() - 1000).toISOString() }],
  }
  const { window } = makeWindow(() => Promise.resolve({ json: () => Promise.resolve(expired) }))
  await flush(60)
  assert.equal(window.document.querySelector('.dshwp-card'), null)
})

test('toasts render and remove themselves', async () => {
  const withToast = {
    ...snapshot,
    panels: [
      ...snapshot.panels,
      {
        v: 1,
        id: 'toast',
        producer: 'plug',
        kind: 'toast',
        title: '提示',
        status: 'ok',
        ttlMs: 60_000,
        priority: 9,
        order: 0,
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        payload: { text: '已折叠 1200 tokens', durationMs: 1000, tone: 'info' },
      },
    ],
  }
  const { window } = makeWindow(() => Promise.resolve({ json: () => Promise.resolve(withToast) }))
  await flush(60)
  const toast = window.document.querySelector('[data-toast="1"]')
  assert.ok(toast, 'toast card should render')
  assert.match(toast.textContent, /已折叠 1200 tokens/)
  await flush(1200)
  assert.equal(window.document.querySelector('[data-toast="1"]'), null, 'toast should disappear')
})

test('the streaming path is preferred when EventSource exists', async () => {
  const instances = []
  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.listeners = {}
      instances.push(this)
    }
    addEventListener(name, fn) {
      this.listeners[name] = fn
    }
    close() {}
    emit(name, data) {
      if (this.listeners[name]) this.listeners[name]({ data: JSON.stringify(data) })
    }
  }

  const { window } = makeWindow(() => Promise.resolve({ json: () => Promise.resolve({ panels: [] }) }), { EventSource: FakeEventSource })
  await flush(40)
  assert.equal(instances.length, 1)
  assert.match(instances[0].url, /\/dsh-savings\/panels\/events$/)
  instances[0].emit('snapshot', snapshot)
  await flush(40)
  assert.equal(window.__dshSavingsPanels.debug().mode, 'sse')
  assert.ok(window.document.querySelector('.dshwp-card'))
})

test('without a pet on the page the client stays invisible', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true })
  const window = dom.window
  openWindows.push(window)
  window.fetch = () => Promise.resolve({ json: () => Promise.resolve(snapshot) })
  assert.doesNotThrow(() => window.eval(SCRIPT))
  await flush(60)
  const layer = window.document.querySelector('.dshwp-layer')
  assert.ok(layer, 'the layer still mounts')
  assert.equal(layer.style.display, 'none', 'but it stays hidden when the pet is missing')
  assert.equal(window.__dshSavingsPanels.debug().whale, false)
})

test('legacy breakdown fields are ignored, so no module rows are drawn', async () => {
  const withBreakdown = {
    ...snapshot,
    panels: [
      {
        ...snapshot.panels[0],
        payload: {
          value: 58070,
          unit: 'tokens',
          label: '今日节省',
          consumed: 900000,
          counterfactual: 958070,
          percent: { value: 6.5 },
          items: [
            { label: 'schema', value: 32000, percent: 40 },
            { label: 'fold', value: 910 },
          ],
          fold: 910,
          rate: { percent: 3.3, label: '本轮' },
        },
      },
    ],
  }
  const { window } = makeWindow(() => Promise.resolve({ json: () => Promise.resolve(withBreakdown) }))
  await flush(60)

  const card = window.document.querySelector('.dshwp-card')
  assert.deepEqual([...card.querySelectorAll('.dshwp-row')].map((row) => row.textContent), ['省钱 ¥0.0000'])
  assert.equal(card.querySelector('.dshwp-value').textContent, '58,070tokens（-6.5%）')
  assert.ok(card.querySelector('.dshwp-unit'), 'the unit stays next to the number')
})

test('a missing money text degrades to ¥0.0000 instead of hiding the row', async () => {
  const noMoney = {
    ...snapshot,
    panels: [
      {
        ...snapshot.panels[0],
        payload: { value: 0, unit: 'tokens', label: '今日节省', percent: { value: 0 } },
      },
    ],
  }
  const { window } = makeWindow(() => Promise.resolve({ json: () => Promise.resolve(noMoney) }))
  await flush(60)

  const card = window.document.querySelector('.dshwp-card')
  assert.deepEqual([...card.querySelectorAll('.dshwp-row')].map((row) => row.textContent), ['省钱 ¥0.0000'])
  assert.equal(card.querySelector('.dshwp-value').textContent, '0tokens（-0%）')
})
test('the collapsed chip reports the savings ratio when one is available', async () => {
  const withRate = {
    ...snapshot,
    panels: [
      {
        ...snapshot.panels[0],
        payload: { ...snapshot.panels[0].payload, rate: { percent: 10, label: '本轮' } },
      },
    ],
  }
  const { window } = makeWindow(() => Promise.resolve({ json: () => Promise.resolve(withRate) }))
  await flush(60)

  const card = window.document.querySelector('.dshwp-card')
  assert.equal(card.querySelector('.dshwp-pct').textContent, '（-10%）', 'the card prints the ratio next to the total')

  window.document.querySelector('.dshwp-toggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await flush(40)
  assert.equal(window.document.querySelector('.dshwp-toggle').textContent, '-10%', 'collapsed chip answers "how much did I save"')
})

test('the pet carries a toggle chip that collapses the stack and keeps the total', async () => {
  const { window } = makeWindow(() => Promise.resolve({ json: () => Promise.resolve(snapshot) }))
  await flush(60)
  const chip = window.document.querySelector('.dshwp-toggle')
  assert.ok(chip, 'a toggle chip must be mounted on the pet')
  assert.equal(chip.getAttribute('data-open'), '1')
  assert.equal(chip.textContent, '−')

  chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await flush(40)
  assert.equal(window.document.querySelectorAll('.dshwp-card').length, 0, 'cards collapse')
  assert.equal(window.document.querySelector('.dshwp-toggle').getAttribute('data-open'), '0')
  assert.equal(window.document.querySelector('.dshwp-toggle').textContent, '19.8 万', 'collapsed chip carries the total')
  assert.equal(window.localStorage.getItem('dshw-panels-visible'), '0')

  window.document.querySelector('.dshwp-toggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await flush(40)
  assert.equal(window.document.querySelectorAll('.dshwp-card').length, 1, 'cards come back')
  assert.equal(window.localStorage.getItem('dshw-panels-visible'), '1')
})

test('a persisted collapse survives a reload', async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'http://127.0.0.1:59989/',
  })
  const window = dom.window
  openWindows.push(window)
  window.localStorage.setItem('dshw-panels-visible', '0')
  const whale = window.document.createElement('div')
  whale.className = 'dshwv-root'
  whale.getBoundingClientRect = () => ({ left: 1100, top: 700, right: 1200, bottom: 800, width: 100, height: 100, x: 1100, y: 700 })
  window.document.body.appendChild(whale)
  window.fetch = () => Promise.resolve({ json: () => Promise.resolve(snapshot) })
  window.eval(SCRIPT)
  await flush(60)
  assert.equal(window.document.querySelectorAll('.dshwp-card').length, 0)
  assert.ok(window.document.querySelector('.dshwp-toggle'), 'the chip stays available to re-open')
})

test('loading the script twice does not mount twice', async () => {
  const { window } = makeWindow(() => Promise.resolve({ json: () => Promise.resolve(snapshot) }))
  await flush(60)
  window.eval(SCRIPT)
  await flush(20)
  assert.equal(window.document.querySelectorAll('.dshwp-layer').length, 1)
  assert.equal(window.document.querySelectorAll('style#dshwp-style').length, 1)
})

/* -------------------------------------------------------------------------- */
/* The desktop index row                                                      */
/* -------------------------------------------------------------------------- */

function runRow() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' })
  dom.window.eval(INDEX_ROW_TEXT)
  return dom
}

test('the desktop index row appends the panel client to the page', () => {
  const dom = runRow()
  const tags = dom.window.document.querySelectorAll('script[src="/dsh-savings/panel.js"]')
  assert.equal(tags.length, 1)
  assert.equal(tags[0].getAttribute('data-dshw-panels'), 'host')
  assert.equal(typeof tags[0].onerror, 'function', 'a failed route must not throw into the page')
})

test('the desktop index row is idempotent and respects an already-mounted panel layer', () => {
  const dom = runRow()
  assert.equal(dom.window.document.querySelectorAll('script[src="/dsh-savings/panel.js"]').length, 1)
  assert.doesNotThrow(() => dom.window.eval(INDEX_ROW_TEXT))
  assert.equal(dom.window.document.querySelectorAll('script[src="/dsh-savings/panel.js"]').length, 1, 'second run must not add another tag')

  const mounted = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' })
  mounted.window.__dshSavingsPanels = { mounted: true }
  mounted.window.eval(INDEX_ROW_TEXT)
  assert.equal(mounted.window.document.querySelectorAll('script[src="/dsh-savings/widget.js"]').length, 0)
})
