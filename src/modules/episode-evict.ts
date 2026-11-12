/**
 * EpisodeEvict —— 已完成的工具调用「整对逐出」（武器库 #14 CWL / #15 AgentDiet）。
 *
 * 问题：`write` / `edit` 的 tool-call 参数里装着**整个文件内容**。实测本会话
 * tool-call 参数合计 701,535 字符，其中 600 字符以上的占 492,260 字符——
 * 而那些文件早已写到磁盘上了。每个请求都要按缓存价把这份历史重读一遍。
 *
 * 为什么不能像 v1.4 那样只换参数：模型拿历史当模仿模板。把参数换成收据后，
 * 它照着把自己的调用也写成收据，宿主判 `MALFORMED_RESPONSE`（tool input is
 * invalid JSON），整轮失败。教训是 **assistant 的 tool-call 结构不能变成假形状**。
 *
 * 所以这里不「改」调用，而是把「调用 + 它的结果」**成对删掉**：
 *   - 配对完整性：assistant 的 tool-call 与其 tool 结果同时移除，不会留下孤儿
 *     tool 消息（那会被 provider 拒）；
 *   - 模仿安全：历史里不再出现这个调用的任何形状，模型无从模仿错误范式；
 *   - 无损：整对内容先落盘，assistant 消息里留一行纯文本指针
 *     `[evicted tool episode → episode-<hash>.json]`，需要时 read 读回；
 *   - 字节稳定：指针文本是「这一对内容」的纯函数，同一对永远产出同一行，
 *     且逐出发生在保留边界附近（尾部），不会把整段前缀打散导致缓存全灭。
 */

import fs from 'node:fs'
import path from 'node:path'
import { hashText } from '../contracts'

export interface EpisodeEvictOptions {
  spillDir?: string
  /** 最近 N 条消息原样保留。 */
  retainRecent?: number
  /** 参数超过这个字符数的调用才整体逐出（小的保持原样，留住最近的操作脉络）。 */
  minArgChars?: number
}

export interface EpisodeEvictStats {
  episodes: number
  droppedMessages: number
  charsSaved: number
  files: string[]
  /** 配对校验没过、已整体放弃的那一轮（Fail-Closed 标记，供日志观测）。 */
  rejected?: boolean
}

const CALL_TYPES = new Set(['tool-call'])

/**
 * 配对完整性硬校验（Fail-Closed 的唯一依据）。
 *
 * 线上事故（2026-11-11 15:00Z）：逐出后整轮报
 * `INVALID_REQUEST: tool_use ids were found without tool_result blocks immediately after`。
 * 教训：任何「删消息」的优化都必须先能证明配对没被破坏，否则收益再大也不能上线。
 *
 * **按宿主报错的字面语义校验「紧随其后」**，而不是「之后某处」：
 * 每个含 tool-call 的 assistant 消息，其后连续的 tool 消息必须恰好覆盖它的全部 id，
 * 不多不少、顺序无关但必须相邻。多一条或少一条都算失败。
 */
export function assertToolPairing(messages: any[]): boolean {
  if (!Array.isArray(messages)) return false

  const resultIds = new Set<string>()
  messages.forEach((message) => {
    if (message?.role !== 'tool') return
    const id = String(message?.toolCallId ?? message?.tool_call_id ?? '')
    if (id) resultIds.add(id)
  })

  const callIds = new Set<string>()
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role !== 'assistant' || !Array.isArray(message?.content)) continue
    const ids: string[] = message.content
      .filter((block: any) => CALL_TYPES.has(String(block?.type ?? '')))
      .map((block: any) => String(block?.id ?? ''))
      .filter((id: string) => id.length > 0)
    if (ids.length === 0) continue

    for (const id of ids) callIds.add(id)
    // 紧随其后的连续 tool 消息必须正好覆盖这些 id
    const next: string[] = []
    let cursor = index + 1
    while (cursor < messages.length && messages[cursor]?.role === 'tool') {
      next.push(String(messages[cursor]?.toolCallId ?? messages[cursor]?.tool_call_id ?? ''))
      cursor += 1
    }
    const want = new Set<string>(ids)
    const got = new Set<string>(next)
    if (want.size !== got.size) return false
    for (const id of want) if (!got.has(id)) return false
  }

  // 反向：每个 tool 结果都必须有对应的 tool-call
  for (const id of resultIds) if (!callIds.has(id)) return false
  return true
}

function argText(value: any): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function contentText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((block: any) => (typeof block?.text === 'string' ? block.text : '')).join('\n')
  }
  return ''
}

