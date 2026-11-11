#!/usr/bin/env node
/** 按「最近 N 条」真实重建一次请求，打印 system / messages / tools 三段各多大。 */
import fs from 'node:fs'
import { readSessionEvents } from './session-decode.mjs'

const file = process.argv[2]
const { events } = readSessionEvents(file)

const lastSystem = events.filter((e) => e?.type === 'system/message').pop()
const systemText = JSON.stringify(lastSystem?.data?.message?.content ?? '')

const header = events.filter((e) => e?.type === 'request/header').pop()
const toolsText = JSON.stringify(header?.data?.config?.tools ?? header?.data?.tools ?? null)

const conversation = events.filter((e) =>
  ['user/message', 'assistant/message', 'tool/result', 'developer/message'].includes(String(e?.type)),
)
let messagesChars = 0
for (const event of conversation) {
  const payload = event?.data?.message ?? event?.data?.result ?? event?.data?.content ?? event?.data ?? ''
  messagesChars += JSON.stringify(payload).length
}

console.log(`system/message (latest) : ${systemText.length} chars`)
console.log(`tools (request/header)  : ${toolsText.length} chars`)
console.log(`conversation (all)      : ${messagesChars} chars`)
console.log(`header keys             : ${Object.keys(header?.data ?? {}).join(', ')}`)
