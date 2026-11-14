// Server side of the panel host.
//
// One object per plugin activation. It owns:
//   - the feature flag decision (flag.js)
//   - the panel store (hub.js)
//   - the SSE fan-out (sse.js)
//   - the built-in sources: token savings (token-savings.js) and the file
//     drop directory (spool.js)
//   - the HTTP surface, mounted through ctx.webServer
//   - the in-process service `savingsPanels` other DSH plugins can inject
//
// When the flag is off the object is inert: no routes, no timers, no polling,
// nothing injected, so the whale widget behaves exactly as upstream. The
// service is still provided (as a stub that refuses politely), because a
// consumer plugin that declares `inject: ['savingsPanels']` would otherwise never
// activate.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { LIMITS, readProducerId, stripBom } from './schema.js'
import { PanelHub } from './hub.js'
import { SseChannel } from './sse.js'
import { resolvePanelsFlag } from './flag.js'
import { createTokenSavingsSource } from './token-savings.js'
import { createSpoolSource, SPOOL_DIR } from './spool.js'
import { DAILY_FILE, saveDay } from './daily.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')
const CLIENT_ASSET = path.join(PACKAGE_ROOT, 'assets', 'panel.js')

export const SERVICE_NAME = 'savingsPanels'
export const SNAPSHOT_PATH = '/dsh-savings/panels.json'
export const EVENTS_PATH = '/dsh-savings/panels/events'
export const PANELS_PREFIX = '/dsh-savings/panels'
export const CLIENT_PATH = '/dsh-savings/panel.js'
export const TOKEN_FILE = '.dsh-savings-panel-token'

export const DEFAULTS = {
  sourceIntervalMs: 5000,
  expireIntervalMs: 30000,
  demandWindowMs: 60000,
  maxBatch: 4,
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

function json(res, status, body, extraHeaders) {
  res.writeHead(status, extraHeaders ? { ...JSON_HEADERS, ...extraHeaders } : JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function methodOf(req) {
  return String((req && req.method) || 'GET').toUpperCase()
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      reject(err)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        // Reject, then drain instead of destroying: destroying the socket here
        // would kill the 413 response before the client can read it.
        fail(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }))
        req.removeAllListeners('data')
        try {
          req.resume()
        } catch (err) {}
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', fail)
  })
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a), 'utf8')
  const right = Buffer.from(String(b), 'utf8')
  if (left.length === 0 || left.length !== right.length) return false
  try {
    return crypto.timingSafeEqual(left, right)
  } catch (err) {
    return false
  }
}

function defaultLog() {}

/**
 * Load or mint the mutation token. Same-user trust boundary: a process that can
 * read $DSH_HOME can already read every profile file, so a file on disk is an
 * honest place to hand the token to local scripts.
 */
