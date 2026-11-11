#!/usr/bin/env node
/** 打印含 token 字段的事件的原始形状，用来确认宿主 usage 的存放位置。 */
import { readSessionEvents } from './session-decode.mjs'

const file = process.argv[2]
const limit = Number(process.argv[3] ?? 3)
const { events } = readSessionEvents(file)
const hits = []
for (const event of events) {
  const text = JSON.stringify(event)
  if (!/"usage":\{/.test(text)) continue
  if (event?.type === 'tool/call' || event?.type === 'tool/result') continue
  hits.push(event)
}
process.stdout.write(`events=${events.length} hits=${hits.length}\n`)
for (const event of hits.slice(-limit)) {
  process.stdout.write(JSON.stringify(event).slice(0, 1200) + '\n\n')
}
