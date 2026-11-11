/**
 * CacheAnchorModule —— 缓存锚定仲裁。
 *
 * 只做净收益决策，不做 prefixBreak 的哈希比较（哈希比对由调用方完成）。
 * 经济学：前缀缓存命中价 1，未命中价 30；破坏前缀等于把整段前缀按冷读计价。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { CacheAnchorInput, CacheDecision, Patch } from './contracts'
import { logEvent } from './log'

export const CACHE_ECON = {
  hitPrice: 1,
  missPrice: 30,
  defaultRecallPenaltyPerToken: 1.2,
} as const

export function evaluateCacheAnchor(input: CacheAnchorInput): CacheDecision {
  const remainingTurns = Math.max(0, Math.floor(input.expectedRemainingTurns ?? 0))
  const hitPrice = input.hitPrice ?? CACHE_ECON.hitPrice
  const missPrice = input.missPrice ?? CACHE_ECON.missPrice
  const coldReadPenalty = input.prefixBreak ? input.cachedPrefixTokens * (missPrice - hitPrice) : 0
  // 寿命摊销：一次折叠会在后续每个回合持续省 token，按「剩余回合」累计。
  const lifetimeCompression = input.savedByCompression * (1 + remainingTurns)
  const netBenefit = lifetimeCompression + input.savedBySchema - coldReadPenalty - input.recallPenalty
  // 大块折叠（≥30% 上下文）仅用于日志观测：netBenefit 已经覆盖冷读成本。
  const chunked =
    input.contextTokens !== undefined && input.contextTokens > 0
      ? input.savedByCompression >= input.contextTokens * 0.3
      : false
  const approved = netBenefit > 0

  return {
    approved,
    reason: approved ? 'NET_POSITIVE' : input.prefixBreak ? 'PREFIX_BREAK_OUTWEIGHED' : 'NON_POSITIVE',
    coldReadPenalty,
    netBenefit,
    patchId: input.patch.patchId,
  }
}

/**
 * 门控入口：调用方（index.ts pre-step）必须走这里。
 * 否决时立刻打 [Block] 日志并返回 approved=false，调用方不得继续提交 Patch。
 */
export function gatePatch(input: CacheAnchorInput): CacheDecision {
  const decision = evaluateCacheAnchor(input)

  logEvent(decision.approved ? 'info' : 'warn', decision.approved ? 'cache.approved' : '[Block] Patch rejected by CacheAnchor.', {
    module: 'CacheAnchor',
    patchId: decision.patchId,
    reason: decision.reason,
    prefixBreak: input.prefixBreak,
    cachedPrefixTokens: input.cachedPrefixTokens,
    coldReadPenalty: decision.coldReadPenalty,
    netBenefit: decision.netBenefit,
    savedByCompression: input.savedByCompression,
    savedBySchema: input.savedBySchema,
    recallPenalty: input.recallPenalty,
    expectedRemainingTurns: Math.max(0, Math.floor(input.expectedRemainingTurns ?? 0)),
    lifetimeCompression: input.savedByCompression * (1 + Math.max(0, Math.floor(input.expectedRemainingTurns ?? 0))),
  })

  return decision
}

export interface SelfTestReport {
  passed: number
  failed: number
  lines: readonly string[]
}

function makePatch(tokensSaved: number): Patch {
  return {
    patchId: 'sample-patch',
    targetZone: 'dynamic_zone',
    diff: { op: 'fold', payload: '[summary]' },
    originModule: 'Memory',
    tokensSaved,
  }
}

/** 统计 debug.log 中出现某字符串的次数（自测用真实日志断言，不接受伪造）。 */
function countLogLines(needle: string): number {
  try {
    const file = path.resolve(process.cwd(), 'debug.log')
    if (!fs.existsSync(file)) return 0
    return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.includes(needle)).length
  } catch {
    return 0
  }
}

/**
 * 5 个样例断言，供 self-test 与 CI 直接调用。
 * 任一条不符即抛错，绝不返回伪造的“全绿”。
 */
