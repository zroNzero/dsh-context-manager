/**
 * SchemaIndex —— 工具 Schema 瘦身（MCP Tool Tax 治理）。
 *
 * 灵感来源：
 * - mcp-context-proxy / Bifrost-MCP-Gateway：MCP schema 每轮重复注入是截距大头；
 * - PenguinHarness《先压低上下文斜率》：同一会话内工具集必须固定，中途增删会让
 *   前缀缓存整体失效。
 *
 * 因此本模块**不做**每轮动态挑选工具（那会破坏 CacheAnchor 的前缀对齐红线），
 * 而是做确定性的描述压缩：工具名、参数结构、required 全部保留（能力无损），
 * 只把冗长的 description 截断到 maxDescriptionChars。同一请求输入永远得到同一输出，
 * 前缀哈希稳定，缓存不受影响。
 *
 * 可选的 selectStableToolSet 仅作为实验开关：按首轮意图固定一个子集，
 * 并在会话内保持稳定；默认关闭，避免模型在后续轮次需要被裁掉的工具。
 */

import { estimateTokens } from '../contracts'
import { logEvent } from '../log'
import type { RewriteResult } from './history-rewriter'
import { replayChunks, type ResponseCache } from './response-cache'
import { selectTools, selectToolsScout, selectionFromNames, withCatalog, SEARCH_TOOLS_DEF, firstSentence, type ToolLike, type ToolSelection } from './tool-attention'
import { planBudget, type ScopeBudget } from './scope'
import { sealState, intentBucket } from './osiris'
import { guardedStream } from './output-guard'

export interface SchemaStats {
  changed: number
  charsBefore: number
  charsAfter: number
  tokensSaved: number
}

export interface ToolSchemaLike {
  name?: string
  description?: string
  parameters?: unknown
  [key: string]: unknown
}

function truncateText(value: string, maxChars: number): string {
  const points = Array.from(value)
  if (points.length <= maxChars) return value
  return `${points.slice(0, maxChars).join('')}…`
}

function walk(value: unknown, maxChars: number, stats: { changed: number; removed: number }): unknown {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((entry) => walk(entry, maxChars, stats))
  if (!value || typeof value !== 'object') return value

  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (key === 'description' && typeof entry === 'string') {
      const truncated = truncateText(entry, maxChars)
      if (truncated !== entry) {
        stats.changed += 1
        stats.removed += Array.from(entry).length - Array.from(truncated).length
      }
      out[key] = truncated
      continue
    }
    out[key] = walk(entry, maxChars, stats)
  }
  return out
}

/**
 * 确定性描述压缩：只截断 description 字段，其它 schema 内容原样保留。
 * 同样的 tools 输入永远得到同样的输出（可安全用于前缀缓存）。
 */
export function compressToolSchemas(tools: readonly ToolSchemaLike[], maxDescriptionChars = 120): { tools: ToolSchemaLike[]; stats: SchemaStats } {
  const before = JSON.stringify(tools)
  const stats = { changed: 0, removed: 0 }
  const compressed = tools.map((tool) => walk(tool, maxDescriptionChars, stats) as ToolSchemaLike)
  const after = JSON.stringify(compressed)
  const charsBefore = Array.from(before).length
  const charsAfter = Array.from(after).length

  return {
    tools: compressed,
    stats: {
      changed: stats.changed,
      charsBefore,
      charsAfter,
      tokensSaved: Math.max(0, Math.ceil(charsBefore / 4) - Math.ceil(charsAfter / 4)),
    },
  }
}

function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as any
    if (message?.role !== 'user' && message?.message?.role !== 'user') continue
    const content = message?.content ?? message?.message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content.map((block: any) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('')
    }
  }
  return ''
}

/** 极简意图关键词表：用于实验性工具子集选择（默认不启用）。 */
const INTENT_KEYWORDS: Record<string, RegExp> = {
  read: /(分析|查看|读取|排查|定位|源码|文件|describe|read|inspect)/i,
  mutate: /(修改|修复|实现|重构|写入|删除|edit|write|fix|refactor)/i,
  run: /(运行|执行|测试|build|test|run|execute)/i,
}

/**
 * 实验特性：按首轮意图固定一个稳定工具子集（会话内不再变化）。
 * 默认关闭 —— 中途增删工具会破坏前缀缓存，且后续轮次可能缺工具。
 */