export function evictOldEpisodes(
  messages: any[],
  options: EpisodeEvictOptions,
): { messages: any[]; stats: EpisodeEvictStats } {
  const stats: EpisodeEvictStats = { episodes: 0, droppedMessages: 0, charsSaved: 0, files: [] }
  const spillDir = options.spillDir
  if (!spillDir || !Array.isArray(messages) || messages.length === 0) return { messages, stats }

  const retain = Math.max(0, Math.trunc(options.retainRecent ?? 6))
  const minArgChars = Math.max(200, Math.trunc(options.minArgChars ?? 600))
  const cutoff = messages.length - retain
  if (cutoff <= 0) return { messages, stats }

  /** tool-call id -> 该 tool 结果所在下标（全表，用于判断配对是否完整）。 */
  const resultIndex = new Map<string, number>()
  messages.forEach((message, index) => {
    if (message?.role !== 'tool') return
    // 只用 toolCallId：tool 消息自己还有一个 uuid 形式的 `id`，拿它兜底会误配对。
    const id = String(message?.toolCallId ?? message?.tool_call_id ?? '')
    if (id) resultIndex.set(id, index)
  })

  const drop = new Set<number>()
  const out = messages.slice()

  for (let index = 0; index < cutoff; index += 1) {
    const message = out[index]
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    const calls = message.content.filter((block: any) => CALL_TYPES.has(String(block?.type ?? '')))
    if (calls.length === 0) continue
    /**
     * 只在「这条 assistant 的所有调用都能逐出」时才动它。
     * 部分逐出会把一条消息切成「一半调用 + 指针」，是配对破坏的高危形态。
     */
    const bulk = calls.filter((block: any) => argText(block?.arguments).length > minArgChars)
    if (bulk.length !== calls.length) continue

    /**
     * 局部不变量：这些调用必须**正好**是紧随其后的那一段 tool 消息。
     * 满足它，则「整段删掉」等价于把一段相邻的调用/结果一起移除——
     * 相邻性对邻接消息依然成立，按归纳法全局配对不可能被破坏。
     * 这是让逐出「由构造保证安全」而不是「事后祈祷」的关键一步。
     */
    const adjacent: string[] = []
    let cursor = index + 1
    while (cursor < messages.length && messages[cursor]?.role === 'tool') {
      adjacent.push(String(messages[cursor]?.toolCallId ?? messages[cursor]?.tool_call_id ?? ''))
      cursor += 1
    }
    const want = new Set(bulk.map((block: any) => String(block?.id ?? '')))
    if (adjacent.length !== want.size) continue
    if (adjacent.some((id) => !want.has(id))) continue

    const matchedResults = bulk.map((block: any) => resultIndex.get(String(block?.id ?? '')) as number)
    let original = contentText(message.content)
    for (const resultAt of matchedResults) {
      original += `\n--- tool result ---\n${contentText(messages[resultAt]?.content)}`
    }
    let target: string
    try {
      const name = `episode-${hashText(original).slice(0, 12)}.json`
      const full = path.resolve(spillDir, name)
      if (!fs.existsSync(full)) {
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, JSON.stringify({ call: bulk, result: matchedResults.map((at: number) => messages[at]?.content) }, null, 2), 'utf8')
      }
      target = name
    } catch {
      continue
    }

    const keptIds = new Set(bulk.map((block: any) => String(block?.id ?? '')))
    const remaining = message.content.filter((block: any) => !keptIds.has(String(block?.id ?? '')))
    const labels = bulk.map((block: any) => String(block?.name ?? '?')).join(', ')
    const pointer = `[evicted tool episode (${labels}) -> ${target}]`
    const nextContent =
      remaining.length > 0
        ? [...remaining, { type: 'text', text: pointer }]
        : [{ type: 'text', text: pointer }]

    stats.charsSaved += bulk.reduce((sum: number, block: any) => sum + argText(block?.arguments).length, 0)
    for (const resultAt of matchedResults) {
      if (drop.has(resultAt)) continue
      drop.add(resultAt)
      stats.droppedMessages += 1
      stats.charsSaved += contentText(messages[resultAt]?.content).length
    }
    out[index] = { ...message, content: nextContent }
    stats.episodes += 1
    stats.files.push(target)
  }

  if (stats.episodes === 0) return { messages, stats }
  const pruned = out.filter((_message, index) => !drop.has(index))
  /**
   * Fail-Closed：只要配对校验不通过，就原样返回**未改动**的消息。
   * 宁可这一轮一分钱不省，也不能让宿主拿到一份会被它拒绝的消息表。
   */
  if (!assertToolPairing(pruned)) {
    return { messages, stats: { episodes: 0, droppedMessages: 0, charsSaved: 0, files: [], rejected: true } }
  }
  return { messages: pruned, stats }
}
