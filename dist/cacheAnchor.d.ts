/**
 * CacheAnchorModule —— 缓存锚定仲裁。
 *
 * 只做净收益决策，不做 prefixBreak 的哈希比较（哈希比对由调用方完成）。
 * 经济学：前缀缓存命中价 1，未命中价 30；破坏前缀等于把整段前缀按冷读计价。
 */
import type { CacheAnchorInput, CacheDecision } from './contracts';
export declare const CACHE_ECON: {
    readonly hitPrice: 1;
    readonly missPrice: 30;
    readonly defaultRecallPenaltyPerToken: 1.2;
};
export declare function evaluateCacheAnchor(input: CacheAnchorInput): CacheDecision;
/**
 * 门控入口：调用方（index.ts pre-step）必须走这里。
 * 否决时立刻打 [Block] 日志并返回 approved=false，调用方不得继续提交 Patch。
 */
export declare function gatePatch(input: CacheAnchorInput): CacheDecision;
export interface SelfTestReport {
    passed: number;
    failed: number;
    lines: readonly string[];
}
/**
 * 5 个样例断言，供 self-test 与 CI 直接调用。
 * 任一条不符即抛错，绝不返回伪造的“全绿”。
 */
export declare function runCacheAnchorSelfTest(): SelfTestReport;