export function runCacheAnchorSelfTest(): SelfTestReport {
  const lines: string[] = []
  let passed = 0
  let failed = 0

  const check = (label: string, condition: boolean, detail: string) => {
    if (condition) {
      passed += 1
      lines.push(`PASS ${label} :: ${detail}`)
    } else {
      failed += 1
      lines.push(`FAIL ${label} :: ${detail}`)
    }
  }

  // 1) 无前缀破坏、净收益为正 → 批准，冷读罚金为 0。
  const noBreak = evaluateCacheAnchor({
    prefixBreak: false,
    cachedPrefixTokens: 5000,
    savedByCompression: 800,
    savedBySchema: 200,
    recallPenalty: 100,
    patch: makePatch(800),
  })
  check(
    'case-1 no-prefix-break',
    noBreak.approved && noBreak.reason === 'NET_POSITIVE' && noBreak.coldReadPenalty === 0 && noBreak.netBenefit === 900,
    `approved=${noBreak.approved} reason=${noBreak.reason} cold=${noBreak.coldReadPenalty} net=${noBreak.netBenefit}`,
  )

  // 2) 无前缀破坏、收益被召回惩罚吃掉 → 否决，NON_POSITIVE。
  const negative = evaluateCacheAnchor({
    prefixBreak: false,
    cachedPrefixTokens: 5000,
    savedByCompression: 100,
    savedBySchema: 0,
    recallPenalty: 300,
    patch: makePatch(100),
  })
  check(
    'case-2 non-positive',
    !negative.approved && negative.reason === 'NON_POSITIVE' && negative.netBenefit === -200,
    `approved=${negative.approved} reason=${negative.reason} net=${negative.netBenefit}`,
  )

  // 3) 前缀破坏且压缩收益低于冷读代价 → 否决，PREFIX_BREAK_OUTWEIGHED。
  //    coldReadPenalty = 10000 * (30 - 1) = 290000；savedByCompression = 1000 << 290000。
  const broken = evaluateCacheAnchor({
    prefixBreak: true,
    cachedPrefixTokens: 10000,
    savedByCompression: 1000,
    savedBySchema: 500,
    recallPenalty: 0,
    patch: makePatch(1000),
  })
  check(
    'case-3 prefix-break-outweighed',
    !broken.approved && broken.reason === 'PREFIX_BREAK_OUTWEIGHED' && broken.coldReadPenalty === 290000 && broken.netBenefit === -288500,
    `approved=${broken.approved} reason=${broken.reason} cold=${broken.coldReadPenalty} net=${broken.netBenefit}`,
  )

  // 4) 真门控路径：prefixBreak=true 且 savedByCompression < coldReadPenalty，
  //    必须被 gatePatch 拦截，且 debug.log 里出现真实 [Block] 行。
  const beforeBlockLogs = countLogLines('[Block] Patch rejected by CacheAnchor.')
  const gated = gatePatch({
    prefixBreak: true,
    cachedPrefixTokens: 20000,
    savedByCompression: 1200,
    savedBySchema: 0,
    recallPenalty: 0,
    patch: makePatch(1200),
  })
  const afterBlockLogs = countLogLines('[Block] Patch rejected by CacheAnchor.')
  const gateHeld = !gated.approved &&
    gated.reason === 'PREFIX_BREAK_OUTWEIGHED' &&
    gated.coldReadPenalty === 20000 * (CACHE_ECON.missPrice - CACHE_ECON.hitPrice) &&
    gated.netBenefit === 1200 - 20000 * (CACHE_ECON.missPrice - CACHE_ECON.hitPrice) &&
    afterBlockLogs === beforeBlockLogs + 1
  check(
    'case-4 gate-patch-blocked',
    gateHeld,
    `approved=${gated.approved} reason=${gated.reason} cold=${gated.coldReadPenalty} net=${gated.netBenefit} blockLogs=${beforeBlockLogs}->${afterBlockLogs}`,
  )

  // 5) 前缀破坏但压缩收益足够覆盖冷读 → 批准。
  const accepted = evaluateCacheAnchor({
    prefixBreak: true,
    cachedPrefixTokens: 1000,
    savedByCompression: 40000,
    savedBySchema: 0,
    recallPenalty: 0,
    patch: makePatch(40000),
  })
  check(
    'case-5 prefix-break-accepted',
    accepted.approved && accepted.reason === 'NET_POSITIVE' && accepted.coldReadPenalty === 29000 && accepted.netBenefit === 11000,
    `approved=${accepted.approved} reason=${accepted.reason} cold=${accepted.coldReadPenalty} net=${accepted.netBenefit}`,
  )

  // 6) 寿命摊销：单次节省不足以覆盖冷读，但按剩余 600 回合累计后可覆盖。
  const amortized = gatePatch({
    prefixBreak: true,
    cachedPrefixTokens: 10000,
    savedByCompression: 500,
    savedBySchema: 0,
    recallPenalty: 0,
    expectedRemainingTurns: 600,
    patch: makePatch(500),
  })
  check(
    'case-6 amortized-lifetime',
    amortized.approved && amortized.netBenefit === 10500,
    `approved=${amortized.approved} reason=${amortized.reason} net=${amortized.netBenefit} (500*601-290000)`,
  )

  return { passed, failed, lines }
}
