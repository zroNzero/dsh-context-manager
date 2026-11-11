/**
 * CostKillerOrchestrator 入口。
 *
 * 钩子编排：
 * - tools/post-execute: Admission（超大输出落盘）→ Extraction（约束 + 骨架/JSON/分节）
 * - agent/pre-step: Memory 折叠 → CacheAnchor 净收益门控 → 通过才提交 surface 补丁
 *
 * 铁律：
 * - 所有状态经 logEvent 写 ./debug.log，全工程无 console.log。
 * - 模块只产出 Patch；payload 永不被原地修改。
 * - 任何异常都 Fail-Open 到原行为，绝不阻断对话。
 */

import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  applyPatch,
  createEnvelope,
  estimateTokens,
  hashText,
  type ContextEnvelope,
  type Patch,
} from './contracts'
import { gatePatch } from './cacheAnchor'
import { logEvent } from './log'
import { runAdmission } from './modules/admission'
import { runExtraction, buildFirewallSummary } from './modules/extraction'
import { planMemoryFold, type MemoryEntry } from './modules/memory'
import { hasCrossFileDependency, RoutingModule } from './modules/routing'
import { collectGarbage } from './modules/spill-gc'
import { installSchemaCompressor } from './modules/schema-index'
import { CompressionBreaker } from './modules/breaker'
import { DedupBus, dedupeKey } from './modules/dedup-bus'
import { SavingsLedger } from './modules/savings-ledger'
import { workspaceRef, workspaceRefFromSession, type WorkspaceRef } from './modules/workspace'
import { rewriteMessages } from './modules/history-rewriter'
import { ResponseCache } from './modules/response-cache'

export const name = 'dsh-context-manager'
export const inject = ['systemPrompt', 'tools', 'sessions', 'agents']

export const Config = z.object({
  maxInputTokens: z.number().int().positive().default(100000),
  maxOutputTokens: z.number().int().positive().default(16000),
  /** 上下文占用超过 maxInputTokens * foldAtRatio 才允许折叠。 */
  foldAtRatio: z.number().gt(0).lte(1).default(0.6),
  /** 最近 N 条消息永不折叠。 */
  retainRecent: z.number().int().nonnegative().default(8),
  /** 单次折叠至少节省多少 token 才提交。 */
  minSaveTokens: z.number().int().nonnegative().default(100),
  /** 落盘目录（相对进程工作目录）。 */
  spillDir: z.string().default('./spill'),
  /** 单条工具输出超过该 token 数即准入落盘。 */
  admissionTokens: z.number().int().positive().default(800),
  /** 单条工具输出经萃取后的目标 token 上限。 */
  extractionTokens: z.number().int().positive().default(500),
  /** 上下文防火墙阈值：超过该 token 数的工具输出一律摘要化 + 落盘。 */
  firewallTokens: z.number().int().positive().default(250),
  /** 会话总回合数预估，用于 CacheAnchor 的寿命摊销（默认 40：约 2× 冷读回本线）。 */
  assumedTurns: z.number().int().positive().default(40),
  /** 请求级历史重写（v1.2）：只改 messages 内容，不动 session surface。 */
  rewriteEnabled: z.boolean().default(true),
  rewriteRetainRecent: z.number().int().positive().default(8),
  rewriteToolChars: z.number().int().positive().default(700),
  rewriteAssistantChars: z.number().int().positive().default(400),
  /** 精确哈希响应缓存（v1.2）：同一请求 5 分钟内直接重放。 */
  responseCacheEnabled: z.boolean().default(true),
  responseCacheTtlMs: z.number().int().positive().default(300_000),
  /** 语义缓存 Jaccard 阈值（v1.3）。 */
  semanticCacheThreshold: z.number().min(0.5).max(1).default(0.85),
  /** 工具懒加载（v1.3）：只注入 top-K 完整 schema。 */
  toolAttentionEnabled: z.boolean().default(true),
  toolAttentionTopK: z.number().int().positive().default(5),
  /** 本地 LLM 端点（v1.3 快速探测）。 */
  localBaseUrl: z.string().default('http://127.0.0.1:11434'),
  /** 是否真正发起本地路由请求（决策与日志始终开启）。 */
  localRouting: z.boolean().default(false),
  /** spill 目录保留的最大文件数。 */
  spillMaxFiles: z.number().int().positive().default(50),
  /** spill 文件 TTL（小时）。 */
  spillTtlHours: z.number().positive().default(24),
  /** 单次萃取的时间预算（毫秒）；超时退化为快速路径，避免阻塞主链路。 */
  compressionBudgetMs: z.number().int().positive().default(50),
  /** 去重总线容量。 */
  dedupCapacity: z.number().int().positive().default(256),
}).prefault({})

