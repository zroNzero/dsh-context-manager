/**
 * MemoryModule —— 计划感知折叠 + 历史 CoT 蒸馏（v3.5）。
 *
 * 两刀：
 * 1. CoT Distill：历史消息里的 <thought>/<thinking>/[思考] 块被剪成一行
 *    `[决策: ...]` 状态结论，冗长推理从上下文中物理移除；
 * 2. DAG 折叠：连续的中段 ATTEMPT/FAILURE 折叠为一条摘要 Patch。
 *
 * 永远不动：全部 user 需求（REQUIREMENT）、最近 retainRecent 条、最后一条 assistant 结论。
 */

import { hashText, type Patch } from '../contracts'
import { logEvent } from '../log'
import { buildContextIndex, isEmptyIndex, renderContextIndex } from './context-index'

export interface MemoryEntry {
  seq: number
  role: string
  text: string
  isError?: boolean
  /** 消息来源种类（user / agent-message / runtime-context…），用于角色感知保留窗口。 */
  sourceKind?: string
  /** 是否包含 tool-call 块。带工具调用的 assistant 消息绝不能折叠（会留下孤儿 tool/call）。 */
  hasToolCall?: boolean
}

export interface MemoryPlan {
  patch: Patch | null
  foldedSeqs: number[]
  foldedMessages: number
  tokensBefore: number
  tokensAfter: number
  tokensSaved: number
  summary: string
  /** CoT 蒸馏统计。 */
  cotSegments: number
  cotCharsBefore: number
  cotCharsAfter: number
  cotSavedTokens: number
  /** 摘要是否包含结构化任务状态卡。 */
  indexIncluded?: boolean
  /** 质量校验：关键约束是否全部保留在摘要中。 */
  qualityPass?: boolean
}

export interface DistillResult {
  text: string
  segments: number
  removedChars: number
  keptChars: number
}

const FAILURE_RE =
  /(?:^|\s)(?:Error:|Exception:|Traceback\b|FAILED\b|panic!|AssertionError|失败|报错)|\[exit code:\s*(?!0\b)-?\d+\]/i
const DECISION_RE = /(?:决定|结论|采用|改用|方案|修复|should use|decided|decision|approach)/i
const CONSTRAINT_RE = /(?:[A-Za-z]:\\[^\s"']+|TODO:|FIXME:|[0-9a-f]{8}-[0-9a-f]{4}-)/i

const THOUGHT_RE = /<(thought|thinking)>([\s\S]*?)<\/\1>|\[思考\]([\s\S]*?)\[\/思考\]/gi

function estimate(text: string): number {
  return Math.ceil(Array.from(text).length / 4)
}

function preview(text: string, limit: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length === 0) return '(空)'
  const points = Array.from(compact)
  return points.length > limit ? `${points.slice(0, limit).join('')}…` : compact
}

function pick(texts: string[], pattern: RegExp, limit: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const text of texts) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.replace(/\s+/g, ' ').trim()
      if (trimmed.length < 6 || trimmed.length > 200) continue
      if (!pattern.test(trimmed)) continue
      const key = trimmed.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(Array.from(trimmed).slice(0, 110).join(''))
      if (out.length >= limit) return out
    }
  }
  return out
}

/**
 * 把一段思考压成一行状态结论：优先保留决策/结论句，否则取首个有效片段。
 * 输出永远不含原始 <thought> 标签。
 */
function distillThoughtBlock(raw: string): string {
  const compact = raw.replace(/\s+/g, ' ').trim()
  if (compact.length === 0) return '[决策: (空思考)]'

  const sentences = compact.split(/(?<=[。！？.!?])\s+/).filter((part) => part.length > 0)
  const decision = sentences.find((part) => DECISION_RE.test(part))
  const source = decision ?? sentences[0] ?? compact
  return `[决策: ${Array.from(source).slice(0, 70).join('')}]`
}

