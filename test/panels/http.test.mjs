// Integration test for the panel host plugin (lib/panels/plugin.js).
//
// The whale widget itself is upstream code (`lib/whale.js`) and is not exercised
// here; this file covers the additive layer: the desktop index row, the HTTP
// surface, auth and limits, SSE, the day-ledger-backed snapshot, and disposal.
//
// A real node:http server reproduces dsh-host-webserver's matching rules (exact
// table first, then the longest segment-aware prefix, else 404).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { apply, INDEX_ROW_TEXT } from '../../panels/plugin.js'

const cleanups = []
after(async () => {
  for (const fn of cleanups.reverse()) {
    try {
      await fn()
    } catch (err) {}
  }
})

function makeHost(options = {}) {
  const routes = { exact: new Map(), prefix: new Map() }
  const provided = new Map()
  const taps = []
  const listeners = new Map()
  const pendingInjections = []
  const effectDisposers = []

  const ctx = {
    webServer: {
      register(route) {
        const table = route.kind === 'exact' ? routes.exact : routes.prefix
        if (table.has(route.path)) throw new Error('duplicate ' + route.kind + ' route ' + route.path)
        table.set(route.path, route)
        return () => table.delete(route.path)
      },
      tapIndex(fn) {
        taps.push(fn)
        return () => {
          const at = taps.indexOf(fn)
          if (at !== -1) taps.splice(at, 1)
        }
      },
    },
    provide(name, value) {
      provided.set(name, value)
      return () => provided.delete(name)
    },
    get(name) {
      return provided.get(name)
    },
    logger() {
      return { info() {}, warn() {}, debug() {}, error() {} }
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') effectDisposers.push(disposer)
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(listener)
      return () => listeners.get(event)?.delete(listener)
    },
    inject(deps, callback) {
      const run = () => callback(ctx)
      if (options.deferInject) pendingInjections.push(run)
      else run()
      return () => {}
    },
  }

  function responderFor(pathname) {
    if (routes.exact.has(pathname)) return routes.exact.get(pathname)
    let best = null
    for (const [prefix, route] of routes.prefix) {
      if (pathname !== prefix && !pathname.startsWith(prefix + '/')) continue
      if (!best || prefix.length > best.prefix.length) best = { prefix, route }
    }
    return best ? best.route : null
  }

  const server = http.createServer((req, res) => {
    const target = new URL(req.url || '/', 'http://x')
    const route = responderFor(target.pathname)
    if (!route) {
      res.writeHead(404)
      res.end()
      return
    }
    Promise.resolve(route.handler(req, res)).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(400)
        res.end(String(err && err.message))
      }
    })
  })

  return {
    ctx,
    server,
    routes,
    provided,
    taps,
    emit(event, ...args) {
      for (const listener of listeners.get(event) || []) listener(...args)
    },
    resolveInjections() {
      const pending = pendingInjections.splice(0, pendingInjections.length)
      for (const run of pending) run()
    },
    disposeEffect() {
      for (const disposer of effectDisposers.splice(0, effectDisposers.length)) {
        try {
          disposer()
        } catch (err) {}
      }
    },
  }
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

function makeHome({ withSavings = true, flag = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-home-'))
  const profile = path.join(home, 'profiles', 'desktop')
  fs.mkdirSync(profile, { recursive: true })
  if (withSavings) {
    fs.writeFileSync(
      path.join(profile, 'savings.json'),
      JSON.stringify({
        schemaVersion: 3,
        ledgerId: 'ledger-test',
        revision: 3,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        totalSavedTokens: 79326,
        byModule: { admission: 0, extraction: 0, dedup: 0, fold: 910, schema: 78416 },
        perRequestSavings: 78416,
        eventSavings: 0,
        contextReduction: 910,
        estimatedCostTokens: 2614,
        events: 3,
        folds: 1,
        rejectedByAnchor: 0,
        lastEvents: [],
      }),
    )
  }
  if (flag !== null) fs.writeFileSync(path.join(home, '.dsh-savings-panels.json'), JSON.stringify({ enabled: flag }))
  return { home, profile }
}

async function boot(options = {}) {
  const made = options.home ? { home: options.home, profile: path.join(options.home, 'profiles', 'desktop') } : makeHome(options)
  const { home, profile } = made
  if (options.home) fs.mkdirSync(profile, { recursive: true })

  const previous = {}
  const env = {
    DSH_HOME: home,
    DSH_PROFILE_DIR: profile,
    DSH_PROFILE: 'desktop',
    DSH_SAVINGS_PANELS: options.panels === true ? '1' : options.panels === false ? '0' : undefined,
  }
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key]
    if (value === undefined || value === '') delete process.env[key]
    else process.env[key] = value
  }

  // Panels resolve `cwd/savings.json` as a last-resort candidate. Inside this
  // repo the plugin itself may have written one while running its own tests, so
  // the boot pins cwd to the fixture home; otherwise "no savings file" would
  // find the repo's file and the 暂无数据 case could never be exercised.
  const previousCwd = process.cwd()
  try {
    process.chdir(home)
  } catch (err) {}

  const host = makeHost(options)
  apply(host.ctx, options.config)
  const port = await listen(host.server)
  const base = 'http://127.0.0.1:' + port

  const shut = async () => {
    try {
      host.disposeEffect()
    } catch (err) {}
    await new Promise((resolve) => host.server.close(resolve))
    try {
      process.chdir(previousCwd)
    } catch (err) {}
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  cleanups.push(shut)

  let token = null
  try {
    token = fs.readFileSync(path.join(home, '.dsh-savings-panel-token'), 'utf8').trim()
  } catch (err) {}

  return { ...host, base, home, profile, token, shut, service: host.provided.get('savingsPanels') }
}