export type CostKillerConfig = z.infer<typeof Config>

const POLICY_TEXT = [
  'You are running with CostKillerOrchestrator active.',
  'Large tool outputs are replaced by a [ADMISSION] receipt holding the absolute spill path: use the read tool instead of re-running the command.',
  'Compressed history may contain [CORE_CONSTRAINTS] blocks; never drop, reorder, or rewrite those constraints.',
].join(' ')

interface Counters {
  admitted: number
  extracted: number
  folds: number
  savedTokens: number
  rejectedByAnchor: number
  deduped: number
}

interface SessionState {
  prefixHash: string
  folds: number
  /** 上一次 pre-step 时已进入请求的 surface 最大 seq（缓存边界）。 */
  lastSentSeq: number
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record.type === 'reasoning' || record.type === 'thinking') continue
    if (typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n')
}

function messageText(message: any): string {
  if (!message || typeof message !== 'object') return ''
  return textOfContent(message.content) || textOfContent(message.message?.content) || ''
}

function flattenPlainText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  let text = ''
  for (const block of content) {
    if (!block || typeof block !== 'object') return undefined
    const record = block as Record<string, unknown>
    if (record.type !== 'text' || typeof record.text !== 'string') return undefined
    text += record.text
  }
  return text
}

function collectEntries(session: any): MemoryEntry[] {
  const nodes: readonly number[] = Array.from(session?.surface?.nodes ?? [])
  const entries: MemoryEntry[] = []
  for (const seq of nodes) {
    let event: any
    let message: any
    try {
      event = session.eventAt?.(seq)
      if (!event) continue
      message = session.deriveEventMessage(event)
    } catch {
      continue
    }
    if (!message) continue
    const content = message?.content
    const contentHasToolCall = Array.isArray(content) && content.some((block: any) => block?.type === 'tool-call')
    const declaredToolCalls =
      (Array.isArray(message?.toolCalls) && message.toolCalls.length > 0) ||
      (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0)
    const hasToolCall = contentHasToolCall || declaredToolCalls
    entries.push({
      seq,
      role: typeof message.role === 'string' ? message.role : String(event.type ?? 'other'),
      text: messageText(message),
      isError: event?.type === 'tool/result' && event?.data?.error !== undefined,
      sourceKind: typeof message?.source?.kind === 'string' ? message.source.kind : undefined,
      hasToolCall,
    })
  }
  return entries
}

/**
 * 计算 surface replacement 需要声明遮蔽的节点集合。
 *
 * DSH 的会话加载器会校验：「被替换区间内每一个有消息的 surface 节点，都必须
 * 出现在 sourceEventSeqs 里」，否则整份日志被判为 corrupt
 * （SessionFormatError: replacement sourceEventSeqs omit a shadowed surface node）。
 * 折叠计划只含纯文本 assistant 消息，区间内仍可能夹着其它可投影节点，
 * 因此这里按事件真实类型重新收集，而不是沿用计划里的原始 seqs。
 */
function shadowedFoldSeqs(session: any, startSeq: number, endSeq: number, planned: readonly number[]): number[] {
  const nodes: number[] = Array.from(session?.surface?.nodes ?? [])
  const seqs = new Set<number>(planned)
  for (const seq of nodes) {
    if (seq < startSeq || seq > endSeq || seqs.has(seq)) continue
    let message: any
    try {
      message = session.eventAt && session.deriveEventMessage ? session.deriveEventMessage(session.eventAt(seq)) : undefined
    } catch {
      message = undefined
    }
    if (message) seqs.add(seq)
  }
  return [...seqs].sort((a, b) => a - b)
}

function applyFoldToSurface(session: any, patch: Patch, summary: string, seqs: readonly number[]): boolean {
  if (seqs.length === 0) return false
  const startSeq = seqs[0]!
  const endSeq = seqs[seqs.length - 1]!
  const message = {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: 'user',
    content: [{ type: 'text', text: summary }],
    source: { kind: 'user' },
  }
  session.append('user/message', message, {
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: shadowedFoldSeqs(session, startSeq, endSeq, seqs),
  })
  return true
}

