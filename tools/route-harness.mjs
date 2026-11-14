/**
 * 用「宿主契约的忠实替身」把面板路由跑一遍：不重启也能证明注册路径正确、
 * 处理器返回的 Response 合法、卸载时能干净摘掉。
 *
 * 契约来源：connection 服务的 inspect 结果
 *   register(route: ConnectionFetchRoute): () => Promise<void>
 *   { path, methods?: HttpMethod[], requestBody?: 'buffered' | 'streaming',
 *     fetch?: (request: Request) => Response | Promise<Response> }
 * 匹配方式：createSharedFetchHandler({ channel: '/api' }) 按绝对路径精确匹配。
 */
import { registerPanelRoute, PANEL_ROUTE } from '../dist/panel.js'

const ROUTE = '/api/dsh-context-manager/summary'
const routes = new Map()

const connection = {
  fetch: {
    register(route) {
      if (typeof route.path !== 'string' || !route.path.startsWith('/')) {
        throw new Error(`host contract violated: path must be absolute, got ${JSON.stringify(route.path)}`)
      }
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return async () => {
        routes.delete(route.path)
      }
    },
  },
}

const summary = {
  ok: true,
  schema: 1,
  revision: 42,
  generatedAt: new Date().toISOString(),
  since: '2026-11-13T06:02:53.250Z',
  currency: 'CNY',
  formula: 'hit×0.02 + miss×1 + out×4',
  totals: { savedTokens: 1000, savedMoney: 0.5 },
  workspaces: [],
}

const failures = []
const record = (name, condition, detail) => {
  if (condition) return
  failures.push(`${name}: ${detail}`)
}

let mountedPath = null
let mountError = null
const dispose = registerPanelRoute(
  { get: (name) => (name === 'connection' ? connection : undefined) },
  () => summary,
  (message) => {
    mountError = message
  },
  (path) => {
    mountedPath = path
  },
)

record('mount-error', mountError === null, String(mountError))
record('mounted-path', mountedPath === ROUTE, `got ${JSON.stringify(mountedPath)}, want ${ROUTE}`)
record('registered', routes.has(ROUTE), `keys=${[...routes.keys()].join(',') || '(none)'}`)

const route = routes.get(ROUTE)
if (route !== undefined) {
  record('methods', Array.isArray(route.methods) && route.methods.includes('POST'), JSON.stringify(route.methods))
  record('requestBody', route.requestBody === 'buffered', String(route.requestBody))

  const response = await route.fetch(
    new Request(`http://127.0.0.1:65535${ROUTE}`, { method: 'POST', body: '{}' }),
  )
  record('response-is-Response', response instanceof Response, String(response))
  record('status', response?.status === 200, String(response?.status))
  record('content-type', String(response?.headers?.get('content-type')).includes('application/json'),
    String(response?.headers?.get('content-type')))
  const body = await response.json()
  record('envelope.ok', body?.ok === true, JSON.stringify(body?.ok))
  record('envelope.totals', body?.totals?.savedMoney === 0.5, JSON.stringify(body?.totals))
}

dispose()
record('disposed', routes.size === 0, `still ${routes.size}`)

const clientRoute = PANEL_ROUTE
record('client-relative', !clientRoute.startsWith('/'), `client must stay relative, got ${clientRoute}`)
record('client-resolves-to-host', `/${clientRoute}` === ROUTE, `/${clientRoute} != ${ROUTE}`)

if (failures.length > 0) {
  console.error('FAIL route harness')
  for (const line of failures) console.error('  - ' + line)
  process.exitCode = 1
} else {
  console.log(`PASS route harness :: mount=${mountedPath} status=200 envelope.ok=true disposed=clean`)
}

// ---------------------------------------------------------------------------
// 第二段：把「真实账本 → 汇总 → 路由 → JSON」整条链跑通，用线上 savings.json。
// ---------------------------------------------------------------------------
import fs from 'node:fs'
import { buildPanelSummary } from '../dist/panel.js'

const ledgerPath = process.env.DCM_LEDGER || 'C:/Users/zro_0/.dsh/profiles/desktop/savings.json'
if (fs.existsSync(ledgerPath)) {
  const snapshot = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
  const liveRoutes = new Map()
  const liveConnection = {
    fetch: {
      register(route) {
        liveRoutes.set(route.path, route)
        return async () => liveRoutes.delete(route.path)
      },
    },
  }
  const liveDispose = registerPanelRoute(
    { get: (name) => (name === 'connection' ? liveConnection : undefined) },
    () => buildPanelSummary({ snapshot }),
    (message) => console.error('mount error: ' + message),
  )
  const liveRoute = liveRoutes.get(ROUTE)
  if (liveRoute === undefined) {
    console.error('FAIL live chain: route not mounted')
    process.exitCode = 1
  } else {
    const liveResponse = await liveRoute.fetch(new Request(`http://127.0.0.1:65535${ROUTE}`, { method: 'POST', body: '{}' }))
    const liveBody = await liveResponse.json()
    const savedMoney = Number(liveBody?.totals?.savedMoney)
    const workspaces = Array.isArray(liveBody?.workspaces) ? liveBody.workspaces.length : -1
    const ok = liveBody?.ok === true && Number.isFinite(savedMoney) && savedMoney > 0 && workspaces > 0
    console.log(
      `live chain :: status=${liveResponse.status} ok=${liveBody?.ok} ` +
        `savedMoney=¥${savedMoney.toFixed(4)} savedTokens=${liveBody?.totals?.savedTokens} ` +
        `turns=${liveBody?.totals?.turns} workspaces=${workspaces}`,
    )
    if (!ok) {
      console.error('FAIL live chain: envelope incomplete')
      process.exitCode = 1
    } else {
      console.log('PASS live chain :: 真实账本经路由返回可用 JSON')
    }
  }
  liveDispose()
} else {
  console.log(`skip live chain :: ${ledgerPath} not found`)
}

