/**
 * 当日账的端到端检查（离线，不依赖宿主）。
 *
 * 1. 空账本 + 真实 billing 日志 → 当日必须立刻有数（重启后不出现空白）；
 * 2. recordTurn 必须把轮次记到「工作区 × 当天」；
 * 3. 补齐只填缺失日期，绝不与实时记账重叠（防重复计数）；
 * 4. byDay 必须能随 savings.json 持久化，并在 restore 后还原。
 */
import fs from 'node:fs'
import path from 'node:path'
import { SavingsLedger } from '../dist/modules/savings-ledger.js'
import { parseBillingLog, dayKeyOf } from '../dist/modules/day-ledger.js'
import { buildPanelSummary } from '../dist/panel.js'

const LOG = process.argv[2] || 'C:/Users/zro_0/.dsh/profiles/desktop/debug.log'
let failed = 0
const check = (name, fn) => {
  try {
    const detail = fn()
    console.log(`PASS ${name} :: ${detail ?? 'ok'}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name} :: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const logText = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : ''
const parsed = parseBillingLog(logText)
const today = dayKeyOf()

check('day.log-parses-today', () => {
  const bucket = parsed.get(today)
  if (!bucket) throw new Error('日志里没有今天的计费记录')
  if (!(bucket.turns > 0)) throw new Error('turns 必须 > 0')
  if (!(bucket.savedMoney > 0)) throw new Error('savedMoney 必须 > 0')
  return `turns=${bucket.turns} tokens=${bucket.savedTokens} money=¥${bucket.savedMoney.toFixed(4)}`
})

check('day.seed-fills-empty-ledger', () => {
  const ledger = new SavingsLedger()
  const added = ledger.seedDaysFromLog(logText)
  if (!(added > 0)) throw new Error('补齐天数必须 > 0')
  const panel = buildPanelSummary({ snapshot: ledger.snapshot() })
  if (!(panel.today.turns > 0)) throw new Error('补齐后当日轮次应 > 0')
  if (!(panel.today.savedMoney > 0)) throw new Error('补齐后当日金额应 > 0')
  return `days=${added} todayTurns=${panel.today.turns} today=¥${panel.today.savedMoney.toFixed(4)}`
})

check('day.seed-never-overwrites-existing', () => {
  const ledger = new SavingsLedger()
  ledger.seedDaysFromLog(logText)
  const before = buildPanelSummary({ snapshot: ledger.snapshot() }).today
  const again = ledger.seedDaysFromLog(logText)
  const after = buildPanelSummary({ snapshot: ledger.snapshot() }).today
  if (again !== 0) throw new Error(`第二次补齐应新增 0 天，实际 ${again}`)
  if (after.turns !== before.turns) throw new Error('轮次被重复累加')
  return `repeatAdded=${again} turns 保持 ${after.turns}`
})

check('day.recordTurn-attributes-workspace-and-day', () => {
  const ledger = new SavingsLedger()
  ledger.recordTurn({ path: 'd:\\pc\\demo', label: 'demo' }, {
    savedCny: 0.5,
    savedHitTokens: 1000,
    savedMissTokens: 200,
    savedOutTokens: 30,
    actualCny: 0.25,
    dayKey: today,
  })
  const panel = buildPanelSummary({ snapshot: ledger.snapshot() })
  const row = panel.today.workspaces[0]
  if (!row) throw new Error('当日工作区行缺失')
  if (row.savedTokens !== 1200) throw new Error(`savedTokens 应为 1200，实际 ${row.savedTokens}`)
  if (row.turns !== 1) throw new Error('turns 应为 1')
  if (Math.abs(panel.today.savedMoney - 0.5) > 1e-9) throw new Error('当日金额不等于 0.5')
  if (panel.today.unattributed.turns !== 0) throw new Error('有归属时 unattributed 应为 0')
  return `ws=${row.label} tokens=${row.savedTokens} money=¥${panel.today.savedMoney} unattributed=0`
})

check('day.survives-persist-restore', () => {
  const ledger = new SavingsLedger()
  ledger.recordTurn({ path: 'd:\\pc\\demo', label: 'demo' }, {
    savedCny: 0.5, savedHitTokens: 1000, savedMissTokens: 0, actualCny: 0.25, dayKey: today,
  })
  const saved = JSON.parse(JSON.stringify(ledger.snapshot()))
  const revived = new SavingsLedger()
  if (!revived.restore(saved)) throw new Error('restore 失败')
  const panel = buildPanelSummary({ snapshot: revived.snapshot() })
  if (panel.today.turns !== 1) throw new Error(`restore 后当日轮次应为 1，实际 ${panel.today.turns}`)
  if (Math.abs(panel.today.savedMoney - 0.5) > 1e-9) throw new Error('restore 后当日金额不对')
  return `todayTurns=${panel.today.turns} money=¥${panel.today.savedMoney}`
})

check('day.invalid-day-key-ignored', () => {
  const ledger = new SavingsLedger()
  ledger.recordTurn({ path: 'd:\\pc\\demo', label: 'demo' }, {
    savedCny: 0.5, savedHitTokens: 10, savedMissTokens: 0, actualCny: 0.1, dayKey: 'not-a-date',
  })
  const panel = buildPanelSummary({ snapshot: ledger.snapshot() })
  if (panel.today.turns !== 0) throw new Error('非法日期不应进入当日')
  if (panel.days.length !== 0) throw new Error('非法日期不应进入 days')
  return 'ignored'
})

console.log(failed === 0 ? '\nRESULT PASS' : `\nRESULT FAIL (${failed})`)
process.exitCode = failed === 0 ? 0 : 1
