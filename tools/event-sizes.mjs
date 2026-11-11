#!/usr/bin/env node
/** 找出会话日志里体积最大的事件类型，定位「真正发出去的请求」存在哪。 */
import { readSessionEvents } from './session-decode.mjs'

const file = process.argv[2]
const { events } = readSessionEvents(file)
const byType = new Map()
for (const event of events) {
  const type = String(event?.type ?? '?')
  const size = JSON.stringify(event).length
  const slot = byType.get(type) ?? { count: 0, max: 0, total: 0, sample: '' }
  slot.count += 1
  slot.total += size
  if (size > slot.max) {
    slot.max = size
    slot.sample = JSON.stringify(event).slice(0, 300)
  }
  byType.set(type, slot)
}
const rows = [...byType.entries()].sort((a, b) => b[1].max - a[1].max).slice(0, 12)
for (const [type, slot] of rows) {
  console.log(`${String(slot.max).padStart(9)} max  ${String(slot.count).padStart(5)} events  ${type}`)
  console.log(`           ${slot.sample.replace(/\s+/g, ' ').slice(0, 240)}`)
}
