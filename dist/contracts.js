"use strict";
/**
 * CostKillerOrchestrator 核心契约。
 *
 * 铁律：
 * 1. static_zone 绝对不可 patch；只有 dynamic_zone / live_zone 可提交补丁。
 * 2. 所有模块只能构造 Patch 提交给 ContextEnvelope，禁止原地修改 payload。
 * 3. 每次状态迁移都产生新的 ContextEnvelope（冻结对象）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LIVE_ZONE = exports.DYNAMIC_ZONE = exports.STATIC_ZONE = void 0;
exports.estimateTokens = estimateTokens;
exports.hashText = hashText;
exports.computePrefixHash = computePrefixHash;
exports.isPatchable = isPatchable;
exports.createEnvelope = createEnvelope;
exports.applyPatch = applyPatch;
exports.withRecallPenalty = withRecallPenalty;
const node_crypto_1 = require("node:crypto");
exports.STATIC_ZONE = 'static_zone';
exports.DYNAMIC_ZONE = 'dynamic_zone';
exports.LIVE_ZONE = 'live_zone';
/** 字符 → token 的保守估算（与 DSH 侧 4 字符/token 口径一致）。 */
function estimateTokens(text) {
    if (typeof text !== 'string' || text.length === 0)
        return 0;
    return Math.ceil(Array.from(text).length / 4);
}
function hashText(text) {
    return (0, node_crypto_1.createHash)('sha256').update(text, 'utf8').digest('hex');
}
/**
 * 前缀哈希：static_zone + dynamic_zone 的字节级摘要。
 * 只要这两段有任何改动，哈希必然变化 —— CacheAnchor 的 prefixBreak 判定依据。
 */
function computePrefixHash(zones) {
    return hashText([zones.staticZone, ...zones.dynamicZone].join('\u0000'));
}
/** 只有 dynamic_zone / live_zone 允许打补丁。 */
function isPatchable(zone) {
    return zone === exports.DYNAMIC_ZONE || zone === exports.LIVE_ZONE;
}
function createEnvelope(input) {
    const originalTokens = estimateTokens(input.zones.staticZone) +
        input.zones.dynamicZone.reduce((sum, part) => sum + estimateTokens(part), 0) +
        input.zones.liveZone.reduce((sum, part) => sum + estimateTokens(part), 0);
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
        patches: Object.freeze([]),
    });
}
/**
 * 纯函数式应用补丁：返回新的冻结 envelope，不改动入参。
 * static_zone 或未知 zone 直接抛错（Fail-Closed）。
 */
function applyPatch(envelope, patch) {
    if (!isPatchable(patch.targetZone)) {
        throw new Error(`patch "${patch.patchId}" targets immutable zone "${patch.targetZone}"`);
    }
    if (envelope.patches.some((existing) => existing.patchId === patch.patchId)) {
        return envelope;
    }
    const nextZones = patch.targetZone === exports.DYNAMIC_ZONE
        ? { ...envelope.zones, dynamicZone: Object.freeze([...envelope.zones.dynamicZone, patch.diff.payload]) }
        : { ...envelope.zones, liveZone: Object.freeze([...envelope.zones.liveZone, patch.diff.payload]) };
    const saved = Math.max(0, patch.tokensSaved);
    const ledger = {
        ...envelope.ledger,
        compressedTokens: Math.max(0, envelope.ledger.compressedTokens - saved),
        savedByCompression: envelope.ledger.savedByCompression + saved,
    };
    return Object.freeze({
        ...envelope,
        zones: Object.freeze(nextZones),
        ledger: Object.freeze(ledger),
        cacheState: Object.freeze({
            ...envelope.cacheState,
            lastPrefixHash: computePrefixHash(nextZones),
        }),
        patches: Object.freeze([...envelope.patches, patch]),
    });
}
/** 记录一次召回惩罚（摘要导致的信息缺失代价）。 */
function withRecallPenalty(envelope, penalty) {
    return Object.freeze({
        ...envelope,
        ledger: Object.freeze({
            ...envelope.ledger,
            recallPenalty: envelope.ledger.recallPenalty + Math.max(0, penalty),
        }),
    });
}
