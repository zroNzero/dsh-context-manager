#!/usr/bin/env node
/**
 * 拆解「每次请求都要重读的前缀」：按事件类型统计字符数。
 * 目的：找出 163K token 的命中量里，哪些是真正必要、哪些是可以折叠的旧内容。
 *
 * 用法：node tools/context-composition.mjs <session.v4.jsonl.zstd> [retain=8]
 */
import { readSessionEvents } from './session-decode.mjs'

const file = process.argv[2]
const retain = Number(process.argv[3] ?? 8)
if (!file) {
  process.stderr.write('usage: node tools/context-composition.mjs <session.v4.jsonl.zstd> [retain]\n')
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

const total = rows.reduce((sum, row) => sum + row.chars, 0)
const head = rows.slice(0, -retain)
const tail = rows.slice(-retain)
const tailChars = tail.reduce((sum, row) => sum + row.chars, 0)
const headChars = total - tailChars

const byType = new Map()
for (const row of head) {
  const slot = byType.get(row.type) ?? { count: 0, chars: 0 }
  slot.count += 1
  slot.chars += row.chars
  byType.set(row.type, slot)
}

process.stdout.write(`conversation events=${rows.length} chars=${total} (~${Math.round(total / 4)} tokens)\n`)
process.stdout.write(`older(${head.length}) chars=${headChars} (~${Math.round(headChars / 4)} tok)  recent(${retain}) chars=${tailChars}\n\n`)
process.stdout.write('| type (older than retain) | msgs | chars | share of total |\n|---|---:|---:|---:|\n')
for (const [key, slot] of [...byType.entries()].sort((a, b) => b[1].chars - a[1].chars)) {
  process.stdout.write(`| ${key} | ${slot.count} | ${slot.chars} | ${((slot.chars / Math.max(1, total)) * 100).toFixed(1)}% |\n`)
}
