/**
 * CostKillerOrchestrator 核心契约。
 *
 * 铁律：
 * 1. static_zone 绝对不可 patch；只有 dynamic_zone / live_zone 可提交补丁。
 * 2. 所有模块只能构造 Patch 提交给 ContextEnvelope，禁止原地修改 payload。
 * 3. 每次状态迁移都产生新的 ContextEnvelope（冻结对象）。
 */
/** 补丁允许落到的区；static_zone 被类型系统排除。 */
export type PatchTargetZone = 'dynamic_zone' | 'live_zone';
/** 补丁来源模块。 */
export type OriginModule = 'Admission' | 'Extraction' | 'Memory' | 'Routing';
export type PatchOp = 'replace' | 'append' | 'fold';
export interface PatchDiff {
    op: PatchOp;
    payload: string;
    anchor?: string;
}
export interface Patch {
    patchId: string;
    targetZone: PatchTargetZone;
    diff: PatchDiff;
    originModule: OriginModule;
    tokensSaved: number;
}
export interface CacheAnchorInput {
    prefixBreak: boolean;
    cachedPrefixTokens: number;
    savedByCompression: number;
    savedBySchema: number;
    recallPenalty: number;
    /** 预计剩余回合数；用于把「每回合节省」摊销成寿命收益。 */
    expectedRemainingTurns?: number;
    /** 当前上下文 token 数，用于大块折叠（chunking）判定。 */
    contextTokens?: number;
    patch: Patch;
}
export type CacheReason = 'NET_POSITIVE' | 'NON_POSITIVE' | 'PREFIX_BREAK_OUTWEIGHED' | 'PREFIX_BREAK_ACCEPTED';
export interface CacheDecision {
    approved: boolean;
    reason: CacheReason;
    coldReadPenalty: number;
    netBenefit: number;
    patchId: string;
}
export interface ZoneContent {
    /** 不可变系统提示词。 */
    staticZone: string;
    /** 可压缩的历史内容（已按序排列）。 */
    dynamicZone: readonly string[];
    /** 当前轮不可侵犯的约束与最近消息。 */
    liveZone: readonly string[];
}
export interface EnvelopeMeta {
    sessionId: string;
    turnId: string;
    targetModel: string;
    timestamp: number;
}
export interface CacheState {
    lastPrefixHash: string;
    isCacheSafe: boolean;
    ttlRemainingMs: number;
}
export interface Budget {
    maxInputTokens: number;
    maxOutputTokens: number;
    currentEstimatedCost: number;
}
export interface Ledger {
    originalTokens: number;
    compressedTokens: number;
    savedBySchema: number;
    savedByCompression: number;
    savedByCache: number;
    recallPenalty: number;
}
export interface ContextEnvelope {
    meta: EnvelopeMeta;
    zones: ZoneContent;
    cacheState: CacheState;
    budget: Budget;
    ledger: Ledger;
    patches: readonly Patch[];
}
export declare const STATIC_ZONE = "static_zone";
export declare const DYNAMIC_ZONE = "dynamic_zone";
export declare const LIVE_ZONE = "live_zone";
/** 字符 → token 的保守估算（与 DSH 侧 4 字符/token 口径一致）。 */
export declare function estimateTokens(text: string): number;
export declare function hashText(text: string): string;
/**
 * 前缀哈希：static_zone + dynamic_zone 的字节级摘要。
 * 只要这两段有任何改动，哈希必然变化 —— CacheAnchor 的 prefixBreak 判定依据。
 */
export declare function computePrefixHash(zones: ZoneContent): string;
/** 只有 dynamic_zone / live_zone 允许打补丁。 */
export declare function isPatchable(zone: string): zone is PatchTargetZone;
export declare function createEnvelope(input: {
    meta: EnvelopeMeta;
    zones: ZoneContent;
    budget: Budget;
}): ContextEnvelope;
/**
 * 纯函数式应用补丁：返回新的冻结 envelope，不改动入参。
 * static_zone 或未知 zone 直接抛错（Fail-Closed）。
 */
export declare function applyPatch(envelope: ContextEnvelope, patch: Patch): ContextEnvelope;
/** 记录一次召回惩罚（摘要导致的信息缺失代价）。 */
export declare function withRecallPenalty(envelope: ContextEnvelope, penalty: number): ContextEnvelope;
