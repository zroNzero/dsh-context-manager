/**
 * SCOPE —— 分层预算（v2.0 正式版）。
 *
 * 把请求上下文预算切成 Tools / Memory / Live 三份：
 * - Tools：schema 注入上限（默认 15%，避免 MCP 工具税吃掉预算）；
 * - Memory：历史重写可用的预算（决定 retainRecent 与 toolChars）；
 * - Live：最近消息原样保留。
 *
 * 目标是让压缩随上下文规模自适应：小请求少压，大请求多压。
 */

export interface ScopeBudget {
  totalTokens: number
  toolsBudget: number
  memoryBudget: number
  liveBudget: number
  retainRecent: number
  toolChars: number
  assistantChars: number
}

export interface ScopeOptions {
  toolsRatio?: number
  memoryRatio?: number
  minRetain?: number
  maxRetain?: number
}

export function planBudget(totalTokens: number, schemaTokens: number, options: ScopeOptions = {}): ScopeBudget {
  const total = Math.max(0, Math.floor(totalTokens))
  const toolsRatio = Math.min(0.5, Math.max(0.05, options.toolsRatio ?? 0.15))
  const memoryRatio = Math.min(0.8, Math.max(0.1, options.memoryRatio ?? 0.45))
  const minRetain = Math.max(1, options.minRetain ?? 2)
  const maxRetain = Math.max(minRetain, options.maxRetain ?? 12)

  const toolsBudget = Math.min(Math.max(0, schemaTokens), Math.floor(total * toolsRatio))
  const memoryBudget = Math.floor(total * memoryRatio)
  const liveBudget = Math.max(0, total - toolsBudget - memoryBudget)

  // 预算越大，保留越多最近消息；同时收紧旧工具输出字符上限。
  const liveRatio = total > 0 ? liveBudget / total : 0
  const retainRecent = Math.max(minRetain, Math.min(maxRetain, Math.round(liveRatio * 16)))
  const toolChars = Math.max(200, Math.min(3200, Math.round((memoryBudget * 4) / 64)))
  const assistantChars = Math.max(120, Math.min(1200, Math.round(toolChars / 2)))

  return {
    totalTokens: total,
    toolsBudget,
    memoryBudget,
    liveBudget,
    retainRecent,
    toolChars,
    assistantChars,
  }
}