function buildStatusTool(getStatus: () => Record<string, unknown>) {
  return {
    name: 'costkiller_status',
    description: 'Return dsh-context-manager token savings and runtime counters (savings panel data).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          admitted: { type: 'number' },
          extracted: { type: 'number' },
          folds: { type: 'number' },
          savedTokens: { type: 'number' },
          rejectedByAnchor: { type: 'number' },
          deduped: { type: 'number' },
          savedByAdmission: { type: 'number' },
          savedByExtraction: { type: 'number' },
          savedByDedup: { type: 'number' },
          savedByFold: { type: 'number' },
          savedBySchema: { type: 'number' },
          perRequestSavings: { type: 'number' },
          eventSavings: { type: 'number' },
          contextReduction: { type: 'number' },
          estimatedCostTokens: { type: 'number' },
          tokensBeforeTotal: { type: 'number' },
          tokensAfterTotal: { type: 'number' },
          workspaceCount: { type: 'number' },
          schemaVersion: { type: 'number' },
          ledgerId: { type: 'string' },
          revision: { type: 'number' },
          savingsFile: { type: 'string' },
        },
        required: [
          'ok',
          'admitted',
          'extracted',
          'folds',
          'savedTokens',
          'rejectedByAnchor',
          'deduped',
          'savedByAdmission',
          'savedByExtraction',
          'savedByDedup',
          'savedByFold',
          'savedBySchema',
          'perRequestSavings',
          'eventSavings',
          'contextReduction',
          'estimatedCostTokens',
          'tokensBeforeTotal',
          'tokensAfterTotal',
          'workspaceCount',
          'schemaVersion',
          'ledgerId',
          'revision',
          'savingsFile',
        ],
        additionalProperties: false,
      },
      render: (value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async () => getStatus(),
  }
}

function resolveConfig(raw: Partial<CostKillerConfig>): CostKillerConfig {
  const parsed = Config.safeParse(raw ?? {})
  if (parsed.success) return parsed.data
  logEvent('warn', 'config.invalid', { error: parsed.error.message })
  return Config.parse({})
}

