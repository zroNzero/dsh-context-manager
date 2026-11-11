/**
 * CostKillerOrchestrator 核心契约。
 *
 * 铁律：
 * 1. static_zone 绝对不可 patch；只有 dynamic_zone / live_zone 可提交补丁。
 * 2. 所有模块只能构造 Patch 提交给 ContextEnvelope，禁止原地修改 payload。
 * 3. 每次状态迁移都产生新的 ContextEnvelope（冻结对象）。
 */

import { createHash } from 'node:crypto'

/** 补丁允许落到的区；static_zone 被类型系统排除。 */
export type PatchTargetZone = 'dynamic_zone' | 'live_zone'

/** 补丁来源模块。 */
export type OriginModule = 'Admission' | 'Extraction' | 'Memory' | 'Routing'

export type PatchOp = 'replace' | 'append' | 'fold'

export interface PatchDiff {
  op: PatchOp
  payload: string
  anchor?: string
}

export interface Patch {
  patchId: string
  targetZone: PatchTargetZone
  diff: PatchDiff
  originModule: OriginModule
  tokensSaved: number
}

export interface CacheAnchorInput {
  prefixBreak: boolean
  cachedPrefixTokens: number
  savedByCompression: number
  savedBySchema: number
  recallPenalty: number
  /** 预计剩余回合数；用于把「每回合节省」摊销成寿命收益。 */
  expectedRemainingTurns?: number
  /** 当前上下文 token 数，用于大块折叠（chunking）判定。 */
  contextTokens?: number
  /** 真实缓存单价（由 PRICING_TABLE 注入；缺省用 1/30 的保守值）。 */
  hitPrice?: number
  missPrice?: number
  patch: Patch
}

export type CacheReason = 'NET_POSITIVE' | 'NON_POSITIVE' | 'PREFIX_BREAK_OUTWEIGHED' | 'PREFIX_BREAK_ACCEPTED'

export interface CacheDecision {
  approved: boolean
  reason: CacheReason
  coldReadPenalty: number
  netBenefit: number
  patchId: string
}

export interface ZoneContent {
  /** 不可变系统提示词。 */
  staticZone: string
  /** 可压缩的历史内容（已按序排列）。 */
  dynamicZone: readonly string[]
  /** 当前轮不可侵犯的约束与最近消息。 */
  liveZone: readonly string[]
}

export interface EnvelopeMeta {
  sessionId: string
  turnId: string
  targetModel: string
  timestamp: number
}

export interface CacheState {
  lastPrefixHash: string
  isCacheSafe: boolean
  ttlRemainingMs: number
}

export interface Budget {
  maxInputTokens: number
  maxOutputTokens: number
  currentEstimatedCost: number
}

export interface Ledger {
  originalTokens: number
  compressedTokens: number
  savedBySchema: number
  savedByCompression: number
  savedByCache: number
  recallPenalty: number
}

export interface ContextEnvelope {
  meta: EnvelopeMeta
  zones: ZoneContent
  cacheState: CacheState
  budget: Budget
  ledger: Ledger
  patches: readonly Patch[]
}

export const STATIC_ZONE = 'static_zone'
export const DYNAMIC_ZONE = 'dynamic_zone'
export const LIVE_ZONE = 'live_zone'

/** 字符 → token 的保守估算（与 DSH 侧 4 字符/token 口径一致）。 */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.ceil(Array.from(text).length / 4)
}

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 前缀哈希：static_zone + dynamic_zone 的字节级摘要。
 * 只要这两段有任何改动，哈希必然变化 —— CacheAnchor 的 prefixBreak 判定依据。
 */
export function computePrefixHash(zones: ZoneContent): string {
  return hashText([zones.staticZone, ...zones.dynamicZone].join('\u0000'))
}

/** 只有 dynamic_zone / live_zone 允许打补丁。 */
export function isPatchable(zone: string): zone is PatchTargetZone {
  return zone === DYNAMIC_ZONE || zone === LIVE_ZONE
}

export function createEnvelope(input: {
  meta: EnvelopeMeta
  zones: ZoneContent
  budget: Budget
}): ContextEnvelope {
  const originalTokens = estimateTokens(input.zones.staticZone) +
    input.zones.dynamicZone.reduce((sum, part) => sum + estimateTokens(part), 0) +
    input.zones.liveZone.reduce((sum, part) => sum + estimateTokens(part), 0)

  return Object.freeze({
    meta: Object.freeze({ ...input.meta }),
    zones: Object.freeze({
      staticZone: input.zones.staticZone,
      dynamicZone: Object.freeze([...input.zones.dynamicZone]),
      liveZone: Object.freeze([...input.zones.liveZone]),
    }),
    cacheState: Object.freeze({
      lastPrefixHash: computePrefixHash(input.zones),
      isCacheSafe: true,
      ttlRemainingMs: 0,
    }),
    budget: Object.freeze({ ...input.budget }),
    ledger: Object.freeze({
      originalTokens,
      compressedTokens: originalTokens,
      savedBySchema: 0,
      savedByCompression: 0,
      savedByCache: 0,
      recallPenalty: 0,
    }),
    patches: Object.freeze([] as Patch[]),
  })
}

/**
 * 纯函数式应用补丁：返回新的冻结 envelope，不改动入参。
 * static_zone 或未知 zone 直接抛错（Fail-Closed）。
 */
export function applyPatch(envelope: ContextEnvelope, patch: Patch): ContextEnvelope {
  if (!isPatchable(patch.targetZone)) {
    throw new Error(`patch "${patch.patchId}" targets immutable zone "${patch.targetZone}"`)
  }
  if (envelope.patches.some((existing) => existing.patchId === patch.patchId)) {
    return envelope
  }

  const nextZones: ZoneContent =
    patch.targetZone === DYNAMIC_ZONE
      ? { ...envelope.zones, dynamicZone: Object.freeze([...envelope.zones.dynamicZone, patch.diff.payload]) }
      : { ...envelope.zones, liveZone: Object.freeze([...envelope.zones.liveZone, patch.diff.payload]) }

  const saved = Math.max(0, patch.tokensSaved)
  const ledger: Ledger = {
    ...envelope.ledger,
    compressedTokens: Math.max(0, envelope.ledger.compressedTokens - saved),
    savedByCompression: envelope.ledger.savedByCompression + saved,
  }

  return Object.freeze({
    ...envelope,
    zones: Object.freeze(nextZones),
    ledger: Object.freeze(ledger),
    cacheState: Object.freeze({
      ...envelope.cacheState,
      lastPrefixHash: computePrefixHash(nextZones),
    }),
    patches: Object.freeze([...envelope.patches, patch]),
  })
}

/** 记录一次召回惩罚（摘要导致的信息缺失代价）。 */
export function withRecallPenalty(envelope: ContextEnvelope, penalty: number): ContextEnvelope {
  return Object.freeze({
    ...envelope,
    ledger: Object.freeze({
      ...envelope.ledger,
      recallPenalty: envelope.ledger.recallPenalty + Math.max(0, penalty),
    }),
  })
}
