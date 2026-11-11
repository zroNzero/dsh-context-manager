/**
 * EFFORT POLICY —— 按任务难度分配 reasoning effort（动态「杀鸡不用牛刀」）。
 *
 * 事实依据（本案实测，会话 794b93ff，353 个 assistant 步骤）：
 *   reasoning 占输出字符 60.7%、tool-call 参数 37.6%、正文只有 1.8%。
 *   output 又是账单的 67.1%（prompt 32.0% + hit 0.9%）。
 *   也就是说 **reasoning 一项就吃掉约 40% 的账单**，而 profile 里把它固定成了 `max`
 *   （模型自身的说明：max = "Reserve for the hardest quality-first tasks"，
 *   high 才是 "the default balance for most tasks"）。
 *
 * 策略（只在「不需要深思」的地方省，绝不往上加）：
 *   1. 按**本轮用户消息**判定任务档位，整轮一致 -> 可预测、可审计、不抖动；
 *   2. 关键安全阀：只下调，绝不上调（`lower()`），宿主若已设更低就听宿主的；
 *   3. 轮内工具报错时**升级**回高思考（调试需要深度）；
 *   4. 每次决策都写日志 `effort.decided`，可回溯。
 */

export type EffortLevel = 'off' | 'low' | 'high' | 'max'

export type TurnTier = 'trivial' | 'easy' | 'normal' | 'hard'

export interface EffortPolicyConfig {
  enabled: boolean
  trivial: EffortLevel
  easy: EffortLevel
  normal: EffortLevel
  hard: EffortLevel
  /** 轮内出现工具报错时，把该步升级到 hard 档。 */
  escalateOnError: boolean
}

export interface EffortDecision {
  tier: TurnTier
  /** 最终采用的 effort。 */
  effort: EffortLevel
  /** 宿主原本要求的 effort。 */
  requested: EffortLevel
  reason: string
  escalated: boolean
}

const RANK: Record<EffortLevel, number> = { off: 0, low: 1, high: 2, max: 3 }

export function normalizeEffort(value: unknown): EffortLevel | undefined {
  const v = String(value ?? '').toLowerCase()
  if (v === 'off' || v === 'low' || v === 'high' || v === 'max') return v
  return undefined
}

/** 取两者中更省的那个；用于「只下调、不上调」。 */
export function lowerEffort(a: EffortLevel, b: EffortLevel): EffortLevel {
  return RANK[a] <= RANK[b] ? a : b
}

/** 降一档：max -> high -> low -> off。 */
export function oneNotchDown(level: EffortLevel): EffortLevel {
  if (level === 'max') return 'high'
  if (level === 'high') return 'low'
  return 'off'
}

/**
 * 最后一条消息是不是用户消息 —— 用来区分「规划步」与「执行步」。
 * 本轮首个请求以 user 结尾（需要规划）；之后的请求以 tool 结果结尾（执行既有计划）。
 */
export function lastMessageRole(messages: unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const role = (messages[i] as any)?.role
    if (typeof role === 'string') return role
  }
  return ''
}

const HARD_VERBS =
  /(重构|设计|实现|架构|排查|调试|定位|为什么|原理|方案|取舍|优化|迁移|并发|死锁|内存泄漏|性能|refactor|implement|design|architect|debug|diagnos|why|migrat|optimi[sz]e|race condition|deadlock|leak)/i
// 注意：错误码必须**区分大小写**单独判。放进上面那个 /i 正则里，`E[A-Z]{2,}`
// 会把 "exact"、"each" 这类普通单词也当成错误信号（曾因此把普通请求判成 hard）。
const ERROR_SIGNALS =
  /(traceback|stack trace|exception|unhandled|segfault|报错|错误|异常|崩溃|失败|at [\w.$]+ \(.*:\d+:\d+\)|:\d+:\d+\s*$)/im
const ERROR_CODES = /\bE[A-Z]{2,}\b/
const MECHANICAL =
  /(格式化|排版|转义|转成\s*json|转\s*json|翻译|算一下|计算结果|统计|计数|行数|改名|重命名|排序|去重|format|prettify|escape|convert to json|translate|count|rename|sort|dedupe|deduplicate)/i

export function looksLikeError(text: string): boolean {
  return ERROR_SIGNALS.test(text) || ERROR_CODES.test(text)
}

/**
 * 判定本轮任务档位。只看最后一条用户消息——整轮共用同一档位，
 * 避免「同一步骤里一会儿深思一会儿不思考」造成的质量抖动。
 */