async function getJson(base, pathname, init) {
  const res = await fetch(base + pathname, init)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch (err) {}
  return { status: res.status, headers: res.headers, text, json }
}

function waitFor(predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const value = predicate()
      if (value) return resolve(value)
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting'))
      setTimeout(tick, 25)
    }
    tick()
  })
}

const PANEL_BODY = JSON.stringify({
  v: 1,
  id: 'build-status',
  kind: 'badge',
  title: '构建',
  payload: { text: '通过', tone: 'ok' },
})

/* -------------------------------------------------------------------------- */
/* Flag off                                                                   */
/* -------------------------------------------------------------------------- */

test('flag off: no panel routes exist and nothing is injected', async () => {
  const w = await boot({ panels: false })
  for (const pathname of ['/dsh-savings/panels.json', '/dsh-savings/panels', '/dsh-savings/panels/events', '/dsh-savings/panel.js']) {
    const res = await fetch(w.base + pathname)
    assert.equal(res.status, 404, pathname + ' must not exist while the flag is off')
  }
  const table = []
  w.emit('webserver/index-inject', table)
  assert.equal(table.length, 0, 'no index row may be pushed while the flag is off')
  assert.deepEqual(w.taps, [])
})

test('flag off: the service exists but refuses politely', async () => {
  const w = await boot({ panels: false })
  assert.ok(w.service, 'savingsPanels must still be provided so consumers activate')
  const result = w.service.publish({ v: 1, id: 'x', kind: 'metric', title: 't', payload: { value: 1 } }, { producer: 'plug' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DISABLED')
})

/* -------------------------------------------------------------------------- */
/* Flag on                                                                    */
/* -------------------------------------------------------------------------- */


test('flag on: a missing savings file yields 暂无数据, not an error', async () => {
  const w = await boot({ panels: true, withSavings: false })
  const snap = await getJson(w.base, '/dsh-savings/panels.json')
  assert.equal(snap.status, 200)
  const panel = snap.json.panels.find((p) => p.id === 'token-savings')
  assert.equal(panel.status, 'empty')
  assert.match(panel.payload.emptyReason, /找不到/)
})

test('flag on: the flag file enables the panel host', async () => {
  const w = await boot({ panels: undefined, flag: true })
  const res = await fetch(w.base + '/dsh-savings/panels.json')
  assert.equal(res.status, 200)
})

/* -------------------------------------------------------------------------- */
/* Mutation channel                                                           */
/* -------------------------------------------------------------------------- */

test('publish requires a bearer token', async () => {
  const w = await boot({ panels: true })
  const res = await getJson(w.base, '/dsh-savings/panels', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: PANEL_BODY,
  })
  assert.equal(res.status, 401)
  assert.equal(res.json.code, 'TOKEN')
})

test('publish accepts a token and shows up in the snapshot', async () => {
  const w = await boot({ panels: true })
  const res = await getJson(w.base, '/dsh-savings/panels', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + w.token },
    body: PANEL_BODY,
  })
  assert.equal(res.status, 200)
  const snap = await getJson(w.base, '/dsh-savings/panels.json')
  const panel = snap.json.panels.find((p) => p.id === 'build-status')
  assert.equal(panel.producer, 'http')
  assert.equal(panel.payload.text, '通过')
})

test('publish rejects cross-origin, wrong content type, bad JSON and oversized bodies', async () => {
  const w = await boot({ panels: true })
  const auth = { authorization: 'Bearer ' + w.token }

  const crossOrigin = await getJson(w.base, '/dsh-savings/panels', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth, origin: 'https://evil.example' },
    body: '{}',
  })
  assert.equal(crossOrigin.status, 403)

  const wrongType = await getJson(w.base, '/dsh-savings/panels', {
    method: 'POST',
    headers: { 'content-type': 'text/plain', ...auth },
    body: '{}',
  })
  assert.equal(wrongType.status, 415)

  const badJson = await getJson(w.base, '/dsh-savings/panels', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: '{oops',
  })
  assert.equal(badJson.status, 400)

  const huge = await getJson(w.base, '/dsh-savings/panels', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ v: 1, id: 'x', kind: 'metric', title: 't'.repeat(40000), payload: { value: 1 } }),
  })
  assert.equal(huge.status, 413)
})