export function loadMutationToken(env, home, writeFile = fs.writeFileSync, readFile = fs.readFileSync) {
  const fromEnv = env && env.DSH_SAVINGS_PANEL_TOKEN
  if (typeof fromEnv === 'string' && fromEnv.length >= 16) return { token: fromEnv, source: 'env', file: null }
  const file = path.join(home, TOKEN_FILE)
  try {
    const existing = String(readFile(file, 'utf8')).trim()
    if (existing.length >= 16) return { token: existing, source: 'file', file }
  } catch (err) {}
  const token = crypto.randomBytes(24).toString('hex')
  try {
    writeFile(file, token, { encoding: 'utf8', mode: 0o600 })
    return { token, source: 'generated', file }
  } catch (err) {
    return { token, source: 'memory', file: null }
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [options]
 * @param {object} [options.config] plugin row config (may carry panels.enabled)
 * @param {Record<string,string|undefined>} [options.env]
 * @param {string} [options.home]
 * @param {string} [options.cwd]
 * @param {() => number} [options.now]
 * @param {(level: string, message: string, detail?: object) => void} [options.log]
 * @param {boolean} [options.readAsset] injectable reader for tests
 */
export function createPanelRuntime(ctx, options = {}) {
  const env = options.env || process.env
  const home = options.home || env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const log = typeof options.log === 'function' ? options.log : defaultLog
  const disposers = []

  const flag = resolvePanelsFlag({ config: options.config, env, home, packageRoot: PACKAGE_ROOT, log })

  if (!flag.enabled) {
    const disabled = {
      ok: false,
      code: 'DISABLED',
      error: 'savings panel host is disabled (enable it with DSH_SAVINGS_PANELS=1, ' + path.join(home, '.dsh-savings-panels.json') + ', ' + path.join(PACKAGE_ROOT, '.dsh-savings-panels.json') + ', or config.panels.enabled)',
    }
    const stub = {
      version: 1,
      enabled: false,
      /** Always refuses; present so consumer plugins can activate. */
      publish: () => ({ ...disabled }),
      remove: () => false,
      clear: () => 0,
      toast: () => ({ ...disabled }),
      snapshot: () => ({ v: 1, now: new Date(now()).toISOString(), revision: 0, panels: [], dropped: 0, rejected: 0 }),
      subscribe: () => () => {},
      stats: () => ({ enabled: false, flag }),
      paths: { snapshot: SNAPSHOT_PATH, events: EVENTS_PATH, prefix: PANELS_PREFIX },
    }
    return {
      enabled: false,
      flag,
      service: stub,
      snapshot: () => stub.snapshot(),
      stats: () => ({ enabled: false, flag, hub: null }),
      dispose() {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch (err) {}
        }
        disposers.length = 0
      },
    }
  }

  const hub = new PanelHub({ now, log })
  const sse = new SseChannel({ log })
  const token = loadMutationToken(env, home)
  const lastPublished = new Map()
  let demandUntil = 0
  let lastPollAt = 0
  let pollTimer = null
  let expireTimer = null
  let disposed = false

  function touchDemand() {
    demandUntil = now() + DEFAULTS.demandWindowMs
  }

  function publishIfChanged(producer, panel) {
    const key = producer + '\u0000' + String(panel && panel.id)
    // A panel that expired or was evicted must be publishable again even when
    // its bytes are identical, otherwise a static producer would vanish for good.
    if (!hub.has(producer, panel && panel.id)) lastPublished.delete(key)
    let signature
    try {
      signature = JSON.stringify(panel)
    } catch (err) {
      signature = null
    }
    if (signature !== null && lastPublished.get(key) === signature) return { ok: true, skipped: true }
    const result = hub.publish(producer, panel)
    if (result.ok && signature !== null) lastPublished.set(key, signature)
    return result
  }

  // --- sources -------------------------------------------------------------

  const savings = createTokenSavingsSource({
    now,
    log,
    files: options.savingsFiles,
    staleAfterMs: options.staleAfterMs,
    home,
    // Day-scoped accumulator: survives restarts and spans every profile ledger.
    dailyFile: path.join(home, DAILY_FILE),
    writeDaily: saveDay,
  })

  const savingsProducer = 'dsh-context-manager'

  const spool = createSpoolSource({
    dir: path.join(home, SPOOL_DIR),
    publish: (producer, panel) => publishIfChanged(producer, panel),
    clear: (producer) => {
      lastPublished.clear()
      return hub.clearProducer(producer)
    },
    present: (producer) => hub.hasProducer(producer),
    log,
  })

  function pollSources() {
    if (disposed) return
    lastPollAt = now()
    try {
      const result = savings.poll()
      if (result && result.panel) publishIfChanged(savingsProducer, result.panel)
    } catch (err) {
      log('warn', 'token savings source failed; panel unchanged', { error: String((err && err.message) || err) })
    }
    try {
      spool.poll()
    } catch (err) {
      log('warn', 'panel spool source failed', { error: String((err && err.message) || err) })
    }
  }

  function ensureFresh(maxAgeMs = 1000) {
    if (now() - lastPollAt >= maxAgeMs) pollSources()
  }

  // --- subscriptions -------------------------------------------------------

  hub.subscribe((snapshot, reason) => {
    try {
      sse.broadcast(snapshot, reason)
    } catch (err) {
      log('warn', 'panel broadcast failed', { error: String((err && err.message) || err) })
    }
  })

  // --- HTTP ----------------------------------------------------------------

  function addRoute(route) {
    try {
      const dispose = ctx.webServer.register(route)
      disposers.push(dispose)
      return true
    } catch (err) {
      log('warn', 'could not register panel route', { path: route.path, error: String((err && err.message) || err) })
      return false
    }
  }

  function sameOrigin(req) {
    const origin = req.headers && req.headers.origin
    if (!origin) return true // non-browser client (curl, a script)
    const host = req.headers && req.headers.host
    if (!host) return false
    try {
      return new URL(origin).host === host
    } catch (err) {
      return false
    }
  }

  function unauthorized(req) {
    const header = req.headers && req.headers.authorization
    if (typeof header !== 'string') return true
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (!match) return true
    return !timingSafeEqualString(match[1], token.token)
  }

  function snapshotBody() {
    const snap = hub.snapshot()
    return {
      ok: true,
      v: snap.v,
      now: snap.now,
      revision: snap.revision,
      panels: snap.panels,
      dropped: snap.dropped,
      rejected: snap.rejected,
      enabled: true,
      limits: { panels: LIMITS.panels, visible: LIMITS.visible },
    }
  }

  function handleSnapshot(req, res) {
    touchDemand()
    ensureFresh()
    json(res, 200, snapshotBody())
  }

  function handleEvents(req, res) {
    touchDemand()
    ensureFresh()
    if (!sse.add(req, res, hub.snapshot())) {
      json(res, 503, { ok: false, code: 'TOO_MANY_STREAMS', error: 'too many panel event subscribers' })
    }
  }

  async function handlePublish(req, res) {
    if (!sameOrigin(req)) {
      json(res, 403, { ok: false, code: 'ORIGIN', error: 'cross-origin panel publish is not allowed' })
      return
    }
    if (unauthorized(req)) {
      json(res, 401, { ok: false, code: 'TOKEN', error: 'missing or invalid bearer token' }, { 'WWW-Authenticate': 'Bearer' })
      return
    }
    const contentType = String((req.headers && req.headers['content-type']) || '')
    if (!contentType.toLowerCase().includes('application/json')) {
      json(res, 415, { ok: false, code: 'CONTENT_TYPE', error: 'content-type must be application/json' })
      return
    }

    let raw
    try {
      raw = await readBody(req, LIMITS.bodyBytes)
    } catch (err) {
      const tooLarge = err && err.code === 'BODY_TOO_LARGE'
      json(res, tooLarge ? 413 : 400, {
        ok: false,
        code: tooLarge ? 'BODY_TOO_LARGE' : 'BODY',
        error: tooLarge ? 'body exceeds ' + LIMITS.bodyBytes + ' bytes' : 'could not read request body',
      })
      return
    }

    let doc
    try {
      doc = JSON.parse(stripBom(raw))
    } catch (err) {
      json(res, 400, { ok: false, code: 'JSON', error: 'body is not valid JSON' })
      return
    }

    const headerProducer = req.headers && req.headers['x-dsh-panel-producer']
    const bodyProducer = doc && typeof doc === 'object' && doc.producer !== undefined ? doc.producer : undefined
    const producer = readProducerId(headerProducer !== undefined ? headerProducer : bodyProducer !== undefined ? bodyProducer : 'http')
    if (producer === null) {
      json(res, 400, { ok: false, code: 'SCHEMA', error: 'producer id is invalid' })
      return
    }

    const batch = doc && typeof doc === 'object' && Array.isArray(doc.panels) ? doc.panels : [doc]
    if (batch.length === 0 || batch.length > DEFAULTS.maxBatch) {
      json(res, 400, { ok: false, code: 'BATCH', error: 'send 1..' + DEFAULTS.maxBatch + ' panels per request' })
      return
    }

    touchDemand()
    const accepted = []
    const rejected = []
    let revision = hub.revision
    for (const panel of batch) {
      const result = publishIfChanged(producer, panel)
      if (result.ok) {
        accepted.push({ id: (panel && panel.id) || null, skipped: Boolean(result.skipped), replaced: Boolean(result.replaced) })
        revision = result.revision !== undefined ? result.revision : revision
      } else {
        rejected.push({ id: (panel && panel.id) || null, code: result.code, error: result.error })
      }
    }

    if (accepted.length === 0) {
      const first = rejected[0] || {}
      const status = first.code === 'RATE_LIMIT' || first.code === 'TOAST_COOLDOWN' ? 429 : first.code === 'SCHEMA' || first.code === 'VERSION' ? 400 : 400
      const headers = status === 429 ? { 'Retry-After': '1' } : undefined
      json(res, status, { ok: false, code: first.code || 'REJECTED', error: first.error || 'all panels rejected', rejected }, headers)
      return
    }

    json(res, 200, { ok: true, accepted, rejected, revision })
  }

  function handleDelete(req, res, pathname) {
    if (!sameOrigin(req)) {
      json(res, 403, { ok: false, code: 'ORIGIN', error: 'cross-origin panel removal is not allowed' })
      return
    }
    if (unauthorized(req)) {
      json(res, 401, { ok: false, code: 'TOKEN', error: 'missing or invalid bearer token' }, { 'WWW-Authenticate': 'Bearer' })
      return
    }
    const rest = pathname.slice(PANELS_PREFIX.length).replace(/^\/+/, '')
    const parts = rest.split('/').map(decodeURIComponent).filter(Boolean)
    if (parts.length !== 2) {
      json(res, 400, { ok: false, code: 'PATH', error: 'expected DELETE ' + PANELS_PREFIX + '/<producer>/<panel-id>' })
      return
    }
    const removed = hub.remove(parts[0], parts[1])
    json(res, removed ? 200 : 404, { ok: removed, removed })
  }

  function handlePrefix(req, res, pathname) {
    const method = methodOf(req)
    const rest = pathname.slice(PANELS_PREFIX.length).replace(/^\/+/, '')

    if (rest === '' || rest === '/') {
      if (method === 'GET' || method === 'HEAD') return handleSnapshot(req, res)
      if (method === 'POST') return handlePublish(req, res)
      json(res, 405, { ok: false, code: 'METHOD', error: 'use GET, POST, or DELETE' }, { Allow: 'GET, POST, DELETE' })
      return
    }

    if (rest === 'events') {
      if (method === 'GET') return handleEvents(req, res)
      json(res, 405, { ok: false, code: 'METHOD', error: 'events is read-only' }, { Allow: 'GET' })
      return
    }

    if (method === 'DELETE') return handleDelete(req, res, pathname)

    json(res, 404, { ok: false, code: 'NOT_FOUND', error: 'unknown panel endpoint' })
  }

  function clientScript() {
    try {
      return fs.readFileSync(CLIENT_ASSET, 'utf8')
    } catch (err) {
      log('warn', 'panel client asset is missing', { path: CLIENT_ASSET, error: String((err && err.message) || err) })
      return null
    }
  }

  addRoute({ kind: 'exact', path: SNAPSHOT_PATH, handler: handleSnapshot })
  addRoute({
    kind: 'prefix',
    path: PANELS_PREFIX,
    handler: (req, res) => {
      try {
        const target = new URL(req.url || '/', 'http://x')
        return handlePrefix(req, res, target.pathname)
      } catch (err) {
        json(res, 400, { ok: false, code: 'REQUEST', error: 'malformed request URL' })
        return undefined
      }
    },
  })
  addRoute({
    kind: 'exact',
    path: CLIENT_PATH,
    handler: (req, res) => {
      const body = clientScript()
      if (body === null) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('panel client unavailable')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(body)
    },
  })

  // --- service -------------------------------------------------------------

  const service = {
    version: 1,
    enabled: true,
    paths: { snapshot: SNAPSHOT_PATH, events: EVENTS_PATH, prefix: PANELS_PREFIX },

    /**
     * Publish one panel. `opts.producer` is required unless the document
     * carries `producer` itself.
     */
    publish(panel, opts = {}) {
      touchDemand()
      const producer = readProducerId(
        opts && opts.producer !== undefined
          ? opts.producer
          : panel && typeof panel === 'object' && panel.producer !== undefined
            ? panel.producer
            : undefined,
      )
      if (producer === null) {
        return { ok: false, code: 'SCHEMA', error: 'opts.producer is required and must match [a-z0-9][a-z0-9._-]*' }
      }
      return publishIfChanged(producer, panel)
    },

    remove(producer, id) {
      return hub.remove(producer, id)
    },

    clear(producer) {
      lastPublished.clear()
      return hub.clearProducer(producer)
    },

    /** Convenience: a transient toast bubble. */
    toast(text, opts = {}) {
      touchDemand()
      const producer = readProducerId((opts && opts.producer) || 'plugin')
      if (producer === null) return { ok: false, code: 'SCHEMA', error: 'invalid producer' }
      const durationMs = Number.isFinite(opts && opts.durationMs) ? opts.durationMs : LIMITS.toastDefaultMs
      return publishIfChanged(producer, {
        v: 1,
        id: (opts && opts.id) || 'toast',
        kind: 'toast',
        title: (opts && opts.title) || '提示',
        status: 'ok',
        priority: 9,
        ttlMs: Math.min(LIMITS.ttlMax, Math.max(LIMITS.ttlMin, Math.round(durationMs) + 1000)),
        payload: { text, durationMs, tone: (opts && opts.tone) || 'info' },
      })
    },

    snapshot() {
      ensureFresh()
      return hub.snapshot()
    },

    subscribe(listener) {
      touchDemand()
      const unsubscribe = hub.subscribe(listener)
      disposers.push(unsubscribe)
      return unsubscribe
    },

    stats() {
      return { enabled: true, flag, hub: hub.stats(), sseClients: sse.size, savings: savings.stats(), spool: spool.stats(), tokenSource: token.source }
    },
  }

  // --- lifecycle -----------------------------------------------------------

  pollTimer = setInterval(() => {
    if (disposed) return
    const demanded = sse.size > 0 || now() < demandUntil
    if (!demanded) return
    pollSources()
  }, DEFAULTS.sourceIntervalMs)
  if (typeof pollTimer.unref === 'function') pollTimer.unref()

  expireTimer = setInterval(() => {
    if (disposed) return
    if (sse.size === 0 && now() >= demandUntil) return
    hub.expire()
  }, DEFAULTS.expireIntervalMs)
  if (typeof expireTimer.unref === 'function') expireTimer.unref()

  pollSources()

  return {
    enabled: true,
    flag,
    service,
    tokenSource: token.source,
    snapshot: () => hub.snapshot(),
    /** Force one poll of the file-backed sources (tests and manual refresh). */
    poll: pollSources,
    stats: () => ({ enabled: true, flag, hub: hub.stats(), sseClients: sse.size, savings: savings.stats(), spool: spool.stats() }),
    dispose() {
      disposed = true
      if (pollTimer !== null) clearInterval(pollTimer)
      if (expireTimer !== null) clearInterval(expireTimer)
      pollTimer = null
      expireTimer = null
      try {
        sse.dispose()
      } catch (err) {}
      try {
        hub.dispose()
      } catch (err) {}
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (err) {}
      }
      disposers.length = 0
    },
  }
}
