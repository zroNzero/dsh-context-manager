/**
 * ReasoningDrop —— 丢掉「最近 N 条之外」的 assistant thinking 块。
 *
 * 为什么值得做：一次请求的前缀里约 1/3 是历史 assistant 的 reasoning/thinking
 * （实测 650K 字符预算下 195,570 字符），而每次调用都要按缓存价重读一遍，
 * 命中量占账单一半以上。
 *
 * 为什么默认**不**做：DeepSeek thinking 模式要求 thinking 原样回传，违反会直接
 * `INVALID_REQUEST: The content[].thinking in the thinking mode must be passed back`。
 * 这条契约到底管到「上一轮」还是管「整段历史」，官方没有明说，实测过才知道。
 * 所以本模块只提供纯函数；是否启用由 index.ts 里的一次性探针决定（先跑对照组，
 * 再跑删除组，只有「对照组成功 + 删除组成功」才允许开启）。
 *
 * 安全边界：
 *   - 只删 reasoning / thinking 块，**不删**同一条消息里的 text 与 tool-call；
 *   - 删空了的 assistant 消息补一个占位 text，避免出现空 content（宿主会拒）；
 *   - 纯函数：同一条消息永远产出同一个结果，前缀保持字节稳定。
 */

export interface ReasoningDropResult {
  messages: any[]
  stripped: number
  charsSaved: number
}

const REASONING_TYPES = new Set(['reasoning', 'thinking', 'reasoning-delta'])

export function stripStaleReasoning(messages: any[], retainRecent = 6): ReasoningDropResult {
  if (!Array.isArray(messages) || messages.length === 0) return { messages, stripped: 0, charsSaved: 0 }
  const retain = Math.max(0, Math.trunc(retainRecent))
  const cutoff = messages.length - retain
  if (cutoff <= 0) return { messages, stripped: 0, charsSaved: 0 }

  const out = messages.slice()
  let stripped = 0
  let charsSaved = 0
  for (let index = 0; index < cutoff; index += 1) {
    const message = out[index]
    if (!message || message.role !== 'assistant') continue
    const content = message.content
    if (!Array.isArray(content)) continue
    const kept = content.filter((block: any) => !REASONING_TYPES.has(String(block?.type ?? '')))
    if (kept.length === content.length) continue
    for (const block of content) {
      if (!REASONING_TYPES.has(String(block?.type ?? ''))) continue
      charsSaved += String(block?.text ?? block?.reasoning ?? '').length
    }
    // 整条消息只有 thinking 时不能留空 content，补一个占位（宿主对空 content 会报错）。
    const next = kept.length > 0 ? kept : [{ type: 'text', text: '[old reasoning omitted]' }]
    out[index] = { ...message, content: next }
    stripped += 1
  }
  return { messages: out, stripped, charsSaved }
}

export type ReasoningProbeVerdict = 'allowed' | 'denied' | 'inconclusive'

/**
 * 一次性探针：真实发两条极短请求，确认「老 thinking 能不能不回传」。
 *
 *   对照组：保留 thinking      —— 成功才说明「探针请求本身是合法的」；
 *   删除组：同一段历史去掉 thinking —— 只有它也成功，才允许开启折叠。
 *
 * 对照组失败（例如接口不接受非模型产出的 thinking）时返回 inconclusive，
 * 保持关闭——宁可少省钱，也不拿会话来赌。
 */
export async function probeStaleReasoning(
  stream: (request: any) => AsyncIterable<any>,
  options: { provider: string; model: string },
): Promise<{ verdict: ReasoningProbeVerdict; control: boolean; stripped: boolean; error?: string }> {
  const nonce = Math.random().toString(36).slice(2, 8)
  const history = [
    { role: 'user', content: [{ type: 'text', text: `probe ${nonce}: say ok` }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'internal reasoning placeholder' }, { type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: `probe ${nonce}: say ok again` }] },
  ]
  const run = async (messages: any[]): Promise<void> => {
    const request = {
      provider: options.provider,
      model: options.model,
      purpose: 'reasoning-probe',
      reasoningEffort: 'high',
      maxTokens: 8,
      messages,
    }
    const streamed = await stream(request)
    for await (const _chunk of streamed) {
      /* drain */
    }
  }

  let control = false
  let controlError: string | undefined
  try {
    await run(history)
    control = true
  } catch (error) {
    controlError = String(error)
  }
  if (!control) return { verdict: 'inconclusive', control: false, stripped: false, error: controlError }

  try {
    await run(stripStaleReasoning(history, 1).messages)
    return { verdict: 'allowed', control: true, stripped: true }
  } catch (error) {
    return { verdict: 'denied', control: true, stripped: false, error: String(error) }
  }
}


/**
 * 探针裁决落盘缓存。
 *
 * 探针是异步的（要真发两条短请求）。如果每个进程启动都重新探，那么启动后最初那
 * 几秒发出的请求会用「未剥离」的历史，与之后「已剥离」的历史字节不同：
 *   1. 那几条请求白付一次全量前缀（实测 1.9M 字符 vs 常态 0.8M）；
 *   2. 剥离一生效，前缀当场作废，再冷读一次（实测 miss 54,949 = ¥0.055）。
 * 于是每次重启白付两次冷读，命中率被拉低到 98%。裁决与进程无关，落盘即可只探一次。
 *
 * key 带 provider/model/契约版本：换模型或改剥离逻辑都必须重探。
 */
export interface ProbeCacheEntry {
  key: string
  verdict: ReasoningProbeVerdict
  control: boolean
  stripped: boolean
  at: string
}

export function probeCacheKey(provider: unknown, model: unknown): string {
  return ['v1', String(provider ?? ''), String(model ?? '')].join('|')
}

export function readProbeCache(file: string, key: string): ProbeCacheEntry | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as any
    if (!raw || raw.key !== key) return null
    if (raw.verdict !== 'allowed' && raw.verdict !== 'denied' && raw.verdict !== 'inconclusive') return null
    return raw as ProbeCacheEntry
  } catch {
    return null
  }
}

export function writeProbeCache(file: string, entry: ProbeCacheEntry): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = file + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(entry, null, 2), 'utf8')
    fs.renameSync(temp, file)
    return true
  } catch {
    return false
  }
}
import fs from 'node:fs'
import path from 'node:path'
