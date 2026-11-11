#!/usr/bin/env node
/**
 * 在「最近一次请求的上下文预算」里，把 assistant 消息拆成 reasoning / text / tool-call 三类。
 * 这决定前缀压缩的上限：reasoning 受宿主契约保护（thinking 必须原样回传），
 * 只有 text 和旧 tool-call 参数是潜在可压的。
 *
 * 用法：node tools/assistant-split.mjs <session.v4.jsonl.zstd> [charBudget=650000]
 */
import { readSessionEvents } from './session-decode.mjs'

const file = process.argv[2]
const budget = Number(process.argv[3] ?? 650000)
if (!file) {
  process.stderr.write('usage: node tools/assistant-split.mjs <session.v4.jsonl.zstd> [charBudget]\n')
  process.exit(2)
}

const { events } = readSessionEvents(file)
const CONVERSATION = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message', 'developer/message'])
const rows = []
for (const event of events) {
  const type = String(event?.type ?? '')
  if (!CONVERSATION.has(type)) continue
  const payload = event?.data?.message ?? event?.data?.result ?? event?.data?.content ?? event?.data ?? ''
  rows.push({ type, payload })
}

const kept = []
let sum = 0
for (let index = rows.length - 1; index >= 0; index -= 1) {
  const chars = JSON.stringify(rows[index].payload).length
  if (sum + chars > budget) break
  sum += chars
  kept.push(rows[index])
}

const split = { reasoning: 0, text: 0, toolCall: 0, other: 0, messages: 0, withThinking: 0 }
for (const row of kept) {
  if (row.type !== 'assistant/message') continue
  split.messages += 1
  const content = row.payload?.content
  if (!Array.isArray(content)) {
    split.other += JSON.stringify(content ?? '').length
    continue
  }
  let hasThinking = false
  for (const block of content) {
    const chars = JSON.stringify(block?.text ?? block?.arguments ?? block ?? '').length
    if (block?.type === 'reasoning' || block?.type === 'thinking') {
      split.reasoning += chars
      hasThinking = true
    } else if (block?.type === 'tool-call') split.toolCall += chars
    else if (block?.type === 'text') split.text += chars
    else split.other += chars
  }
  if (hasThinking) split.withThinking += 1
}

const total = Math.max(1, split.reasoning + split.text + split.toolCall + split.other)
process.stdout.write(`assistant messages in budget: ${split.messages} (with thinking: ${split.withThinking})\n\n`)
process.stdout.write('| block | chars | share of assistant |\n|---|---:|---:|\n')
for (const [key, value] of [
  ['reasoning/thinking', split.reasoning],
  ['tool-call arguments', split.toolCall],
  ['text', split.text],
  ['other', split.other],
]) {
  process.stdout.write(`| ${key} | ${value} | ${((value / total) * 100).toFixed(1)}% |\n`)
}
