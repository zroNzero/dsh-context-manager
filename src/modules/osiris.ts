/**
 * OSIRIS —— 前缀缓存感知的状态密封（v2.0 正式版）。
 *
 * 三套哈希分别锚定 system / tools / history：
 * - systemHash：system prompt 段（通常稳定，漂移即关键变更）；
 * - toolsHash：工具集（动态选择时用它检测漂移）；
 * - historyHash：历史消息（按 retainRecent 截断后的稳定前缀）。
 *
 * 结合意图桶（bucket）实现「会话内工具集稳定」：同一 bucket 复用上一轮工具集，
 * 避免 Tool Attention 每轮换工具导致前缀缓存击穿。
 */

import { createHash } from 'node:crypto'
import { estimateTokens } from '../contracts'

export interface StateSeal {
  systemHash: string
  toolsHash: string
  historyHash: string
  bucket: string
  toolsTokens: number
  historyTokens: number
}

export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function systemText(messages: any[]): string {
  return (messages ?? [])
    .filter((message) => message?.role === 'system')
    .map((message) => {
      const content = message?.content
      if (typeof content === 'string') return content
      return Array.isArray(content) ? content.map((block: any) => block?.text ?? '').join('\n') : ''
    })
    .join('\n')
}

function historyText(messages: any[], keepRecent: number): string {
  const tail = (messages ?? []).slice(-Math.max(1, keepRecent))
  return tail
    .map((message) => {
      const content = message?.content
      if (typeof content === 'string') return `${message?.role}:${content}`
      if (!Array.isArray(content)) return `${message?.role}:`
      return `${message?.role}:${content.map((block: any) => block?.text ?? block?.type ?? '').join('\u0001')}`
    })
    .join('\u0002')
}

export function sealState(input: {
  messages: any[]
  tools: any[]
  bucket: string
  keepRecent?: number
}): StateSeal {
  const keep = Math.max(1, input.keepRecent ?? 8)
  return {
    systemHash: shortHash(systemText(input.messages)),
    toolsHash: shortHash((input.tools ?? []).map((tool) => tool?.name ?? '').join(',')),
    historyHash: shortHash(historyText(input.messages, keep)),
    bucket: input.bucket,
    toolsTokens: estimateTokens(JSON.stringify(input.tools ?? [])),
    historyTokens: estimateTokens(historyText(input.messages, keep)),
  }
}

/** 意图桶：取查询词的稳定集合，避免同义改写导致桶抖动。 */
export function intentBucket(prompt: string, depth = 6): string {
  const tokens = String(prompt ?? '')
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter((token) => token.length > 1)
  const unique = [...new Set(tokens)].slice(0, depth).sort()
  return shortHash(unique.join('|'))
}
