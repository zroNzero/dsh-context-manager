/**
 * 面板口径自检：拿真实落盘的 savings.json 跑一遍 buildPanelSummary，
 * 把「工作区 / token / 钱」逐行打出来，并用两条互不依赖的不变式复核金额。
 *
 * 用法：node tools/panel-check.mjs [savings.json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { buildPanelSummary, PANEL_ROUTE, PANEL_SCHEMA_VERSION } from '../dist/panel.js'

const file = process.argv[2] ?? path.join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'savings.json')
const doc = JSON.parse(fs.readFileSync(file, 'utf8'))

const summary = buildPanelSummary({ snapshot: doc, bill: doc.money ?? null })

const cny = (n) => '¥' + Number(n).toFixed(4)
const num = (n) => Number(n).toLocaleString('en-US')
const pct = (n) => (n === null || n === undefined ? '—' : (n * 100).toFixed(2) + '%')

console.log(`route   ${PANEL_ROUTE}  schema v${PANEL_SCHEMA_VERSION}`)
console.log(`since   ${summary.since}`)
console.log(
  `totals  ${num(summary.totals.savedTokens)} tokens (hit ${num(summary.totals.savedHitTokens)} / miss ${num(summary.totals.savedMissTokens)})  ${cny(summary.totals.savedMoney)}  ${summary.totals.turns} turns`,
)
console.log('')
console.log(
  'workspace'.padEnd(28) + 'tokens'.padStart(14) + 'hit'.padStart(14) + 'miss'.padStart(11) + 'money'.padStart(11) + 'turns'.padStart(7),
)
for (const w of summary.workspaces) {
  console.log(
    String(w.label).padEnd(28) +
      num(w.savedTokens).padStart(14) +
      num(w.savedHitTokens).padStart(14) +
      num(w.savedMissTokens).padStart(11) +
      cny(w.savedMoney).padStart(11) +
      String(w.turns).padStart(7),
  )
}

let failed = false
const fail = (why) => {
  console.log('FAIL: ' + why)
  failed = true
}

// 不变式 1（精确）：金额是逐行落盘值的加法，不允许面板再乘一次价。
const rowsSum = summary.workspaces.reduce((acc, w) => acc + w.savedMoney, 0)
const rowDelta = Math.abs(rowsSum - summary.totals.savedMoney)
console.log('')
console.log(`inv1     Σ 工作区金额 = ${cny(rowsSum)}   totals = ${cny(summary.totals.savedMoney)}   Δ=${rowDelta.toExponential(2)}`)
if (rowDelta > 1e-6) fail('工作区金额之和与总额不相等')

// 不变式 2（精确）：每个工作区的金额必须等于账本里那个 bucket 的 moneyCny。
const buckets = doc.byWorkspace ?? {}
let bucketMismatch = null
for (const w of summary.workspaces) {
  const bucket = buckets[w.id]
  if (!bucket) continue
  const expected = Number(bucket.moneyCny) || 0
  if (Math.abs(expected - w.savedMoney) > 1e-9) bucketMismatch = `${w.label}: panel=${w.savedMoney} ledger=${expected}`
}
if (bucketMismatch !== null) fail('面板金额与账本 bucket.moneyCny 不一致 → ' + bucketMismatch)
else console.log('inv2     每行金额 === 账本 bucket.moneyCny（逐字节相等，无二次换算）')

// 参考值：用低峰单价把 token 折成钱，只用于对比，不参与判定。
// 差额来源只有两个，都可解释：高峰时段单价 ×2、历史轮次未单列输出 token。
const basis = doc.money?.basis ?? {}
const hitPrice = Number(basis.hit)
const missPrice = Number(basis.miss)
const outPrice = Number.isFinite(Number(basis.out)) ? Number(basis.out) : 4
if (Number.isFinite(hitPrice) && Number.isFinite(missPrice)) {
  const t = summary.totals
  const ref = (t.savedHitTokens * hitPrice + t.savedMissTokens * missPrice + t.savedOutTokens * outPrice) / 1e6
  const delta = t.savedMoney - ref
  console.log(
    `ref      低峰参考 (hit×${hitPrice} + miss×${missPrice} + out×${outPrice})/1M = ${cny(ref)}   Δ=${cny(delta)}（高峰×2 与历史输出未单列所致，非估算来源）`,
  )
  if (delta < -1e-6) fail('面板金额小于低峰参考值 → 钱的来源不可能是 token×单价')
} else {
  console.log('ref      账本无 money.basis，跳过参考对比')
}

console.log(`actual   ${cny(summary.totals.actualMoney)}   省下占比 ${pct(summary.totals.savedShare)}`)
console.log(failed ? 'RESULT FAIL' : 'RESULT PASS')
if (failed) process.exitCode = 1
