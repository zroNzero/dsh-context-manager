#!/usr/bin/env node
/**
 * 按真实字节数预测「旧工具结果落盘」能省掉请求前缀的多少。
 * 不猜均值：逐条判断是否会超过 minChars、替换后收据有多长。
 *
 * 用法：node tools/spill-forecast.mjs <session.v4.jsonl.zstd> [charBudget=650000] [minChars=1200] [retain=6]
 */
import { readSessionEvents } from './session-decode.mjs'

const [file, budgetArg, minArg, retainArg] = process.argv.slice(2)
const budget = Number(budgetArg ?? 650000)
const minChars = Number(minArg ?? 1200)
const retain = Number(retainArg ?? 6)
if (!file) {
  process.stderr.write('usage: node tools/spill-forecast.mjs <session.v4.jsonl.zstd> [budget] [minChars] [retain]\n')
  process.exit(2)
}

const { events } = readSessionEvents(file)
const CONVERSATION = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message', 'developer/message'])
const rows = []
for (const event of events) {
  const type = String(event?.type ?? '')
  if (!CONVERSATION.has(type)) continue
  const payload = event?.data?.message ?? event?.data?.result ?? event?.data?.content ?? event?.data ?? ''
  rows.push({ type, payload, chars: JSON.stringify(payload).length })
}

const kept = []
let sum = 0
for (let index = rows.length - 1; index >= 0; index -= 1) {
  if (sum + rows[index].chars > budget) break
  sum += rows[index].chars
  kept.push(rows[index])
}
kept.reverse()

const RECEIPT = 420
let foldable = 0
let savedChars = 0
const cutoff = kept.length - retain
for (let index = 0; index < cutoff; index += 1) {
  const row = kept[index]
  if (row.type !== 'tool/result') continue
  const raw = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload)
  const chars = raw.length
  if (chars <= minChars) continue
  foldable += 1
  savedChars += chars - RECEIPT
}

const share = (savedChars / Math.max(1, sum)) * 100
process.stdout.write(`request chars=${sum} (~${Math.round(sum / 4)} tokens)\n`)
process.stdout.write(`foldable tool results=${foldable} (of ${kept.filter((r) => r.type === 'tool/result').length} in window)\n`)
process.stdout.write(`saved=${savedChars} chars = ${share.toFixed(1)}% of the request\n`)
process.stdout.write(`hit tokens saved/call ≈ ${Math.round(savedChars / 4)} → ¥${((savedChars / 4) * 0.02) / 1e6}\n`)
