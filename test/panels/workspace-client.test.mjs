// Workspace-surface test: run client.js against a fake module loader and assert
// that it registers the expected slots only while the panel feature is on.
//
// The client kernel contract being exercised is the one the shipped template
// uses: `window.__ModuleLoader__.load({ id, factory })`, the factory returning
// `{ inject, apply }`, and slots registered through `ctx.slots.inject(name, cb)`
// + `ctx.slots.register(options, Component)`.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'

const SCRIPT = fs.readFileSync(new URL('../../client.js', import.meta.url), 'utf8')

const windows = []
after(() => {
  for (const window of windows) {
    try {
      window.close()
    } catch (err) {}
  }
})

function makeWindow(fetchImpl) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'http://127.0.0.1:59989/',
  })
  const window = dom.window
  windows.push(window)

  let definition = null
  window.__ModuleLoader__ = {
    load(def) {
      definition = def
    },
  }

  const React = {
    createElement() {
      return null
    },
    useState() {
      return [null, () => {}]
    },
    useEffect() {},
  }

  const registrations = []
  const ctx = {
    slots: {
      inject(name, callback) {
        callback()
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }

  window.fetch = fetchImpl
  window.eval(SCRIPT)

  return { window, definition, registrations, ctx, React }
}

const flush = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

const okSnapshot = {
  ok: true,
  panels: [
    {
      id: 'token-savings',
      producer: 'dsh-context-manager',
      kind: 'metric',
      title: 'Token 节省',
      status: 'ok',
      updatedAt: new Date().toISOString(),
      payload: {
        value: 8112,
        unit: 'tokens',
        label: '累计节省',
        items: [{ label: 'schema', value: 8112 }],
        rate: { percent: 3.3, label: '本轮' },
        source: 'desktop/savings.json',
        showShare: true,
      },
    },
  ],
}

test('registers a view tab, a sidebar row and a workspace page when enabled', async () => {
  const { definition, registrations, ctx, React } = makeWindow(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(okSnapshot) }),
  )
  assert.ok(definition, 'the module must call __ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-context-manager-savings')

  const api = definition.factory(() => React)
  // The module runs in the jsdom realm, so copy it into this realm before comparing.
  assert.deepEqual([...api.inject], ['slots', 'sessions'])
  assert.equal(typeof api.apply, 'function')
  api.apply(ctx)
  await flush(40)

  const names = registrations.map((r) => r.options.name).sort()
  assert.deepEqual(names, ['conversation.view', 'main', 'sidebar.panellist'])

  const view = registrations.find((r) => r.options.name === 'conversation.view').options
  assert.equal(view.id, 'whale-savings')
  assert.equal(view.order, 20, 'must sort after Trajectory (order 10)')
  assert.equal(view.label(), '节省')

  const sidebar = registrations.find((r) => r.options.name === 'sidebar.panellist').options
  assert.equal(sidebar.id, 'whale-savings')
  assert.equal(sidebar.label(), '节省')

  const main = registrations.find((r) => r.options.name === 'main').options
  assert.equal(main.key, 'whale-savings', 'the sidebar row selects this keyed page')
})

test('registers nothing when the panel flag is off (snapshot route 404s)', async () => {
  const { definition, registrations, ctx, React } = makeWindow(() =>
    Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
  )
  const api = definition.factory(() => React)
  api.apply(ctx)
  await flush(40)
  assert.deepEqual(registrations, [], 'no slot may be claimed while the feature is off')
})

test('a failing endpoint does not throw into the page', async () => {
  const { definition, registrations, ctx, React } = makeWindow(() => Promise.reject(new Error('offline')))
  const api = definition.factory(() => React)
  assert.doesNotThrow(() => api.apply(ctx))
  await flush(40)
  assert.deepEqual(registrations, [])
})

test('the module installs exactly one stylesheet', async () => {
  const { window, definition, ctx, React } = makeWindow(() => Promise.resolve({ ok: true, json: () => Promise.resolve(okSnapshot) }))
  const api = definition.factory(() => React)
  api.apply(ctx)
  await flush(20)
  assert.equal(window.document.querySelectorAll('style#dshwsv-style').length, 1)
})