export function classifyTurn(text: string): { tier: TurnTier; reason: string } {
  const raw = String(text ?? '')
  const t = raw.trim()
  if (t.length === 0) return { tier: 'normal', reason: 'empty-prompt' }

  const hasFence = raw.includes('```')
  const hardVerb = HARD_VERBS.test(raw)
  const errorish = looksLikeError(raw)
  const mechanical = MECHANICAL.test(raw)

  if (errorish) return { tier: 'hard', reason: 'error-signal' }
  if (hardVerb) return { tier: 'hard', reason: 'hard-verb' }
  if (hasFence && t.length > 240) return { tier: 'hard', reason: 'long-code-payload' }
  if (mechanical && t.length <= 240 && !hasFence) return { tier: 'trivial', reason: 'mechanical-task' }
  if (t.length <= 120 && !hasFence) return { tier: 'easy', reason: 'short-request' }
  return { tier: 'normal', reason: 'default' }
}

/** 最后一条工具结果是否报错（调试步骤需要深度思考）。 */
export function lastToolErrored(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message: any = messages[i]
    if (!message) continue
    if (message.role !== 'tool') continue
    if (message.isError === true) return true
    const content = message.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = content.map((block: any) => (typeof block?.text === 'string' ? block.text : '')).join('\n')
    }
    return looksLikeError(text)
  }
  return false
}

/**
 * 把 pre-step 观测到的信号拼成最小消息视图，供 decideEffort 复用同一套分类逻辑。
 *
 * 不能直接截取最近 N 条消息：一輪里工具步骤可能很多，最后 8 条里往往已经没有
 * 用户消息，`lastUserText` 会返回空 -> 档位被误判成 normal。
 */
export function syntheticMessages(input: {
  userText: string
  lastRole: string
  toolErrored: boolean
}): Array<{ role: string; content: Array<{ type: 'text'; text: string }> }> {
  const messages: Array<{ role: string; content: Array<{ type: 'text'; text: string }> }> = [
    { role: 'user', content: [{ type: 'text', text: input.userText }] },
  ]
  if (input.lastRole !== 'user') {
    messages.push({
      role: 'tool',
      content: [{ type: 'text', text: input.toolErrored ? 'Error: previous tool call failed' : 'ok' }],
    })
  }
  return messages
}

/** 最后一条用户消息的文本。 */
export function lastUserText(messages: unknown): string {  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message: any = messages[i]
    if (message?.role !== 'user') continue
    const content = message.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content.map((block: any) => (typeof block?.text === 'string' ? block.text : '')).join('\n')
    }
    return ''
  }
  return ''
}

/**
 * 决定这一步的 reasoning effort。永远不高于宿主请求的值。
 */
/**
 * 决定这一步的 reasoning effort。
 *
 * 关键：**基准必须来自用户配置，而不是上游传进来的 requested**。
 * 实测踩坑（会话 794b93ff，12:14 起）：`configure` 的返回值会被宿主写成该会话的
 * `request/header.config`，而下一轮又把它当作 requested 传回来 —— 于是「只下调」
 * 变成单向棘轮：一旦降到 low，之后所有步骤（连复杂任务的规划步）都被锁死在 low。
 * 所以这里用 baseline（用户设置）当上限，每次重新独立计算。
 */
export function decideEffort(input: {
  messages: unknown
  requested?: unknown
  /** 用户配置的档位，作为「不得超越」的上限；缺省按 max。 */
  baseline?: unknown
  policy: EffortPolicyConfig
}): EffortDecision {
  const requested = normalizeEffort(input.requested) ?? 'max'
  const base = normalizeEffort(input.baseline) ?? 'max'
  const policy = input.policy
  const turn = classifyTurn(lastUserText(input.messages))

  if (!policy.enabled) {
    return { tier: turn.tier, effort: requested, requested, reason: 'policy-disabled', escalated: false }
  }

  const planning = lastMessageRole(input.messages) === 'user'
  let desired = policy[turn.tier]
  let escalated = false
  let reason = turn.reason

  if (planning) {
    // 规划步：按任务难度给足思考预算。
    reason = `${turn.reason}:plan`
  } else {
    // 执行步：计划已经有了，照着做不需要复述推导；报错时再回到规划档位。
    const errored = policy.escalateOnError && lastToolErrored(input.messages)
    if (errored) {
      // 出错了：不管本轮是什么档位，都要有诊断深度。
      escalated = true
      desired = policy.hard
      reason = `${turn.reason}:execute+error`
    } else {
      desired = oneNotchDown(desired)
      // hard 任务的执行步也不低于 low：多步重构仍需要连贯判断。
      if (turn.tier === 'hard' && RANK[desired] < RANK['low']) desired = 'low'
      reason = `${turn.reason}:execute`
    }
  }

  // 上限是用户设置（base），不是上游这一步传来的 requested —— 后者可能是我们
  // 上一轮写进会话 header 的降档结果，用它当上限会形成不可逆的单向棘轮。
  const effort = lowerEffort(desired, base)
  return { tier: turn.tier, effort, requested, reason, escalated }
}
