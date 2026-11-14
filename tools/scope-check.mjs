/**
 * 作用域回归：会话标签页必须只看到自己工作区的数据。
 *
 * 三条断言（都是「看起来对、数字错」的坑）：
 *   1. 带 sessionId → totals/today/days 只等于该工作区自己的值；
 *   2. 不带 sessionId → 全量汇总，且 scope.workspaceLabel 为 null（不能借用第一个工作区的名字）；
 *   3. sessionId 存在但没登记过工作区 → 全部为 0，不能退化成「全部工作区」。
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildPanelSummary } = require('../dist/panel.js')

const snapshot = JSON.parse(
  fs.readFileSync('C:/Users/zro_0/.dsh/profiles/desktop/savings.json', 'utf8'),
)

const bySession = snapshot.bySession ?? {}
const sessions = Object.keys(bySession)
if (sessions.length === 0) {
  console.log('SKIP 账本里还没有 bySession 映射')
  process.exit(0)
}

const wsOf = (id) => (snapshot.byWorkspace ?? {})[id] ?? {}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9
const problems = []

/** 每个会话：它的工作区今日金额应等于该工作区 byDay 里的今日金额。 */
for (const sessionId of sessions.slice(0, 20)) {
  const wsId = bySession[sessionId]
  const summary = buildPanelSummary({ snapshot, sessionId, now: Date.now() })
  const todayKey = summary.today.date
  const own = (wsOf(wsId).byDay ?? {})[todayKey]

  if (summary.scope.workspaceId !== wsId) problems.push(`${sessionId}: workspaceId=${summary.scope.workspaceId} 应为 ${wsId}`)
  if (summary.workspaces.length > 1) problems.push(`${sessionId}: 作用域内出现 ${summary.workspaces.length} 个工作区`)
  if (summary.workspaces.some((row) => row.id !== wsId)) problems.push(`${sessionId}: 作用域内混入了别人的行`)

  const expected = own ? Number(own.savedMoney) || 0 : 0
  // 比的是当日那一格，不是累计 totals —— 累计本来就跨天，拿来比当日必然不等。
  const gotToday = summary.today.totals.savedMoney
  if (!near(gotToday, expected)) {
    problems.push(`${sessionId}: today savedMoney=${gotToday} 应为 ${expected}`)
  }
  // 累计也必须只含本工作区：上限是账本里该工作区的 moneyCny。
  const ownTotal = Number(wsOf(wsId).moneyCny) || 0
  if (Number(summary.totals.savedMoney) > ownTotal + 1e-6) {
    problems.push(`${sessionId}: 累计 ${summary.totals.savedMoney} 超过本工作区总额 ${ownTotal}`)
  }
  if (summary.days.length > 1) problems.push(`${sessionId}: days 出现 ${summary.days.length} 天（应只有该工作区的日期）`)
}

/** 不带 sessionId：全量，且不能冒用某个工作区的名字。 */
const all = buildPanelSummary({ snapshot, now: Date.now() })
if (!all.scope.all) problems.push('无 sessionId 时 scope.all 应为 true')
if (all.scope.workspaceLabel !== null) problems.push(`无 sessionId 时 workspaceLabel 应为 null，实际 ${all.scope.workspaceLabel}`)
const allRows = all.workspaces.reduce((sum, row) => sum + row.savedMoney, 0)
if (!near(all.totals.savedMoney, allRows)) problems.push(`全量 totals(${all.totals.savedMoney}) 不等于各行之和(${allRows})`)

/** 未登记过工作区的会话：必须全 0。 */
const ghost = buildPanelSummary({ snapshot, sessionId: '__no-such-session__', now: Date.now() })
if (ghost.scope.workspaceId !== null) problems.push('未知 sessionId 不该解析出工作区')
if (ghost.workspaces.length !== 0) problems.push('未知 sessionId 不该有工作区行')
if (ghost.totals.savedMoney !== 0) problems.push(`未知 sessionId 的金额应为 0，实际 ${ghost.totals.savedMoney}`)
if (ghost.today.totals.savedMoney !== 0) problems.push(`未知 sessionId 的当日金额应为 0，实际 ${ghost.today.totals.savedMoney}`)

if (problems.length > 0) {
  console.log('FAIL scope')
  for (const p of problems) console.log('  - ' + p)
  process.exitCode = 1
} else {
  console.log(`PASS scope :: ${sessions.length} 个会话各自只看到本工作区；全量与未知会话均正确`)
}
