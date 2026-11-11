#!/usr/bin/env node
/**
 * 还原「最近一次请求实际带上的上下文」：从会话末尾往回累积到给定字符预算，
 * 按角色统计占比。用来决定前缀压缩该砍哪一块，而不是猜。
 *
 * 用法：node tools/context-budget.mjs <session.v4.jsonl.zstd> <charBudget=650000>
 */
import { readSessionEvents } from './session-decode.mjs'

const file = process.argv[2]
const budget = Number(process.argv[3] ?? 650000)
if (!file) {
  process.stderr.write('usage: node tools/context-budget.mjs <session.v4.jsonl.zstd> [charBudget]\n')
  process.exit(2)
}

const { events } = readSessionEvents(file)
const CONVERSATION = new Set([
  'user/message',
  'assistant/message',
  'tool/result',
  'system/message',
  'developer/message',
])

const rows = []
for (const event of events) {
  const type = String(event?.type ?? '')
  if (!CONVERSATION.has(type)) continue
  const payload = event?.data?.message ?? event?.data?.result ?? event?.data?.content ?? event?.data ?? ''
  rows.push({ type, chars: JSON.stringify(payload).length })
}

const kept = []
let sum = 0
for (let index = rows.length - 1; index >= 0; index -= 1) {
  if (sum + rows[index].chars > budget) break
  sum += rows[index].chars
  kept.push(rows[index])
}

const byType = new Map()
for (const row of kept) {
  const slot = byType.get(row.type) ?? { count: 0, chars: 0 }
  slot.count += 1
  slot.chars += row.chars
  byType.set(row.type, slot)
}

process.stdout.write(`budget=${budget} chars fitted=${sum} events=${kept.length} (~${Math.round(sum / 4)} tokens)\n\n`)
process.stdout.write('| type | msgs | chars | share |\n|---|---:|---:|---:|\n')
for (const [key, slot] of [...byType.entries()].sort((a, b) => b[1].chars - a[1].chars)) {
  process.stdout.write(`| ${key} | ${slot.count} | ${slot.chars} | ${((slot.chars / Math.max(1, sum)) * 100).toFixed(1)}% |\n`)
}