export function selectStableToolSet(
  tools: readonly ToolSchemaLike[],
  prompt: string,
  options: { topK?: number; alwaysKeep?: readonly string[] } = {},
): { tools: ToolSchemaLike[]; hidden: string[] } {
  const topK = options.topK ?? 12
  const alwaysKeep = new Set(options.alwaysKeep ?? ['read', 'bash', 'pwsh', 'write', 'edit', 'todo_write'])
  if (tools.length <= topK) return { tools: [...tools], hidden: [] }

  const wanted = new Set<string>()
  for (const [tag, pattern] of Object.entries(INTENT_KEYWORDS)) {
    if (pattern.test(prompt)) wanted.add(tag)
  }

  const scored = tools.map((tool) => {
    const name = String(tool.name ?? '')
    const description = String(tool.description ?? '')
    let score = alwaysKeep.has(name) ? 100 : 0
    if (wanted.has('read') && /(read|grep|glob|search|list|view)/i.test(name)) score += 10
    if (wanted.has('mutate') && /(write|edit|apply|patch|delete|move|rename)/i.test(name)) score += 10
    if (wanted.has('run') && /(bash|sh|run|exec|test)/i.test(name)) score += 10
    if (prompt.length > 0 && (name.length > 0 && prompt.toLowerCase().includes(name.toLowerCase()))) score += 5
    score += Math.min(5, description.length / 200)
    return { tool, score, name }
  })

  scored.sort((a, b) => b.score - a.score)
  const kept = scored.slice(0, topK)
  const keptNames = new Set(kept.map((entry) => entry.name))
  return {
    tools: kept.map((entry) => entry.tool),
    hidden: tools.filter((tool) => !keptNames.has(String(tool.name ?? ''))).map((tool) => String(tool.name ?? '')),
  }
}

export interface SchemaCompressorOptions {
  enabled?: boolean
  maxDescriptionChars?: number
  /** 实验：固定工具子集，默认 false。 */
  selectionEnabled?: boolean
  topK?: number
  /** 每次压缩成功后回调节省的 token（用于 SavingsLedger）。 */
  onSavings?: (tokens: number) => void
  /** 每次请求回调 prompt token 的压缩前/后统计（用于面板比例）。 */
  onRequest?: (event: {
    sessionId: string
    beforeTokens: number
    afterTokens: number
    savedTokens: number
    toolsBeforeTokens: number
    toolsAfterTokens: number
    rewriteSaved?: number
    rewriteBeforeTokens?: number
    rewriteAfterTokens?: number
  }) => void
  /** 请求级历史重写（v1.2）：只改 messages 内容，不删除/重排消息。 */
  rewriteHistory?: (messages: any, budget?: ScopeBudget) => RewriteResult | null
  /** 精确哈希响应缓存（v1.2）：命中时直接重放 chunk。 */
  responseCache?: ResponseCache
  onCacheHit?: () => void
  /** 语义缓存命中回调（v1.3）。 */
  onSemanticHit?: (score: number) => void
  /** 工具懒加载（v1.3）：只注入 top-K 完整 schema，其余进目录。 */
  toolAttention?: { enabled?: boolean; topK?: number }
  /** 把完整工具表回传给宿主，供 search_tools 元工具查询。 */
  onToolCatalog?: (tools: ToolLike[]) => void
  /** 输出端硬截断（v2.0）：超过 maxTokens 或 JSON/代码块闭合后立即停止。 */
  outputGuard?: { enabled?: boolean; maxTokens: number }
  onOutputTruncated?: (reason: 'max_tokens' | 'json_closed' | 'code_closed') => void
  /**
   * provider 真实 usage 回调（Gate 1）：只有流里真的出现 `usage` chunk 才回调，
   * 并同时给出同一请求压缩前/后的载荷字符数，供 BillingLedger 实测校准。
   */
  onUsage?: (info: {
    purpose: string
    model: string
    usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
    beforeChars: number
    afterChars: number
  }) => void
}

/** 模型可见载荷的字符数（system + messages + tools），用于真实账本的字符比校准。 */
function payloadChars(request: any): number {
  if (!request) return 0
  const system = typeof request.system === 'string' ? request.system.length : 0
  let messages = 0
  let tools = 0
  try {
    messages = Array.isArray(request.messages) ? JSON.stringify(request.messages).length : 0
  } catch {
    messages = 0
  }
  try {
    tools = Array.isArray(request.tools) ? JSON.stringify(request.tools).length : 0
  } catch {
    tools = 0
  }
  return system + messages + tools
}