/** 蒸馏单条文本里的全部思考块；返回文本与真实字符/片段统计。 */
export function distillThoughts(text: string): DistillResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { text, segments: 0, removedChars: 0, keptChars: 0 }
  }

  let segments = 0
  let removedChars = 0
  let keptChars = 0

  const next = text.replace(THOUGHT_RE, (_match, _tag: string, thought: string, square: string) => {
    const body = String(thought ?? square ?? '')
    segments += 1
    removedChars += Array.from(body).length
    const distilled = distillThoughtBlock(body)
    keptChars += Array.from(distilled).length
    return distilled
  })

  return { text: next, segments, removedChars, keptChars }
}

export function planMemoryFold(
  entries: readonly MemoryEntry[],
  options: { retainRecent?: number; minSaveTokens?: number } = {},
): MemoryPlan {
  const retainRecent = options.retainRecent ?? 8
  const minSaveTokens = options.minSaveTokens ?? 200

  const empty: MemoryPlan = {
    patch: null,
    foldedSeqs: [],
    foldedMessages: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    tokensSaved: 0,
    summary: '',
    cotSegments: 0,
    cotCharsBefore: 0,
    cotCharsAfter: 0,
    cotSavedTokens: 0,
  }
  if (entries.length === 0) return empty

  const tokensBefore = entries.reduce((sum, entry) => sum + estimate(entry.text), 0)

  let lastAssistant = -1
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]!.role === 'assistant') {
      lastAssistant = index
      break
    }
  }

  // 候选：非 user、不在保留窗口、不是最后结论。
  // 安全边界（2026-11-10 事故修复）：tool/call 事件是日志级、不在 surface 上，
  // 折叠带 tool-call 的 assistant 会留下孤儿 tool/call，导致 DeepSeek 报
  // "tool calls need immediate results"。因此带 tool-call 的 assistant 与所有
  // tool 结果一律不参与折叠，只折叠纯文本 / CoT 消息。
  let blockedByToolCall = 0
  const flags: boolean[] = entries.map((entry, index) => {
    if (entry.role === 'user') return false
    if (entry.role === 'tool') {
      blockedByToolCall += 1
      return false
    }
    if (entry.role === 'system') return false
    if (entry.hasToolCall === true) {
      blockedByToolCall += 1
      return false
    }
    if (index >= entries.length - retainRecent) return false
    if (index === lastAssistant) return false
    if (entry.text.trim().length === 0) return false
    return true
  })

  // 只取最长的一段连续候选：surface replacement 必须落在连续节点区间上。
  let bestStart = -1
  let bestLength = 0
  let runStart = -1
  for (let index = 0; index <= entries.length; index += 1) {
    const isCandidate = index < entries.length && flags[index] === true
    if (isCandidate) {
      if (runStart < 0) runStart = index
      continue
    }
    if (runStart >= 0) {
      const length = index - runStart
      if (length > bestLength) {
        bestLength = length
        bestStart = runStart
      }
      runStart = -1
    }
  }

  const candidates: MemoryEntry[] = bestStart >= 0 ? entries.slice(bestStart, bestStart + bestLength) : []

  // 二次防线：即使上方 flags 被改坏，也绝不把 tool-call / tool 结果放进补丁。
  if (candidates.some((entry) => entry.hasToolCall === true || entry.role === 'tool')) {
    logEvent('warn', 'memory.pairing_rejected', {
      module: 'Memory',
      reason: 'candidate range contains tool-call or tool result',
      blockedByToolCall,
    })
    return { ...empty, tokensBefore, tokensAfter: tokensBefore }
  }

  if (candidates.length === 0) return { ...empty, tokensBefore, tokensAfter: tokensBefore }

  // CoT 蒸馏：先剪思考块，再做摘要。
  let cotSegments = 0
  let cotCharsBefore = 0
  let cotCharsAfter = 0
  const distilled = candidates.map((entry) => {
    const result = distillThoughts(entry.text)
    cotSegments += result.segments
    cotCharsBefore += result.removedChars
    cotCharsAfter += result.keptChars
    return { ...entry, text: result.text }
  })

  if (cotSegments > 0) {
    logEvent('info', 'memory.cot_distilled', {
      module: 'Memory',
      segments: cotSegments,
      charsBefore: cotCharsBefore,
      charsAfter: cotCharsAfter,
      savedTokens: Math.max(0, Math.ceil((cotCharsBefore - cotCharsAfter) / 4)),
    })
  }

  const decisions = pick(distilled.map((entry) => entry.text), DECISION_RE, 3)
  const constraints = pick(distilled.map((entry) => entry.text), CONSTRAINT_RE, 4)
  const errors = pick(
    distilled.filter((entry) => entry.isError === true || FAILURE_RE.test(entry.text)).map((entry) => entry.text),
    FAILURE_RE,
    3,
  )

  // “高智商”核心：把候选历史压成结构化任务状态卡，而不是裸摘要。
  const index = buildContextIndex(entries, 3)
  const indexBlock = isEmptyIndex(index) ? '' : renderContextIndex(index)

  const lines: string[] = []
  if (indexBlock) {
    lines.push(indexBlock)
    lines.push('')
  }
  lines.push(`[MEMORY] 已折叠 ${candidates.length} 条中间消息（约 ${tokensBefore} tokens 的历史尝试）。`)
  if (cotSegments > 0) {
    lines.push(`[CoT] 已蒸馏 ${cotSegments} 段思考（${cotCharsBefore} → ${cotCharsAfter} 字符）。`)
  }
  if (decisions.length > 0) lines.push(`[决策] ${decisions.join(' / ')}`)
  if (constraints.length > 0) lines.push(`[约束] ${constraints.join(' / ')}`)
  if (errors.length > 0) lines.push(`[错误锚点] ${errors.join(' / ')}`)
  lines.push('[原始内容已可从落盘文件恢复；如需细节请使用 read 工具。]')

  let summary = lines.join('\n')
  // 质量校验：状态卡里的每个硬约束必须出现在最终摘要中；缺失则补回，绝不静默丢约束。
  const missingConstraints = index.constraints.filter((value) => !summary.includes(value.replace(/…$/, '')))
  if (missingConstraints.length > 0) summary += `\n[约束] ${missingConstraints.join(' | ')}`
  const backfilled = missingConstraints.length
  const qualityPass = index.constraints.every((value) => summary.includes(value.replace(/…$/, '')))
  const tokensAfter = estimate(summary)
  const tokensSaved = tokensBefore - tokensAfter

  if (tokensSaved < minSaveTokens) {
    return { ...empty, tokensBefore, tokensAfter: tokensBefore, summary, cotSegments, cotCharsBefore, cotCharsAfter }
  }

  const first = candidates[0]!
  const patch: Patch = {
    patchId: `mem-${hashText(summary).slice(0, 12)}`,
    targetZone: 'dynamic_zone',
    diff: { op: 'fold', payload: summary, anchor: String(first.seq) },
    originModule: 'Memory',
    tokensSaved,
  }

  logEvent('info', 'memory.planned', {
    module: 'Memory',
    folded: candidates.length,
    tokensBefore,
    tokensAfter,
    tokensSaved,
    cotSegments,
    cotCharsBefore,
    cotCharsAfter,
    cotSavedTokens: Math.max(0, Math.ceil((cotCharsBefore - cotCharsAfter) / 4)),
    indexIncluded: indexBlock.length > 0,
    qualityPass,
    backfilled,
    toolcallExcluded: blockedByToolCall,
    patchId: patch.patchId,
  })

  return {
    patch,
    foldedSeqs: candidates.map((entry) => entry.seq),
    foldedMessages: candidates.length,
    tokensBefore,
    tokensAfter,
    tokensSaved,
    summary,
    cotSegments,
    cotCharsBefore,
    cotCharsAfter,
    cotSavedTokens: Math.max(0, Math.ceil((cotCharsBefore - cotCharsAfter) / 4)),
    indexIncluded: indexBlock.length > 0,
    qualityPass,
  }
}
