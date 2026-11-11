#!/usr/bin/env node
/** 打印失败轮次附近的 assistant/attempt 与 turn/end，确认失败点。 */
import { readSessionEvents } from './session-decode.mjs'

const file = process.argv[2]
const tail = Number(process.argv[3] ?? 12)
const { events } = readSessionEvents(file)
for (const event of events.slice(-tail)) {
  const payload = JSON.stringify(event).slice(0, 600)
  console.log(payload)
}