export function apply(ctx: Context, rawConfig: Partial<CostKillerConfig> = {}): () => void {
  const config = resolveConfig(rawConfig)
  const services = ctx as any
  const disposers: Array<() => void> = []
  const counters: Counters = { admitted: 0, extracted: 0, folds: 0, savedTokens: 0, rejectedByAnchor: 0, deduped: 0 }
  let admissionRuns = 0
  let lastRoutingKey = ''
  const sessions = new Map<string, SessionState>()
  const router = new RoutingModule({ baseUrl: config.localBaseUrl, timeoutMs: 1500 })
  const breaker = new CompressionBreaker({ name: 'extraction', failureThreshold: 3, cooldownMs: 10 * 60_000 })
  const dedup = new DedupBus(256)
  const ledger = new SavingsLedger()
  const responseCache = new ResponseCache({ ttlMs: config.responseCacheTtlMs, similarityThreshold: config.semanticCacheThreshold })
  const toolSchemas = new Map<string, any>()
  let localAvailable = false

  const probeLocal = async (): Promise<void> => {
    try {
      const response = await fetch(`${config.localBaseUrl.replace(/\/+$/, '')}/api/tags`, {
        signal: AbortSignal.timeout(500),
      })
      localAvailable = response.ok
    } catch {
      localAvailable = false
    }
    logEvent('info', localAvailable ? 'routing.local_available' : 'routing.local_unavailable', {
      module: 'Routing',
      baseUrl: config.localBaseUrl,
    })
  }
  if (config.localRouting) void probeLocal()
  const savingsMarkdown = path.resolve(process.cwd(), 'savings.md')
  const savingsJson = path.resolve(process.cwd(), 'savings.json')
  let savingsTimer: ReturnType<typeof setTimeout> | null = null

  const persistSavings = (): void => {
    try {
      fs.writeFileSync(savingsJson, JSON.stringify(ledger.snapshot(), null, 2), 'utf8')
      fs.writeFileSync(savingsMarkdown, ledger.renderMarkdown(), 'utf8')
    } catch {
      /* 面板写盘失败不影响主链路 */
    }
  }
  const scheduleSavings = (): void => {
    if (savingsTimer !== null) return
    savingsTimer = setTimeout(() => {
      savingsTimer = null
      persistSavings()
    }, 800)
  }

  const stateFor = (sessionId: string): SessionState => {
    let state = sessions.get(sessionId)
    if (!state) {
      state = { prefixHash: '', folds: 0, lastSentSeq: 0 }
      sessions.set(sessionId, state)
    }
    return state
  }

  // 会话 -> 工作区映射：schema 压缩发生在 llm 层，只能靠 sessionId 反查。
  const sessionWorkspaces = new Map<string, WorkspaceRef>()
  const liveSession = (sessionId: string, fallback: any): any => {
    try {
      const store = (services as any).sessions
      if (!store) return fallback
      if (typeof store.get === 'function') {
        const fromStore = store.get(sessionId)
        if (fromStore) return fromStore
      }
      if (typeof store.list === 'function') {
        const listed = store.list()
        const items = Array.isArray(listed) ? listed : Array.from(listed ?? [])
        const found = items.find((item: any) => item?.header?.id === sessionId || item?.id === sessionId)
        if (found) return found
      }
    } catch {
      /* 服务不可用时回退到 hook 传入的实例 */
    }
    return fallback
  }
  const workspaceFor = (session: any, agent?: any): WorkspaceRef =>
    workspaceRefFromSession(session, agent) ?? workspaceRef('(unknown)')

  logEvent('info', 'apply.start', { plugin: name, config })

  try {
    const sectionDisposer = services.systemPrompt?.section?.({
      name: 'cost-killer:policy',
      order: 46,
      text: POLICY_TEXT,
    })
    if (typeof sectionDisposer === 'function') disposers.push(sectionDisposer)
  } catch (error) {
    logEvent('warn', 'systemPrompt.section.failed', { error: String(error) })
  }

  try {
    const toolDisposer = services.tools?.register?.(buildStatusTool(() => {
      const snapshot = ledger.snapshot()
      return {
        ok: true,
        admitted: counters.admitted,
        extracted: counters.extracted,
        folds: counters.folds,
        savedTokens: snapshot.totalSavedTokens,
        rejectedByAnchor: counters.rejectedByAnchor,
        deduped: counters.deduped,
        savedByAdmission: snapshot.byModule.admission,
        savedByExtraction: snapshot.byModule.extraction,
        savedByDedup: snapshot.byModule.dedup,
        savedByFold: snapshot.byModule.fold,
        savedBySchema: snapshot.byModule.schema,
        perRequestSavings: snapshot.perRequestSavings,
        eventSavings: snapshot.eventSavings,
        contextReduction: snapshot.contextReduction,
        estimatedCostTokens: snapshot.estimatedCostTokens,
        tokensBeforeTotal: snapshot.tokensBeforeTotal,
        tokensAfterTotal: snapshot.tokensAfterTotal,
        workspaceCount: Object.keys(snapshot.byWorkspace).length,
        schemaVersion: snapshot.schemaVersion,
        ledgerId: snapshot.ledgerId,
        revision: snapshot.revision,
        savingsFile: savingsMarkdown,
      }
    }))
    if (typeof toolDisposer === 'function') disposers.push(toolDisposer)
  } catch (error) {
    logEvent('warn', 'tools.register.failed', { error: String(error) })
  }

  // v1.3：search_tools 元工具，供模型按需拉取被懒加载隐藏的工具 schema。
  try {
    const searchDisposer = services.tools?.register?.({
      name: 'search_tools',
      description: 'Return the full JSON schema of tools hidden by lazy loading. Query by tool name or keywords.',
      parameters: {
        query: { type: 'string', description: 'tool name or keywords', required: true },
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, tools: { type: 'string' } },
          required: ['ok', 'tools'],
          additionalProperties: false,
        },
        render: (value: any) => [{ type: 'text', text: String(value?.tools ?? '') }],
      },
      execute: async (exec: any) => {
        const query = String(exec?.parameters?.query ?? exec?.query ?? '').toLowerCase()
        const matches = [...toolSchemas.values()]
          .filter((tool) => {
            if (!query) return false
            return (
              String(tool.name ?? '').toLowerCase().includes(query) ||
              String(tool.description ?? '').toLowerCase().includes(query)
            )
          })
          .slice(0, 5)
        return {
          ok: matches.length > 0,
          tools: matches.length > 0 ? JSON.stringify(matches) : `no tool matched "${query}"`,
        }
      },
    })
    if (typeof searchDisposer === 'function') disposers.push(searchDisposer)
  } catch (error) {
    logEvent('warn', 'search_tools.register.failed', { error: String(error) })
  }

  // Schema 压缩依赖 llm 服务。真实 DSH 里 llm 可能挂在 agent 作用域而非 profile 根，
  // 因此既在根 ctx 上重试，也在首条 pre-step 的 payload.agent.loopCtx.llm 上补装。
  const pendingTimers: Array<ReturnType<typeof setTimeout>> = []
  let schemaDisposer: (() => void) | null = null

  const installSchema = (llm: any, source: string): boolean => {
    if (schemaDisposer !== null) return true
    if (!llm || typeof llm.stream !== 'function') return false
    const dispose = installSchemaCompressor({ llm, get: () => undefined } as any, {
      enabled: true,
      maxDescriptionChars: 120,
      rewriteHistory: config.rewriteEnabled
        ? (messages: any) =>
            rewriteMessages(messages, {
              retainRecent: config.rewriteRetainRecent,
              assistantChars: config.rewriteAssistantChars,
              toolChars: config.rewriteToolChars,
            })
        : undefined,
      responseCache: config.responseCacheEnabled ? responseCache : undefined,
      onCacheHit: () => logEvent('info', 'cache.response_hit', responseCache.stats()),
      onSemanticHit: (score: number) => logEvent('info', 'cache.semantic_hit', { score, ...responseCache.stats() }),
      toolAttention: { enabled: config.toolAttentionEnabled, topK: config.toolAttentionTopK },
      onToolCatalog: (tools) => {
        toolSchemas.clear()
        for (const tool of tools) toolSchemas.set(tool.name, tool)
      },
      onRequest: ({
        sessionId,
        beforeTokens,
        afterTokens,
        savedTokens,
        toolsBeforeTokens,
        rewriteSaved,
        rewriteBeforeTokens,
        rewriteAfterTokens,
      }) => {
        const workspace = sessionWorkspaces.get(sessionId) ?? workspaceRef('(unknown)')
        ledger.recordRequestTokens(workspace, beforeTokens, afterTokens)
        if (savedTokens > 0) {
          ledger.record('schema', savedTokens, 'tool schema descriptions', workspace, toolsBeforeTokens)
        }
        if ((rewriteSaved ?? 0) > 0) {
          ledger.record('extraction', rewriteSaved!, 'history-rewrite', workspace, rewriteBeforeTokens)
          logEvent('info', 'context.rewritten', {
            module: 'HistoryRewriter',
            sessionId,
            beforeTokens: rewriteBeforeTokens,
            afterTokens: rewriteAfterTokens,
            saved: rewriteSaved,
          })
        }
        scheduleSavings()
      },
    })
    if (typeof dispose !== 'function') return false
    schemaDisposer = dispose
    disposers.push(dispose)
    logEvent('info', 'schema.installed', { source })
    return true
  }

  const resolveRootLlm = (): any => {
    try {
      return services.llm ?? services.get?.('llm')
    } catch {
      return undefined
    }
  }

  const tryInstallSchema = (attempt = 0): void => {
    if (schemaDisposer !== null) return
    if (installSchema(resolveRootLlm(), 'root')) return
    if (attempt >= 40) {
      logEvent('warn', 'schema.unavailable', { attempts: attempt, hint: 'llm service not found on root ctx' })
      return
    }
    const timer = setTimeout(() => tryInstallSchema(attempt + 1), 500)
    pendingTimers.push(timer)
  }
  tryInstallSchema()

  const installSchemaFromAgent = (agent: any): void => {
    if (schemaDisposer !== null || !agent) return
    let llm: any
    try {
      llm = agent?.loopCtx?.llm ?? agent?.llm ?? agent?.ctx?.llm
    } catch {
      return
    }
    if (llm) installSchema(llm, 'agent')
  }

  const onPostExecute = async (exec: any, result: any, next: any): Promise<any> => {
    const decision = await next()
    try {
      if (decision?.kind !== 'accept' || Object.prototype.hasOwnProperty.call(decision, 'value')) return decision
      const content = decision.content ?? result?.content
      const text = flattenPlainText(content)
      if (text === undefined) return decision
      let execSession: any
      try {
        execSession = exec?.agent?.session
      } catch {
        execSession = undefined
      }
      const execSessionId = String(
        (execSession && typeof execSession === 'object' && execSession.id) ||
          (typeof execSession === 'string' ? execSession : '') ||
          '',
      )
      const workspace = workspaceFor(
        execSessionId ? liveSession(execSessionId, typeof execSession === 'object' ? execSession : undefined) : undefined,
        exec?.agent,
      )

      // 去重总线：同一输出第二次出现时只留指针（最常见的是重复跑测试/构建/目录列表）。
      const dedupKeyValue = dedupeKey(text)
      const dedupHit = dedup.hit(dedupKeyValue)
      if (dedupHit !== null && estimateTokens(text) > 100) {
        counters.deduped += 1
        ledger.record('dedup', dedupHit.entry.tokens, 'duplicate tool output', workspace, dedupHit.entry.tokens)
        scheduleSavings()
        logEvent('info', 'dedup.hit', {
          module: 'DedupBus',
          tokensSaved: dedupHit.entry.tokens,
          spillPath: dedupHit.entry.spillPath,
        })
        return { ...decision, content: [{ type: 'text', text: dedupHit.pointer }] }
      }

      const tokensBefore = estimateTokens(text)
      // 先做结构感知提纯（AST / JSON / 索引 / 分节），再做准入落盘；
      // 两者可叠加：压缩产物 + 原文指针同时保留，保证可逆。
      // 压缩器自身受 Breaker 保护：连续失败/零收益时跳过，避免死循环与无效算力。
      let extracted: ReturnType<typeof runExtraction> | null = null
      if (breaker.canRun()) {
        extracted = runExtraction({ text, maxTokens: config.extractionTokens, budgetMs: config.compressionBudgetMs })
        if (!extracted.safe || (extracted.mode !== 'none' && extracted.tokensSaved <= 0)) {
          breaker.recordFailure(extracted.reason ?? 'no-net-saving')
        } else if (extracted.mode !== 'none') {
          breaker.recordSuccess()
        }
      } else {
        logEvent('warn', '[Breaker] skip compression', { module: 'Breaker', state: breaker.state, tool: exec?.tool?.name ?? 'unknown' })
      }

      // 上下文防火墙（v1.1 主杠杆）：超过 firewallTokens 的输出，若没有拿到
      // 结构化压缩（ast/json/index），一律改用「结构化摘要 + 落盘指针」。
      const weakExtraction =
        !extracted ||
        !extracted.safe ||
        extracted.mode === 'none' ||
        extracted.mode === 'head-tail' ||
        extracted.mode === 'section'
      if (weakExtraction && tokensBefore > config.firewallTokens) {
        const firewall = buildFirewallSummary(text, config.firewallTokens)
        const currentTokens = extracted && extracted.safe && extracted.mode !== 'none' ? extracted.tokensAfter : tokensBefore
        if (firewall.text.length > 0 && firewall.text.length < text.length && firewall.tokens < currentTokens) {
          extracted = {
            text: firewall.text,
            constraints: '',
            safe: true,
            mode: 'firewall',
            tokensBefore: firewall.tokensBefore,
            tokensAfter: firewall.tokens,
            tokensSaved: Math.max(0, firewall.tokensBefore - firewall.tokens),
            reason: 'firewall',
          }
          logEvent('info', 'firewall.summarized', {
            module: 'Firewall',
            tokensBefore: firewall.tokensBefore,
            tokensAfter: firewall.tokens,
            saved: extracted.tokensSaved,
          })
        }
      }

      const compressed = extracted && extracted.safe && extracted.mode !== 'none' ? extracted.text : text
      if (extracted && extracted.mode !== 'none' && extracted.safe) counters.extracted += 1

      // 有损模式（AST / 索引 / 分节 / 头尾）必须强制落盘原文并附指针，保证可逆；
      // JSON 压缩只是去空白，属于无损，不需要额外指针。
      const lossy = extracted !== null && extracted.safe && extracted.mode !== 'none' && extracted.mode !== 'json'
      const admitted = runAdmission(text, { maxInlineTokens: lossy ? 0 : config.admissionTokens, spillDir: config.spillDir })
      if (admitted.admitted) counters.admitted += 1
      dedup.remember(dedupKeyValue, text, admitted.spilledTo)

      admissionRuns += 1
      if (admissionRuns % 10 === 0) {
        const gc = collectGarbage({
          dir: path.resolve(config.spillDir),
          maxFiles: config.spillMaxFiles,
          ttlMs: config.spillTtlHours * 60 * 60_000,
        })
        logEvent('info', 'spill.gc', {
          module: 'SpillGc',
          scanned: gc.scanned,
          deleted: gc.deleted.length,
          kept: gc.kept,
          pinnedSkipped: gc.pinnedSkipped,
          freedBytes: gc.freedBytes,
        })
      }

      const finalText = admitted.admitted
        ? compressed === text
          ? admitted.text
          : `${compressed}\n\n${admitted.text}`
        : compressed

      const tokensAfter = estimateTokens(finalText)
      const saved = Math.max(0, tokensBefore - tokensAfter)
      counters.savedTokens += saved

      // 分账口径：extraction 负责「原文 → 压缩文」，admission 负责「压缩文 → 指针化结果」，
      // 两者相加等于 saved，避免把落盘节省全部记到 extraction（面板 admission 一直是 0）。
      const extractionAfterTokens = estimateTokens(compressed)
      const extractionSaved = Math.max(0, tokensBefore - extractionAfterTokens)
      const admissionSaved = Math.max(0, extractionAfterTokens - tokensAfter)
      if (extractionSaved > 0) {
        ledger.record('extraction', extractionSaved, extracted?.mode ?? 'none', workspace, tokensBefore)
        scheduleSavings()
      }
      if (admissionSaved > 0) {
        ledger.record('admission', admissionSaved, 'spill', workspace, extractionAfterTokens)
        scheduleSavings()
      }

      logEvent('info', 'pipeline.tool_output', {
        module: 'Orchestrator',
        tool: exec?.tool?.name ?? exec?.name ?? 'unknown',
        tokensBefore,
        tokensAfter,
        saved,
        extractionMode: extracted?.mode ?? 'none',
        extractionSafe: extracted?.safe ?? true,
        lossy,
        admitted: admitted.admitted,
        spilledTo: admitted.spilledTo,
      })

      if (finalText === text) return decision
      return { ...decision, content: [{ type: 'text', text: finalText }] }
    } catch (error) {
      logEvent('warn', 'postExecute.failed', { error: String(error) })
      return decision
    }
  }

  const onPreStep = async (payload: any, next: any): Promise<any> => {
    const downstream = await next()
    try {
      if (!downstream || downstream.kind === 'reject') return downstream
      installSchemaFromAgent(payload?.agent)
      let sessionRef: any
      try {
        sessionRef = payload?.agent?.session
      } catch {
        sessionRef = undefined
      }
      const sessionId = String(
        (sessionRef && typeof sessionRef === 'object' && sessionRef.id) ||
          (typeof sessionRef === 'string' ? sessionRef : '') ||
          'unknown',
      )
      const live = liveSession(sessionId, typeof sessionRef === 'object' ? sessionRef : undefined)
      if (!live || typeof live.deriveMessages !== 'function') return downstream

      const entries = collectEntries(live)
      if (entries.length === 0) return downstream

      const workspace = workspaceFor(live, payload?.agent)
      if (!sessionWorkspaces.has(sessionId)) {
        sessionWorkspaces.set(sessionId, workspace)
        const hookCwd = (() => {
          try {
            return String((sessionRef as any)?.cwd ?? '')
          } catch {
            return ''
          }
        })()
        const storeCwd = (() => {
          try {
            return String((live as any)?.header?.cwd ?? '')
          } catch {
            return ''
          }
        })()
        logEvent('info', workspace.path === '(unknown)' ? 'workspace.unresolved' : 'workspace.resolved', {
          sessionId,
          workspace: workspace.path,
          workspaceId: workspace.id,
          label: workspace.label,
          hookCwd,
          storeCwd,
        })
      }
      const state = stateFor(sessionId)
      const tokens = entries.reduce((sum, entry) => sum + estimateTokens(entry.text), 0)
      const maxSeq = entries.reduce((max, entry) => (entry.seq > max ? entry.seq : max), 0)
      const previousSent = state.lastSentSeq
      state.lastSentSeq = maxSeq

      const threshold = Math.floor(config.maxInputTokens * config.foldAtRatio)
      if (tokens <= threshold) return downstream

      // 角色感知：子代理（agent-message）上下文更窄，保留窗口收缩，避免把子任务历史永久带在主线。
      const lastUser = [...entries].reverse().find((entry) => entry.role === 'user')
      const roleAware = lastUser?.sourceKind === 'agent-message'
      const retainRecent = roleAware ? Math.max(2, config.retainRecent - 3) : config.retainRecent
      if (roleAware) {
        logEvent('info', '[RoleAware] subagent context', {
          module: 'RoleAware',
          role: 'subagent',
          retainRecent,
          totalMessages: entries.length,
        })
      }

      const plan = planMemoryFold(entries, { retainRecent, minSaveTokens: config.minSaveTokens })

      // 路由决策：以「压降后」的上下文规模为依据；<4000 且无跨文件依赖 → 强制本地。
      const routingTokens = Math.max(0, tokens - (plan.patch ? plan.tokensSaved : 0))
      const routingDecision = router.decide({
        prompt: lastUser?.text ?? '',
        contextTokens: routingTokens,
        crossFileDependency: hasCrossFileDependency(entries.slice(-6).map((entry) => entry.text).join('\n')),
      })
      // 只在路由结果发生变化时记录，避免每步刷屏（生产日志体积控制）。
      const routingKey = `${routingDecision.route}:${routingDecision.reason}`
      if (routingKey !== lastRoutingKey) {
        lastRoutingKey = routingKey
        logEvent('info', 'routing.decision', {
          module: 'Routing',
          route: routingDecision.route,
          reason: routingDecision.reason,
          contextTokens: routingDecision.contextTokens,
          tokensBefore: tokens,
        })
      }
      if (config.localRouting && routingDecision.route === 'local') {
        const routed = await router.attemptLocal(lastUser?.text ?? '')
        logEvent('info', 'routing.result', {
          module: 'Routing',
          route: routed.route,
          degraded: routed.degraded,
          latencyMs: routed.latencyMs,
        })
        if (routed.route === 'local') {
          logEvent('info', 'routing.local_hit', { module: 'Routing', latencyMs: routed.latencyMs })
        }
      }

      if (!plan.patch) return downstream

      // 缓存语义：补丁若改到「已发送的 seq 区间」即破坏前缀；
      // 冷读代价只计从改写点开始往后需要重算的 token（前缀缓存命中的部分不受影响）。
      const firstFoldedSeq = plan.foldedSeqs[0] ?? Number.MAX_SAFE_INTEGER
      const prefixBreak = previousSent > 0 && firstFoldedSeq <= previousSent
      const cachedPrefixTokens = entries
        .filter((entry) => entry.seq >= firstFoldedSeq)
        .reduce((sum, entry) => sum + estimateTokens(entry.text), 0)

      logEvent('info', 'cache.penetration', {
        sessionId,
        firstFoldedSeq,
        previousSent,
        prefixBreak,
        cachedPrefixTokens,
      })

      // 寿命摊销：按“会话总回合预估 − 当前回合”估算剩余回合，供 CacheAnchor 折算。
      const remainingTurns = Math.max(0, Math.floor(config.assumedTurns - Number(payload?.turn ?? 0)))
      const decision = gatePatch({
        prefixBreak,
        cachedPrefixTokens,
        savedByCompression: plan.tokensSaved,
        savedBySchema: 0,
        recallPenalty: 0,
        expectedRemainingTurns: remainingTurns,
        contextTokens: tokens,
        patch: plan.patch,
      })

      logEvent('info', 'cache.decision', {
        sessionId,
        tokens,
        prefixBreak,
        approved: decision.approved,
        reason: decision.reason,
        netBenefit: decision.netBenefit,
        coldReadPenalty: decision.coldReadPenalty,
        patchId: decision.patchId,
        savedTokens: plan.tokensSaved,
        remainingTurns,
      })

      if (!decision.approved) {
        counters.rejectedByAnchor += 1
        ledger.noteRejected()
        return downstream
      }

      const envelope: ContextEnvelope = createEnvelope({
        meta: { sessionId, turnId: String(payload?.turn ?? 0), targetModel: String(payload?.agent?.model ?? 'unknown'), timestamp: Date.now() },
        zones: {
          staticZone: '',
          dynamicZone: entries.slice(0, Math.max(0, entries.length - config.retainRecent)).map((entry) => entry.text),
          liveZone: entries.slice(Math.max(0, entries.length - config.retainRecent)).map((entry) => entry.text),
        },
        budget: { maxInputTokens: config.maxInputTokens, maxOutputTokens: config.maxOutputTokens, currentEstimatedCost: 0 },
      })
      const nextEnvelope = applyPatch(envelope, plan.patch)
      if (nextEnvelope.ledger.savedByCompression <= 0) return downstream

      applyFoldToSurface(live, plan.patch, plan.summary, plan.foldedSeqs)
      state.folds += 1
      counters.folds += 1
      ledger.record('fold', plan.tokensSaved, decision.patchId, workspace, plan.tokensBefore)
      ledger.noteFold(workspace)
      scheduleSavings()

      logEvent('info', 'memory.fold_applied', {
        sessionId,
        folds: state.folds,
        foldedMessages: plan.foldedMessages,
        savedTokens: plan.tokensSaved,
        ledger: nextEnvelope.ledger,
        digest: hashText(plan.summary).slice(0, 16),
      })
      return downstream
    } catch (error) {
      logEvent('warn', 'preStep.failed', { error: String(error) })
      return downstream
    }
  }

  try {
    const disposePost = services.on?.('tools/post-execute', onPostExecute)
    if (typeof disposePost === 'function') disposers.push(disposePost)
  } catch (error) {
    logEvent('warn', 'hook.postExecute.failed', { error: String(error) })
  }

  try {
    const disposePre = services.on?.('agent/pre-step', onPreStep)
    if (typeof disposePre === 'function') disposers.push(disposePre)
  } catch (error) {
    logEvent('warn', 'hook.preStep.failed', { error: String(error) })
  }

  logEvent('info', 'apply.ready', { plugin: name, mode: 'full', routing: router.circuitOpen ? 'open' : 'closed' })

  return () => {
    logEvent('info', 'apply.dispose', { plugin: name })
    if (savingsTimer !== null) clearTimeout(savingsTimer)
    savingsTimer = null
    persistSavings()
    for (const timer of pendingTimers) clearTimeout(timer)
    pendingTimers.length = 0
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {}
    }
    disposers.length = 0
  }
}
