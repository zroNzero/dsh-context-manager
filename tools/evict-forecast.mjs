#!/usr/bin/env node
/**
 * 用真实会话消息预测「整对逐出」能省多少字符。只做算术，不发请求。
 *
 * 用法：node tools/evict-forecast.mjs <session.v4.jsonl.zstd> [retain=8] [minArg=600] [maxMessages=0]
 */
import { readSessionEvents } from './session-decode.mjs'

const [file, retainArg, minArgRaw, maxMessagesRaw] = process.argv.slice(2)
const retain = Number(retainArg ?? 8)
const minArg = Number(minArgRaw ?? 600)
const maxMessages = Number(maxMessagesRaw ?? 0)
if (!file) {
  process.stderr.write('usage: node tools/evict-forecast.mjs <session.v4.jsonl.zstd> [retain] [minArg] [maxMessages]\n')
  process.exit(2)
}

const { events } = readSessionEvents(file)

/** 重建 request.messages：tool 消息在 data.message 里，配对 id 叫 toolCallId。 */
const messages = []
for (const event of events) {
  const type = String(event?.type ?? '')
  if (type === 'user/message' || type === 'system/message' || type === 'developer/message') {
    messages.push({ role: type.replace('/message', ''), content: event?.data?.message?.content })
    continue
  }
  if (type === 'assistant/message') {
    messages.push({ role: 'assistant', content: event?.data?.message?.content })
    continue
  }
  if (type === 'tool/result') {
    const toolMessage = event?.data?.message ?? {}
    messages.push({ role: 'tool', toolCallId: toolMessage.toolCallId, content: toolMessage.content })
  }
}

const windowMessages = maxMessages > 0 ? messages.slice(-maxMessages) : messages
const size = (content) => (typeof content === 'string' ? content.length : JSON.stringify(content ?? '').length)
const before = windowMessages.reduce((sum, message) => sum + size(message.content), 0)

const resultIndex = new Map()
windowMessages.forEach((message, index) => {
  if (message.role !== 'tool' || !message.toolCallId) return
  resultIndex.set(message.toolCallId, index)
})

const cutoff = windowMessages.length - retain
const drop = new Set()
let episodes = 0
let saved = 0
let dropped = 0

for (let index = 0; index < cutoff; index += 1) {
  const message = windowMessages[index]
  if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
  const calls = message.content.filter((block) => String(block?.type) === 'tool-call')
  const bulk = calls.filter((block) => JSON.stringify(block?.arguments ?? '').length > minArg)
  if (bulk.length === 0) continue
  if (bulk.some((block) => !resultIndex.has(String(block?.id)))) continue
  for (const block of bulk) saved += JSON.stringify(block?.arguments ?? '').length
  for (const block of bulk) {
    const at = resultIndex.get(String(block?.id))
    if (drop.has(at)) continue
    drop.add(at)
    dropped += 1
    saved += size(windowMessages[at].content)
  }
  episodes += 1
}

const after = before - saved
console.log(`messages=${windowMessages.length}  window chars=${before}`)
console.log(`episodes evicted=${episodes}  dropped tool results=${dropped}`)
console.log(`saved=${saved} chars  (${((saved / Math.max(1, before)) * 100).toFixed(1)}% of messages)`)
console.log(`after≈${after} chars (~${Math.round(after / 4)} tokens)`)
console.log(`per-request hit saving at 0.02/M ≈ ¥${(((saved / 4) * 0.02) / 1e6).toFixed(6)}`)
