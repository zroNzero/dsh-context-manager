#!/usr/bin/env node
/** system/message 事件的体积与文本，用来判断系统提示词是不是那个「看不见的大头」。 */
import { readSessionEvents } from './session-decode.mjs'

const file = process.argv[2]
const { events } = readSessionEvents(file)
const systems = events.filter((e) => e?.type === 'system/message')
console.log('system/message count:', systems.length)
let total = 0
for (const event of systems) {
  const size = JSON.stringify(event?.data?.message?.content ?? event?.data ?? '').length
  total += size
  const head = JSON.stringify(event?.data?.message?.content ?? '').slice(0, 100).replace(/\s+/g, ' ')
  console.log(`${String(size).padStart(7)} chars  ${head}`)
}
console.log('total chars:', total)