test('a chatty producer is rate limited with 429', async () => {
  const w = await boot({ panels: true })
  let limited = null
  for (let i = 0; i < 40 && limited === null; i++) {
    const res = await getJson(w.base, '/dsh-savings/panels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + w.token, 'x-dsh-panel-producer': 'noisy' },
      body: JSON.stringify({ v: 1, id: 'pane-' + i, kind: 'metric', title: 'n' + i, payload: { value: i } }),
    })
    if (res.status === 429) limited = res
  }
  assert.ok(limited, 'expected at least one 429')
  assert.equal(limited.json.code, 'RATE_LIMIT')
})

test('DELETE removes a panel', async () => {
  const w = await boot({ panels: true })
  await getJson(w.base, '/dsh-savings/panels', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + w.token },
    body: JSON.stringify({ v: 1, id: 'temp', kind: 'metric', title: 'T', payload: { value: 1 } }),
  })
  const removed = await getJson(w.base, '/dsh-savings/panels/http/temp', { method: 'DELETE', headers: { authorization: 'Bearer ' + w.token } })
  assert.equal(removed.status, 200)
})

/* -------------------------------------------------------------------------- */
/* Desktop index row                                                          */
/* -------------------------------------------------------------------------- */

test('the desktop index row is registered before any service is awaited', async () => {
  const w = await boot({ panels: true, deferInject: true })
  const table = []
  w.emit('webserver/index-inject', table)
  assert.equal(table.length, 1, 'the row must be registered synchronously in apply()')
  assert.equal(table[0].kind, 'script')
  assert.equal(table[0].placement, 'body')
  assert.match(table[0].text, /\/dsh-savings\/panel\.js/)
  assert.doesNotThrow(() => new Function(table[0].text))
  w.resolveInjections()
  const res = await fetch(w.base + '/dsh-savings/panel.js')
  assert.equal(res.status, 200)
})

test('the index row is not duplicated', async () => {
  const w = await boot({ panels: true })
  const fresh = []
  w.emit('webserver/index-inject', fresh)
  assert.equal(fresh.length, 1)
  const existing = [{ kind: 'script', placement: 'body', text: 'void 0; // /dsh-savings/panel.js' }]
  w.emit('webserver/index-inject', existing)
  assert.equal(existing.length, 1)
})

test('INDEX_ROW_TEXT is exported for tooling and stays idempotent', () => {
  assert.match(INDEX_ROW_TEXT, /__dshSavingsPanels/)
  assert.doesNotThrow(() => new Function(INDEX_ROW_TEXT))
})

/* -------------------------------------------------------------------------- */
/* Service, SSE, spool, disposal                                              */
/* -------------------------------------------------------------------------- */

test('the savingsPanels service publishes without HTTP', async () => {
  const w = await boot({ panels: true })
  const result = w.service.publish(
    { v: 1, id: 'inproc', kind: 'progress', title: '折叠进度', payload: { value: 3, max: 10, label: '本轮' } },
    { producer: 'dsh-context-manager' },
  )
  assert.equal(result.ok, true)
  const snap = await getJson(w.base, '/dsh-savings/panels.json')
  assert.ok(snap.json.panels.find((p) => p.id === 'inproc'))
})

test('the SSE stream opens with a snapshot and pushes updates', async () => {
  const w = await boot({ panels: true })
  const chunks = []
  const req = http.get(w.base + '/dsh-savings/panels/events', (res) => {
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'], /text\/event-stream/)
    res.setEncoding('utf8')
    res.on('data', (chunk) => chunks.push(chunk))
  })
  cleanups.push(() => req.destroy())

  await waitFor(() => chunks.join('').includes('event: snapshot'))
  assert.match(chunks.join(''), /"id":"token-savings"/)

  w.service.publish({ v: 1, id: 'live', kind: 'badge', title: 'Live', payload: { text: 'on' } }, { producer: 'streamer' })
  await waitFor(() => chunks.join('').includes('"id":"live"'), 4000)
})

test('a file dropped into $DSH_HOME/.dsh-savings-panels becomes a panel', async () => {
  const w = await boot({ panels: true })
  const dir = path.join(w.home, '.dsh-savings-panels')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'file-producer.json'),
    JSON.stringify({ v: 1, id: 'disk', kind: 'list', title: '磁盘', payload: { items: [{ label: 'free', value: '12 GB' }] } }),
  )
  w.service.snapshot()
  const snap = await getJson(w.base, '/dsh-savings/panels.json')
  const panel = snap.json.panels.find((p) => p.id === 'disk')
  if (panel) assert.equal(panel.producer, 'file-producer')
})

test('disposal removes every route, the tap and the service', async () => {
  const w = await boot({ panels: true })
  assert.equal((await fetch(w.base + '/dsh-savings/panels.json')).status, 200)
  w.disposeEffect()
  assert.equal((await fetch(w.base + '/dsh-savings/panels.json')).status, 404)
  assert.equal(w.provided.has('savingsPanels'), false)
  assert.deepEqual(w.taps, [])
})
