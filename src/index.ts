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
import { logEvent, LOG_FILE_PATH } from './log'
import { runAdmission } from './modules/admission'
import { runExtraction, buildFirewallSummary } from './modules/extraction'
import { planMemoryFold, type MemoryEntry } from './modules/memory'
import { hasCrossFileDependency, RoutingModule } from './modules/routing'
import { collectGarbage } from './modules/spill-gc'
import { decideEffort, syntheticMessages } from './modules/effort-policy'
import { runCalibration, summarize } from './modules/calibrate'
import { installSchemaCompressor } from './modules/schema-index'
import { CompressionBreaker } from './modules/breaker'
import { DedupBus, dedupeKey } from './modules/dedup-bus'
import { SavingsLedger } from './modules/savings-ledger'
import { BillingLedger } from './modules/billing'
import { workspaceRef, workspaceRefFromSession, type WorkspaceRef } from './modules/workspace'
import { rewriteMessages } from './modules/history-rewriter'
import { foldOldToolResults } from './modules/prefix-spill'
import { probeStaleReasoning, stripStaleReasoning } from './modules/reasoning-drop'
import { ResponseCache } from './modules/response-cache'
import { ToolPipe } from './modules/tool-pipe'
import { priceFor, pricingLoadedLog } from './modules/pricing'

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
  /**
   * 历史重写（有损）默认关闭 —— 真实账单决定的，不是口味问题。
   *
   * provider 缓存是前缀匹配：命中 ¥0.02/M、未命中 ¥1/M（差 50 倍）。重写把已经被
   * 请求过的旧消息改成更短的文本，等于把那段前缀作废，它后面的整段都要按 miss 价
   * 重算一次；而它换来的只是「后续每轮少读几千个 hit token」。实测：
   *   - 有重写（预算随 token 数漂移）：轮内命中率 24.2%；
   *   - 重写带来的省量按 hit 价折算，只有作废成本的十分之一量级。
   * 而且截断旧工具输出本身就是信息损失。所以默认关；需要主动压缩的用户可以显式打开。
   */
  rewriteEnabled: z.boolean().default(false),
  rewriteRetainRecent: z.number().int().positive().default(8),
  rewriteToolChars: z.number().int().positive().default(700),
  rewriteAssistantChars: z.number().int().positive().default(400),
  /**
   * 前缀无损折叠（v1.3）：把「最近 N 条之外」的旧工具结果整段落盘，上下文里只留
   * 「收据 + 绝对路径 + 头部摘要」。**不丢信息**（模型可 read 回来），因此默认开。
   * 实测一次请求里旧工具结果占 38.7%，而 hit 占账单 50.6%——这是目前最大的杠杆。
   */
  prefixSpillEnabled: z.boolean().default(true),
  prefixSpillRetainRecent: z.number().int().nonnegative().default(6),
  prefixSpillMinChars: z.number().int().positive().default(600),
  /**
   * 旧 tool-call 参数折叠阈值。丢完老 thinking 之后参数成了最大单项（约占发出内容的
   * 45%），而模型真正需要的是「我调了什么工具」+「结果是什么」，不是当初那段长脚本文本。
   * 参数落盘后替换成合法 JSON 收据（_spilled/_chars/_head），id 与 name 原样保留。
   */
  prefixSpillHeadChars: z.number().int().positive().default(100),
  /**
   * 丢掉「最近 N 条之外」的历史 thinking（约占前缀 1/3）。
   * auto：启动后先发两条一次性探针，只有对照组和删除组都成功才开启；denied/inconclusive
   * 一律保持关闭——thinking 契约违反会直接打断会话，不能拿它赌。
   */
  dropStaleReasoning: z.enum(['auto', 'off']).default('auto'),
  dropStaleReasoningRetainRecent: z.number().int().nonnegative().default(6),
  /** 精确哈希响应缓存（v1.2）：同一请求 5 分钟内直接重放。 */
  responseCacheEnabled: z.boolean().default(true),
  responseCacheTtlMs: z.number().int().positive().default(300_000),
  /** 输出端硬截断（v2.0）。 */
  /**
   * 输出端硬截断默认关闭 —— 它会**直接砍掉回答**，与「不降智」冲突。
   *
   * 现在的实现在「第一次 JSON 闭合」或「第一次代码块闭合」时立刻 return，
   * 于是「说明 + 第一段代码 + 第二段说明」这种正常回答会被截在第一个代码块之后。
   * 而且「客户端提前停止消费是否真的让 provider 少 decode」至今没有实盘验证
   * （见 STARTUP-PROMPT 的已知卡点 2），收益不确定、代价是确定的信息丢失。
   * 需要它的人可以显式打开。
   */
  outputGuardEnabled: z.boolean().default(false),
  outputMaxTokens: z.number().int().positive().default(1500),
  /** 语义缓存 Jaccard 阈值（v1.3）。 */
  semanticCacheThreshold: z.number().min(0.5).max(1).default(0.85),
  /** 相似度语义复用（默认关）：会让「同一句话的第二轮」直接重放上一轮回答。 */
  semanticCacheEnabled: z.boolean().default(false),
  /** TTL Keepalive（武器 30）：在 provider 缓存过期前重放前缀续命，避免跨轮首请求全价。 */
  keepaliveEnabled: z.boolean().default(true),
  keepaliveTtlMs: z.number().int().positive().default(240_000),
  keepaliveRefreshes: z.number().int().min(0).max(24).default(4),
  keepaliveMinPromptTokens: z.number().int().positive().default(500),
  /**
   * 动态 reasoning effort（默认开）。按本轮任务难度分配思考预算，只在不需要深思的
   * 地方省，绝不往上加。实测 reasoning 占输出 60.7%、输出占账单 67.1%。
   */
  dynamicEffortEnabled: z.boolean().default(true),
  effortTrivial: z.enum(['off', 'low', 'high', 'max']).default('off'),
  effortEasy: z.enum(['off', 'low', 'high', 'max']).default('low'),
  effortNormal: z.enum(['off', 'low', 'high', 'max']).default('high'),
  effortHard: z.enum(['off', 'low', 'high', 'max']).default('max'),
  effortEscalateOnError: z.boolean().default(false),
  /** 工具懒加载（v1.3）：只注入 top-K 完整 schema。 */
  /**
   * 动态工具集（Tool Attention 分层）默认关闭 —— 与 keepalive 直接冲突。
   *
   * 命中价 ¥0.02/M、未命中 ¥1/M（差 50 倍）。分层每轮按「最后一条用户消息」的意图桶
   * 重选 top-k，用户一说新话，工具表就变 -> 位于 prompt 最前面的 tools 一变，
   * **整段缓存作废**，这一轮按 miss 价重算全部 prompt。
   * 而它省下的只是工具 schema 的 token，而且是按 hit 价算的，量级差 50 倍。
   * 另外「只给一部分工具 + 让模型先 search_tools」本身也有选错工具的风险。
   * 需要它的用户可显式打开；schema 描述瘦身仍然生效，且是稳定的（同样的输入永远同样的输出）。
   */
  toolAttentionEnabled: z.boolean().default(false),
  toolAttentionTopK: z.number().int().positive().default(5),
  /** 本地 LLM 端点（v1.3 快速探测）。 */
  localBaseUrl: z.string().default('http://127.0.0.1:11434'),
  /** 是否真正发起本地路由请求（决策与日志始终开启）。 */
  localRouting: z.boolean().default(true),
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
  // 输出纪律：提高信息密度，不降低能力。省的是客套与复述，不是结论。
  'Output discipline: lead with the result. No preamble, no restating the request, no closing pleasantries, no summary of what you just did if the diff or output already shows it.',
  'Prefer minimal diffs, JSON, or tables over prose; include only the lines that changed and never print a whole file unless asked. Reasoning effort is sized per task, so spend tokens on the work, not on narration.',
  /**
   * 往返纪律：这是唯一一条「不降智反而更快」的省钱规则。
   *
   * 实测：本会话 1,087 个带工具调用的 step 里 1,045 个（96.1%）只发 1 个调用。
   * 每次 step 都要把整段前缀按缓存价重读一遍（≈¥0.0034），所以请求数本身就是账单，
   * 而它跟回答质量毫无关系。把互相独立的调用放进同一条消息，是纯赚。
   */
  'Round-trip discipline: when several tool calls are independent (different files, different commands, different queries), issue them in ONE message instead of one per message. Every round trip re-reads the whole prefix, so batching is both faster and cheaper. Never batch calls that depend on each other\'s output.',
  'Folded history uses [SPILL] receipts: when only the file name is given, it is under the spill directory stated above — read it if you need the original.',
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
    // thinking / reasoning 块：DeepSeek thinking 模式要求原样回传，任何折叠都会让整轮
    // 直接 INVALID_REQUEST（实测 2026-11-11 20:32）。这里把它标出来，供折叠排除。
    const hasThinking =
      Array.isArray(content) &&
      content.some((block: any) => block?.type === 'reasoning' || block?.type === 'thinking') ||
      (message?.thinking !== undefined && message?.thinking !== null)
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
      hasThinking,
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
          /**
           * 真实账单必须在这里声明完整：
           * 宿主按 `additionalProperties: false` 校验工具返回值，少声明一个字段
           * 整个工具就报 `returned invalid output`（实盘踩到：realBilling/realBillFile/
           * debugLogFile 三个字段漏声明，costkiller_status 直接不可用）。
           */
          realBilling: {
            type: 'object',
            properties: {
              requests: { type: 'number' },
              currency: { type: 'string' },
              actualCost: { type: 'number' },
              counterfactualCost: { type: 'number' },
              savedCost: { type: 'number' },
              reduction: { type: 'number' },
              cacheHitRate: { type: 'number' },
              missTokens: { type: 'number' },
              hitTokens: { type: 'number' },
              outputTokens: { type: 'number' },
              unverifiedOutputTokens: { type: 'number' },
              lastPricing: {
                type: 'object',
                properties: {
                  tier: { type: 'string' },
                  window: { type: 'string' },
                  hit: { type: 'number' },
                  miss: { type: 'number' },
                  output: { type: 'number' },
                },
                required: ['tier', 'window', 'hit', 'miss', 'output'],
                additionalProperties: false,
              },
            },
            required: [
              'requests',
              'currency',
              'actualCost',
              'counterfactualCost',
              'savedCost',
              'reduction',
              'cacheHitRate',
              'missTokens',
              'hitTokens',
              'outputTokens',
              'unverifiedOutputTokens',
              'lastPricing',
            ],
            additionalProperties: false,
          },
          realBillFile: { type: 'string' },
          debugLogFile: { type: 'string' },
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
          'realBilling',
          'realBillFile',
          'debugLogFile',
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
  const billing = new BillingLedger()
  const responseCache = new ResponseCache({
    ttlMs: config.responseCacheTtlMs,
    // 默认关闭语义复用（不降智）：见 ResponseCache.findSimilar 的说明。
    semanticReuse: config.semanticCacheEnabled,
    similarityThreshold: config.semanticCacheThreshold,
  })
  const toolPipe = new ToolPipe(path.resolve(config.spillDir))
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
  const realBillMarkdown = path.resolve(process.cwd(), 'real-bill.md')
  let savingsTimer: ReturnType<typeof setTimeout> | null = null

  const persistSavings = (): void => {
    try {
      // realBill 是 Gate 1 的唯一可信口径：全部来自 provider usage，不含估算。
      const snapshot: Record<string, unknown> = { ...(ledger.snapshot() as unknown as Record<string, unknown>) }
      snapshot.realBill = billing.snapshot()
      fs.writeFileSync(savingsJson, JSON.stringify(snapshot, null, 2), 'utf8')
      fs.writeFileSync(savingsMarkdown, `${ledger.renderMarkdown()}\n\n${billing.renderMarkdown()}`, 'utf8')
      fs.writeFileSync(realBillMarkdown, billing.renderMarkdown(), 'utf8')
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
  /** 最近一次 pre-step 的观测信号，供 prepareCall 前判定 reasoning effort。 */
  let effortContext: { userText: string; lastRole: string; toolErrored: boolean } | null = null
  /**
   * 最近一次 effort 决策（供真实账本把 effort 杠杆折算成反事实成本）。
   * 不带时间戳过期：一次真实请求从决策到收到 usage 可能超过 10 秒（实测 1.3–5.6s，
   * 长上下文更久），用 TTL 判活会把 effort 记成 null，输出侧杠杆在账本里直接归零
   * （实测 7 条记录里 5 条 effort:null）。改为「按轮次失效」：pre-step 更新
   * effortContext 时一并清空，跨轮不会串味。
   */
  let lastEffort: { effort: string; baseline: string } | null = null
  /**
   * 是否允许丢掉老 thinking。默认 false，只有启动探针拿到 'allowed' 才置 true。
   * 见 modules/reasoning-drop.ts：违反 thinking 回传契约会直接打断会话。
   */
  let staleReasoningAllowed = false
  /** 探针每次进程只跑一次（重载插件不重复花钱）。 */
  let staleReasoningProbed = false
  /**
   * 用户配置的 reasoning effort —— 只作为「不得超越」的上限。
   * 不能拿上游传进来的 reasoningEffort 当上限：宿主会把我们上一轮写进 config 的
   * 结果写回会话 header，下一轮再当 requested 传回来，于是形成单向棘轮（实测踩到）。
   */
  const effortBaseline = (): { effort: unknown; source: string } => {
    try {
      const selection: any = (services.get?.('agentDefaultModel') as any)?.currentSelection?.()
      const effort = selection?.reasoningEffort ?? selection?.controls?.reasoningEffort ?? selection?.config?.reasoningEffort
      if (effort) return { effort, source: 'agentDefaultModel' }
    } catch {
      /* 服务不可用就退回默认上限 */
    }
    return { effort: undefined, source: 'default-max' }
  }
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

  logEvent('info', 'apply.start', { plugin: name, debugLog: LOG_FILE_PATH, cwd: process.cwd(), config })
  logEvent('info', 'pricing.loaded', pricingLoadedLog(priceFor('deepseek-flash')))

  try {
    const sectionDisposer = services.systemPrompt?.section?.({
      name: 'cost-killer:policy',
      order: 46,
      text: config.prefixSpillEnabled
        ? `${POLICY_TEXT} the directory is ${path.resolve(config.spillDir)}`
        : POLICY_TEXT,
    })
    if (typeof sectionDisposer === 'function') disposers.push(sectionDisposer)
  } catch (error) {
    logEvent('warn', 'systemPrompt.section.failed', { error: String(error) })
  }

  try {
    const toolDisposer = services.tools?.register?.(buildStatusTool(() => {
      const snapshot = ledger.snapshot()
      const real = billing.snapshot()
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
        // 真实账单：只用 provider usage × 官方单价，estimates 上面那些字段不是验收口径。
        realBilling: {
          requests: real.requests,
          currency: real.currency,
          actualCost: Number(real.actualCost.toFixed(6)),
          counterfactualCost: Number(real.counterfactualCost.toFixed(6)),
          savedCost: Number(real.savedCost.toFixed(6)),
          reduction: Number((real.reduction * 100).toFixed(2)),
          cacheHitRate: Number((real.cacheHitRate * 100).toFixed(2)),
          missTokens: real.missTokens,
          hitTokens: real.hitTokens,
          outputTokens: real.outputTokens,
          unverifiedOutputTokens: real.unverifiedOutputTokens,
          // 没有请求时账本里 lastPricing 是 null；这里给一个形状稳定的默认值，
          // 免得工具声明的 schema 和实际返回对不上（宿主按 additionalProperties:false 校验）。
          lastPricing: {
            tier: String(real.lastPricing?.tier ?? 'unknown'),
            window: String(real.lastPricing?.window ?? 'offpeak'),
            hit: Number(real.lastPricing?.hit ?? 0),
            miss: Number(real.lastPricing?.miss ?? 0),
            output: Number(real.lastPricing?.output ?? 0),
          },
        },
        realBillFile: realBillMarkdown,
        debugLogFile: LOG_FILE_PATH,
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

  // v2.0：ToolPipe 数据平面——按 [PIPE] ref 取回落盘原文。
  try {
    const pipeDisposer = services.tools?.register?.({
      name: 'read_ref',
      description: 'Read the full content of a spilled tool result by its [PIPE] ref (e.g. pipe-1a2b3c4d5e6f).',
      parameters: {
        ref: { type: 'string', description: 'PIPE reference', required: true },
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
          required: ['ok', 'text'],
          additionalProperties: false,
        },
        render: (value: any) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      execute: async (exec: any) => {
        const ref = String(exec?.parameters?.ref ?? exec?.ref ?? '')
        const result = toolPipe.resolve(ref)
        logEvent('info', 'toolpipe.read', { module: 'ToolPipe', ref, ok: result.ok, bytes: result.bytes })
        return { ok: result.ok, text: result.text.slice(0, 20000) }
      },
    })
    if (typeof pipeDisposer === 'function') disposers.push(pipeDisposer)
  } catch (error) {
    logEvent('warn', 'read_ref.register.failed', { error: String(error) })
  }

  // Schema 压缩依赖 llm 服务。真实 DSH 里 llm 可能挂在 agent 作用域而非 profile 根，
  // 因此既在根 ctx 上重试，也在首条 pre-step 的 payload.agent.loopCtx.llm 上补装。
  const pendingTimers: Array<ReturnType<typeof setTimeout>> = []
  let schemaDisposer: (() => void) | null = null

  /**
   * 一次性测量仪器：状态目录里有 calibrate.flag 时，用未打补丁的原始 stream
   * 对同一批 prompt 分别跑 max/high/low/off，量出真实的 output token 折算率。
   * 跑完删掉 flag，失败只记日志，绝不影响宿主。
   */
  const maybeCalibrate = (rawStream: (options: any) => AsyncIterable<any>): void => {
    const flag = path.resolve(process.cwd(), 'calibrate.flag')
    try {
      if (!fs.existsSync(flag)) return
      fs.rmSync(flag, { force: true })
    } catch {
      return
    }
    void (async () => {
      try {
        const selection: any = (services.get?.('agentDefaultModel') as any)?.currentSelection?.()
        const provider = String(selection?.provider ?? 'deepseek-account')
        const model = String(selection?.model ?? 'deepseek-flash')
        const samples = await runCalibration(rawStream, { provider, model, efforts: ['max', 'high', 'low', 'off'], maxTokens: 4000 })
        logEvent('info', 'calibration.result', { module: 'Calibration', provider, model, samples, summary: summarize(samples) })
      } catch (error) {
        logEvent('warn', 'calibration.failed', { module: 'Calibration', error: String(error) })
      }
    })()
  }

  const installSchema = (llm: any, source: string): boolean => {
    if (schemaDisposer !== null) return true
    if (!llm || typeof llm.stream !== 'function') return false
    // 打补丁前先抓住原始 stream，供校准使用（必须绕过本插件，才量得到真实模型行为）。
    const rawStream = llm.stream.bind(llm)
    /**
     * 一次性契约探针：只有在「保留 thinking 的对照组」和「删掉老 thinking 的实验组」
     * 都成功时，才允许后续请求丢弃老 thinking。两条都是极短请求（maxTokens 8）。
     * 失败一律按不允许处理 —— 省钱的收益远小于一次 `content[].thinking` 报错的代价。
     */
    if (config.dropStaleReasoning === 'auto' && !staleReasoningProbed && process.env.CK_DISABLE_REASONING_PROBE !== '1') {
      staleReasoningProbed = true
      void probeStaleReasoning((request: any) => rawStream(request), {
        provider: 'deepseek-account',
        model: 'deepseek-flash',
      })
        .then((result) => {
          staleReasoningAllowed = result.verdict === 'allowed'
          logEvent('info', 'reasoning.probe', {
            module: 'ReasoningDrop',
            verdict: result.verdict,
            control: result.control,
            stripped: result.stripped,
            error: result.error ? result.error.slice(0, 200) : undefined,
          })
        })
        .catch(() => undefined)
    }
    const dispose = installSchemaCompressor({ llm, get: () => undefined } as any, {
      enabled: true,
      maxDescriptionChars: 120,
      rewriteHistory: config.prefixSpillEnabled
        ? (messages: any) => {
            /**
             * 前缀无损折叠：旧工具结果整段落盘，上下文只留「收据 + 绝对路径 + 摘要」。
             * 实测一次请求的 650K 字符预算里旧工具结果占 251K（38.7%），而它们每个
             * 请求都要按缓存价重读一遍（hit 占账单 50.6%）。落盘后可读回，不丢信息。
             *
             * 必须先于 rewriteMessages：后者会按字符截断，一旦先截断就没法再落盘了。
             */
            const folded = foldOldToolResults(Array.isArray(messages) ? messages : [], {
              spillDir: config.spillDir,
              retainRecent: config.prefixSpillRetainRecent,
              minChars: config.prefixSpillMinChars,
              headChars: config.prefixSpillHeadChars,
            })
            const finish = (next: any[]) => {
              if (config.rewriteEnabled) {
                // 固定预算（只取配置值）：重写结果必须是「消息内容」的纯函数。
                return rewriteMessages(next, {
                  retainRecent: config.rewriteRetainRecent,
                  assistantChars: config.rewriteAssistantChars,
                  toolChars: config.rewriteToolChars,
                })
              }
              return {
                messages: next,
                beforeTokens: estimateTokens(JSON.stringify(messages)),
                afterTokens: estimateTokens(JSON.stringify(next)),
                saved: Math.max(0, folded.stats.charsBefore - folded.stats.charsAfter),
                rewritten: folded.stats.folded,
              }
            }
            /**
             * 老 thinking 只在探针判定 allowed 之后才丢（默认 false，见 reasoning-drop.ts）：
             * 违反 thinking 回传契约会直接打断会话，不能拿它赌。
             */
            const stripStats = staleReasoningAllowed
              ? stripStaleReasoning(folded.messages, config.dropStaleReasoningRetainRecent)
              : null
            const next = stripStats ? stripStats.messages : folded.messages
            /**
             * 折叠与剥 thinking 的真实结果必须落日志。
             * 之前只有 `removedPromptTokens` 一个汇总数，看不出剥 thinking 到底有没有生效
             * （`payloadChars` 一直停在 680K，而预测应到 172K），只能靠猜。
             * 现在把 role 直方图、块类型直方图、两边各省多少一起打出来。
             *
             * 2026-11-11 14:16Z 实测结果：fold 省 266,033 字符、strip 省 541,092 字符，
             * 两者合计把 ~1.59M 压到 ~783K。所以两个杠杆都在工作，之前的「strip 失效」
             * 是我用错误基数的算术误判。
             *
             * 现在再加 **按字符数的构成**：只剩体积才能看出还能砍哪一块。
             * `sent` 是压缩后真正发出去的，`roleChars` / `blockChars` 都是它的分解。
             */
            const roleChars: Record<string, number> = {}
            const blockChars: Record<string, number> = {}
            let sentChars = 0
            for (const message of next) {
              const role = String(message?.role ?? '?')
              const content = message?.content
              const size = typeof content === 'string' ? content.length : JSON.stringify(content ?? '').length
              roleChars[role] = (roleChars[role] ?? 0) + size
              sentChars += size
              if (Array.isArray(content)) {
                for (const block of content) {
                  const type = String(block?.type ?? '?')
                  const inner =
                    typeof block?.text === 'string'
                      ? block.text.length
                      : JSON.stringify(block?.arguments ?? block ?? '').length
                  blockChars[type] = (blockChars[type] ?? 0) + inner
                }
              } else if (typeof content === 'string') {
                blockChars['plain-string'] = (blockChars['plain-string'] ?? 0) + content.length
              }
            }
            if (folded.stats.folded > 0 || stripStats || staleReasoningAllowed) {
              logEvent('debug', 'history.fold', {
                module: 'PrefixSpill',
                messages: Array.isArray(messages) ? messages.length : 0,
                foldCharsSaved: folded.stats.charsBefore - folded.stats.charsAfter,
                folded: folded.stats.folded,
                stripAllowed: staleReasoningAllowed,
                stripCharsSaved: stripStats ? stripStats.charsSaved : 0,
                stripped: stripStats ? stripStats.stripped : 0,
                sentChars,
                roleChars,
                blockChars,
              })
            }
            return finish(next)
          }
        : undefined,
      responseCache: config.responseCacheEnabled ? responseCache : undefined,
      onCacheHit: () => logEvent('info', 'cache.response_hit', responseCache.stats()),
      onSemanticHit: (score: number) => logEvent('info', 'cache.semantic_hit', { score, ...responseCache.stats() }),
      outputGuard: { enabled: config.outputGuardEnabled, maxTokens: config.outputMaxTokens },
      /**
       * reasoning effort 必须在宿主冻结 call config **之前** 改。
       * 用的就是宿主自己的 `ConfigureCall` 钩子（prepareCall 的第三个参数），
       * 而不是事后改 request —— 后者会触发 INVALID_PREPARED_CALL。
       */
      configureControls: (controls: any, model: any) => {
        if (!config.dynamicEffortEnabled || effortContext === null) return controls
        const requested = controls?.reasoningEffort ?? model?.reasoning?.defaultEffort
        const baseline = effortBaseline()
        const decision = decideEffort({
          messages: syntheticMessages(effortContext),
          requested,
          baseline: baseline.effort,
          policy: {
            enabled: config.dynamicEffortEnabled,
            trivial: config.effortTrivial,
            easy: config.effortEasy,
            normal: config.effortNormal,
            hard: config.effortHard,
            escalateOnError: config.effortEscalateOnError,
          },
        })
        lastEffort = { effort: String(decision.effort), baseline: String(baseline.effort ?? 'max') }
        if (!decision.effort || decision.effort === decision.requested) return controls
        logEvent('info', 'effort.decided', {
          module: 'EffortPolicy',
          scope: 'configureCall',
          tier: decision.tier,
          baseline: String(baseline.effort ?? 'max'),
          baselineSource: baseline.source,
          from: decision.requested,
          to: decision.effort,
          effortSource: requested === undefined ? 'assumed-max' : 'request',
          reason: decision.reason,
          escalated: decision.escalated,
        })
        return { ...controls, reasoningEffort: decision.effort }
      },
      resolveEffort: (request: any) => {
        const requested = request?.reasoningEffort ?? request?.config?.reasoningEffort
        const baseline = effortBaseline()
        const decision = decideEffort({
          messages: request?.messages,
          requested,
          baseline: baseline.effort,
          policy: {
            enabled: config.dynamicEffortEnabled,
            trivial: config.effortTrivial,
            easy: config.effortEasy,
            normal: config.effortNormal,
            hard: config.effortHard,
            escalateOnError: config.effortEscalateOnError,
          },
        })
        lastEffort = { effort: String(decision.effort), baseline: String(baseline.effort ?? 'max') }
        if (decision.effort === decision.requested) return null
        logEvent('info', 'effort.decided', {
          module: 'EffortPolicy',
          sessionId: request?.sessionId ?? 'unknown',
          tier: decision.tier,
          baseline: String(baseline.effort ?? 'max'),
          baselineSource: baseline.source,
          from: decision.requested,
          to: decision.effort,
          effortSource: requested === undefined ? 'assumed-max' : 'request',
          reason: decision.reason,
          escalated: decision.escalated,
        })
        return { effort: decision.effort }
      },
      keepalive: {
        enabled: config.keepaliveEnabled,
        ttlMs: config.keepaliveTtlMs,
        refreshes: config.keepaliveRefreshes,
        minPromptTokens: config.keepaliveMinPromptTokens,
      },
      onOutputTruncated: (reason: string) =>
        logEvent('info', 'output.truncated', { module: 'OutputGuard', reason, maxTokens: config.outputMaxTokens }),
      toolAttention: { enabled: config.toolAttentionEnabled, topK: config.toolAttentionTopK },
      effortContext: () => (lastEffort ? { effort: lastEffort.effort, baseline: lastEffort.baseline } : null),
      onUsage: ({ purpose, model, usage, beforeChars, afterChars, effort, baselineEffort }) => {
        const record = billing.record({ purpose, model, usage, beforeChars, afterChars, effort, baselineEffort })
        if (record) logEvent('debug', 'billing.recorded', {
          module: 'Billing',
          purpose: record.purpose,
          model: record.model,
          window: record.window,
          missTokens: record.missTokens,
          hitTokens: record.hitTokens,
          outputTokens: record.outputTokens,
          removedPromptTokens: record.removedPromptTokens,
          avoidedOutputTokens: record.avoidedOutputTokens,
          effort: effort ?? null,
          baselineEffort: baselineEffort ?? null,
          /** 本次请求模型可见载荷的字符数：用来离线区分「新增内容」与「缓存浪费」。 */
          payloadChars: afterChars,
          actualCost: Number(record.actualCost.toFixed(6)),
          savedCost: Number(record.savedCost.toFixed(6)),
        })
        scheduleSavings()
      },
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
    maybeCalibrate(rawStream)
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
            protectedLines: firewall.protectedLines,
            foldedRuns: firewall.foldedRuns,
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

      let pipeLine = ''
      if (admitted.admitted && admitted.spilledTo) {
        const published = toolPipe.publishFile(admitted.spilledTo)
        pipeLine = `\n[PIPE] ref=${published.ref}`
        logEvent('info', 'toolpipe.publish', { module: 'ToolPipe', ref: published.ref, bytes: published.bytes })
      }
      const finalText =
        (admitted.admitted ? (compressed === text ? admitted.text : `${compressed}\n\n${admitted.text}`) : compressed) + pipeLine

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
      // 按信号记录，而不是截取最近 N 条消息：多步工具调用后最近的消息里往往没有
      // 用户消息，靠它判档位会退化成 normal。这里显式回溯最后一条用户消息。
      {
        const last = entries[entries.length - 1]
        let userText = ''
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          if (entries[index].role === 'user') {
            userText = entries[index].text
            break
          }
        }
        // 新一轮观测：上一轮的 effort 决策随之失效，避免跨轮串味。
        lastEffort = null
        effortContext = {
          userText,
          lastRole: String(last?.role ?? ''),
          // 只认宿主给出的错误标记。用文本猜（looksLikeError）会把「输出里恰好含 error/失败
          // 字样」的普通工具结果当成失败，于是每一步都升级回 max，effort 杠杆直接失效
          // （实盘 5/5 次决策都是 execute+error）。
          toolErrored: last?.role === 'tool' ? last?.isError === true : false,
        }
      }

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
      if (config.localRouting && localAvailable && routingDecision.route === 'local' && routingTokens < 3000) {
        // 只做观测，不接管请求：真实请求始终走云端。所以绝不能 await ——
        // 它会让每一轮都多等一次本地模型的生成时间（红线：不得阻塞主链路）。
        void (async () => {
          try {
            const routed = await router.attemptLocal(lastUser?.text ?? '')
            logEvent('info', 'routing.result', {
              module: 'Routing',
              route: routed.route,
              degraded: routed.degraded,
              latencyMs: routed.latencyMs,
            })
            if (routed.route === 'local') {
              logEvent('info', 'routing.local_hit', { module: 'Routing', latencyMs: routed.latencyMs })
            } else {
              logEvent('info', 'routing.local_degraded', { module: 'Routing', reason: routed.reason })
            }
          } catch (error) {
            logEvent('warn', 'routing.probe_failed', { module: 'Routing', error: String(error) })
          }
        })()
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
      const price = priceFor(String(payload?.agent?.model ?? 'deepseek-flash'))
      const missRatio = price.hit > 0 ? price.miss / price.hit : 30
      const decision = gatePatch({
        prefixBreak,
        cachedPrefixTokens,
        savedByCompression: plan.tokensSaved,
        savedBySchema: 0,
        recallPenalty: 0,
        expectedRemainingTurns: remainingTurns,
        contextTokens: tokens,
        hitPrice: 1,
        missPrice: missRatio,
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
        pricing: { tier: price.tier, peak: price.peak, hit: price.hit, miss: price.miss, output: price.output },
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