/** 粗略估算消息侧 token（4 字符/token），用于面板比例的分母。 */
function estimateMessagesTokens(messages: any): number {
  if (!Array.isArray(messages)) return 0
  let chars = 0
  for (const message of messages) {
    const content = (message as any)?.content
    if (typeof content === 'string') {
      chars += content.length
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (typeof (block as any)?.text === 'string') chars += (block as any).text.length
    }
  }
  return Math.ceil(chars / 4)
}

/** 第二层：签名（参数名 + 类型，不含嵌套 schema/描述细节）。 */
function signatureTool(tool: ToolLike): ToolLike {
  const parameters = (tool as any).parameters ?? {}
  const properties = parameters.properties ?? {}
  const signatureProperties: Record<string, any> = {}
  for (const [key, value] of Object.entries<any>(properties)) {
    signatureProperties[key] = { type: value?.type ?? 'any' }
  }
  return {
    ...tool,
    description: firstSentence(tool.description ?? '', 60),
    parameters: { type: 'object', properties: signatureProperties, required: parameters.required ?? [] },
  } as ToolLike
}

/**
 * 包装 llm.stream / prepareCall：在请求发往适配器前压缩工具描述。
 * 失败安全：任何异常原样放行。
 */
export function installSchemaCompressor(ctx: any, options: SchemaCompressorOptions = {}): () => void {
  const enabled = options.enabled !== false
  const maxChars = options.maxDescriptionChars ?? 120
  const selectionEnabled = options.selectionEnabled === true
  const topK = options.topK ?? 12

  let llm: any
  try {
    llm = ctx?.llm ?? ctx?.get?.('llm')
  } catch {
    llm = undefined
  }
  if (!enabled) return () => {}
  if (!llm || typeof llm.stream !== 'function') {
    logEvent('warn', 'schema.unavailable', { module: 'SchemaIndex', reason: 'llm service not ready' })
    return () => {}
  }

  let lastLogKey = ''
  let lastBudgetKey = ''
  const anchors = new Map<string, { bucket: string; names: string[] }>()
  const lastSeals = new Map<string, string>()

  const transform = (request: any): any => {
    try {
      if (!request) return request
      const sessionKey = String(request.sessionId ?? 'unknown')
      const rawMessagesTokens = estimateMessagesTokens(request.messages)
      const toolsTokensBefore = Math.ceil(JSON.stringify(request.tools ?? []).length / 4)
      const totalTokens = rawMessagesTokens + toolsTokensBefore
      const budget = planBudget(totalTokens, toolsTokensBefore)
      const budgetKey = `${sessionKey}:${Math.floor(totalTokens / 2000)}`
      if (budgetKey !== lastBudgetKey) {
        lastBudgetKey = budgetKey
        logEvent('info', 'scope.budget', { module: 'SCOPE', sessionId: sessionKey, ...budget })
      }

      const rewrite = options.rewriteHistory?.(request.messages, budget) ?? null
      let messages = rewrite?.messages ?? request.messages
      const rewriteSaved = rewrite?.saved ?? 0
      const rewriteBeforeTokens = rewrite?.beforeTokens ?? rawMessagesTokens
      const bucketPrompt = lastUserText(messages) ?? ''
      const bucket = intentBucket(bucketPrompt)
      let attendedTools: any[] | null = null
      let selection: ToolSelection | null = null

      if (options.toolAttention?.enabled && Array.isArray(request.tools) && request.tools.length > 1) {
        const previous = anchors.get(sessionKey)
        if (previous && previous.bucket === bucket) {
          selection = selectionFromNames(request.tools as ToolLike[], previous.names)
          if (selection) {
            logEvent('info', 'osiris.anchor', {
              module: 'OSIRIS',
              sessionId: sessionKey,
              bucket: previous.bucket,
              tools: previous.names.length,
              reused: true,
            })
          }
        }
        if (!selection) {
          selection = selectToolsScout(request.tools as ToolLike[], bucketPrompt, options.toolAttention.topK ?? 5)
          anchors.set(sessionKey, { bucket, names: selection.selected.map((tool) => tool.name) })
          logEvent('info', 'scout.route', {
            module: 'SCOUT',
            sessionId: sessionKey,
            bucket,
            total: request.tools.length,
            selected: selection.selected.length,
            top: selection.scoreboard.slice(0, 5),
          })
        }
        if (selection.hidden.length > 0) {
          const selectedNames = selection.selected.map((tool) => tool.name).filter((name) => name !== 'search_tools')
          const fullNames = selectedNames.slice(0, 3)
          const signatureNames = selectedNames.slice(3, 10)
          const byName = new Map((request.tools as ToolLike[]).map((tool) => [tool.name, tool]))
          const fullTools = fullNames.map((name) => byName.get(name)).filter((tool): tool is ToolLike => tool !== undefined)
          const signatureTools = signatureNames
            .map((name) => byName.get(name))
            .filter((tool): tool is ToolLike => tool !== undefined)
            .map(signatureTool)
          const included = new Set([...fullNames, ...signatureNames, 'search_tools'])
          const hiddenTools = (request.tools as ToolLike[]).filter((tool) => !included.has(tool.name))
          const catalog = hiddenTools.map((tool) => `- ${tool.name}: ${firstSentence(tool.description ?? '')}`)
          const layered = [...fullTools, ...signatureTools, SEARCH_TOOLS_DEF]
          messages = withCatalog(messages, [
            ...catalog,
            '[TOOL_NOT_LOADED] 未列出的工具必须先调用 search_tools 拉取完整 schema；直接调用会收到 TOOL_NOT_LOADED 提示。',
          ])
          options.onToolCatalog?.(request.tools as ToolLike[])
          attendedTools = layered
          logEvent('info', 'tool_attention.layered', {
            module: 'ToolAttention',
            total: request.tools.length,
            full: fullTools.length,
            signature: signatureTools.length,
            hidden: hiddenTools.length,
            fullTools: fullNames,
          })
        }
      }

      const seal = sealState({
        messages,
        tools: attendedTools ?? request.tools ?? [],
        bucket,
        keepRecent: budget.retainRecent,
      })
      const sealKey = `${seal.systemHash}|${seal.toolsHash}|${seal.historyHash}`
      const previousSeal = lastSeals.get(sessionKey)
      if (sealKey !== previousSeal) {
        lastSeals.set(sessionKey, sealKey)
        logEvent('info', 'osiris.seal', {
          module: 'OSIRIS',
          sessionId: sessionKey,
          ...seal,
          changed: previousSeal !== undefined,
        })
      }

      const messagesTokens = estimateMessagesTokens(messages)
      if (!Array.isArray(request.tools) || request.tools.length === 0) {
        options.onRequest?.({
          sessionId: String(request.sessionId ?? ''),
          beforeTokens: rewriteBeforeTokens,
          afterTokens: messagesTokens,
          savedTokens: 0,
          toolsBeforeTokens: 0,
          toolsAfterTokens: 0,
          rewriteSaved,
          rewriteBeforeTokens,
          rewriteAfterTokens: messagesTokens,
        })
        return rewrite ? { ...request, messages } : request
      }

      const toolsBeforeChars = JSON.stringify(request.tools).length

      let tools = (attendedTools ?? request.tools) as ToolSchemaLike[]
      let hidden: string[] = []
      if (selectionEnabled) {
        const selected = selectStableToolSet(tools, lastUserText(request.messages), { topK })
        tools = selected.tools
        hidden = selected.hidden
      }

      const compressed = compressToolSchemas(tools, maxChars)
      const toolsBeforeTokens = Math.ceil(toolsBeforeChars / 4)
      const toolsAfterTokens = Math.ceil(JSON.stringify(compressed.tools).length / 4)
      options.onRequest?.({
        sessionId: String(request.sessionId ?? ''),
        beforeTokens: rewriteBeforeTokens + toolsBeforeTokens,
        afterTokens: messagesTokens + toolsAfterTokens,
        savedTokens: compressed.stats.tokensSaved,
        toolsBeforeTokens,
        toolsAfterTokens,
        rewriteSaved,
        rewriteBeforeTokens,
        rewriteAfterTokens: messagesTokens,
      })
      if (compressed.stats.changed === 0 && hidden.length === 0) return request
      options.onSavings?.(compressed.stats.tokensSaved)

      const logKey = `${request.sessionId ?? 'unknown'}:${compressed.stats.charsAfter}:${hidden.length}`
      if (logKey !== lastLogKey) {
        lastLogKey = logKey
        logEvent('info', 'schema.compressed', {
          module: 'SchemaIndex',
          sessionId: request.sessionId ?? 'unknown',
          tools: compressed.tools.length,
          hidden: hidden.length,
          changedDescriptions: compressed.stats.changed,
          tokensSaved: compressed.stats.tokensSaved,
          charsBefore: compressed.stats.charsBefore,
          charsAfter: compressed.stats.charsAfter,
        })
      }

      return { ...request, messages, tools: compressed.tools }
    } catch (error) {
      logEvent('warn', 'schema.compress_failed', { error: String(error) })
      return request
    }
  }

  const originalStream = llm.stream
  const originalPrepare = llm.prepareCall

  const observeUsage = (chunk: any, optimized: any, beforeChars: number, afterChars: number): void => {
    if (!options.onUsage || chunk?.type !== 'usage' || !chunk.usage) return
    try {
      options.onUsage({
        purpose: String(optimized?.purpose ?? 'agent-loop'),
        model: String(optimized?.model ?? ''),
        usage: chunk.usage,
        beforeChars,
        afterChars,
      })
    } catch (error) {
      logEvent('warn', 'billing.usage_failed', { module: 'Billing', error: String(error) })
    }
  }

  /** 在透传 chunk 的同时把 provider usage 交给真实账本；不改动流本身。 */
  const invokeMeasured = (invoke: (request: any) => any, optimized: any, beforeChars: number, afterChars: number): any => {
    const source = invoke(optimized)
    if (!source || typeof source[Symbol.asyncIterator] !== 'function') return source
    return (async function* () {
      for await (const chunk of source) {
        observeUsage(chunk, optimized, beforeChars, afterChars)
        yield chunk
      }
    })()
  }

  const runOptimized = (invoke: (request: any) => any, request: any): any => {
    const beforeChars = payloadChars(request)
    const optimized = transform(request)
    const afterChars = payloadChars(optimized)
    const cache = options.responseCache
    if (!cache) return invokeMeasured(invoke, optimized, beforeChars, afterChars)
    let key: string
    try {
      key = cache.keyFor(optimized)
    } catch {
      return invokeMeasured(invoke, optimized, beforeChars, afterChars)
    }
    const hit = cache.get(key)
    if (hit) {
      options.onCacheHit?.()
      return replayChunks(hit)
    }
    const semanticText = `${optimized?.model ?? ''} ${lastUserText(optimized?.messages) ?? ''} ${(optimized?.tools ?? [])
      .map((tool: any) => tool?.name ?? '')
      .join(' ')}`
    const similar = cache.findSimilar(semanticText)
    if (similar) {
      options.onSemanticHit?.(similar.score)
      return replayChunks(similar.chunks)
    }
    const source = invoke(optimized)
    const stream = options.outputGuard
      ? guardedStream(source, {
          maxTokens: options.outputGuard.maxTokens,
          enabled: options.outputGuard.enabled,
          onTruncate: options.onOutputTruncated,
        })
      : source
    return (async function* () {
      const chunks: any[] = []
      for await (const chunk of stream) {
        observeUsage(chunk, optimized, beforeChars, afterChars)
        chunks.push(chunk)
        yield chunk
      }
      cache.set(key, chunks, semanticText)
    })()
  }

  try {
    llm.stream = function patchedStream(this: any, request: any) {
      const self = this
      return runOptimized((optimized) => originalStream.call(self, optimized), request)
    }
    if (typeof originalPrepare === 'function') {
      llm.prepareCall = async function patchedPrepare(this: any, config: any, signal?: any, configure?: any) {
        const prepared = await originalPrepare.call(this, config, signal, configure)
        if (!prepared || typeof prepared.stream !== 'function') return prepared
        const preparedStream = prepared.stream
        return {
          ...prepared,
          stream: (request: any) => runOptimized((optimized) => preparedStream.call(prepared, optimized), request),
        }
      }
    }
  } catch (error) {
    logEvent('warn', 'schema.install_failed', { error: String(error) })
    return () => {}
  }

  return () => {
    try {
      llm.stream = originalStream
      if (typeof originalPrepare === 'function') llm.prepareCall = originalPrepare
    } catch {}
  }
}

/** 供 demo 使用：估算一组 schema 的 token 数。 */
export function schemaTokens(tools: readonly ToolSchemaLike[]): number {
  return estimateTokens(JSON.stringify(tools))
}
