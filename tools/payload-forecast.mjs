#!/usr/bin/env node
/**
 * 预测「落盘 + 丢老 thinking」之后实际发出去的消息有多大，并与 billing.recorded 的
 * payloadChars 对账 —— 这是确认压缩**真的发生在请求上**的唯一办法。
 *
 * 用法：node tools/payload-forecast.mjs <session.v4.jsonl.zstd> [budget] [minChars] [retain]
 */
import { readSessionEvents } from './session-decode.mjs'

const [file, budgetArg, minArg, retainArg] = process.argv.slice(2)
const budget = Number(budgetArg ?? 650000)
const minChars = Number(minArg ?? 600)
const retain = Number(retainArg ?? 6)
if (!file) {
  process.stderr.write('usage: node tools/payload-forecast.mjs <session.v4.jsonl.zstd> [budget] [minChars] [retain]\n')
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
let foldedSaving = 0
let droppedSaving = 0
const cutoff = kept.length - retain
for (let index = 0; index < cutoff; index += 1) {
  const row = kept[index]
  if (row.type === 'tool/result') {
    const raw = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload)
    if (raw.length > minChars) foldedSaving += raw.length - RECEIPT
  }
  if (row.type === 'assistant/message') {
    const content = row.payload?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'reasoning' || block?.type === 'thinking') {
        droppedSaving += String(block?.text ?? '').length
      }
    }
  }
}

process.stdout.write(`original=${sum} chars (~${Math.round(sum / 4)} tok)\n`)
process.stdout.write(`fold saving=${foldedSaving} chars\ndrop saving=${droppedSaving} chars\n`)
process.stdout.write(`predicted payload=${sum - foldedSaving - droppedSaving} chars (~${Math.round((sum - foldedSaving - droppedSaving) / 4)} tok)\n`)
