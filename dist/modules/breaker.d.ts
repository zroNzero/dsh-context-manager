/**
 * CompressionBreaker —— 压缩模块自己的熔断器。
 *
 * 灵感来源：NousResearch/hermes-agent 的 circuit breaker with compression model judgment。
 * 目的：避免压缩器连续产出无效结果（失败 / 零收益 / Fail-Closed）时继续消耗算力，
 * 或陷入“压缩 → 失败 → 再压缩”的死循环。
 *
 * 规则：
 * - 连续 failureThreshold（默认 3）次失败/零收益 → open；
 * - open 期间跳过压缩，cooldownMs（默认 10 分钟）后进入半开，允许一次试探；
 * - 任何一次成功立即 closed。
 */
export type BreakerState = 'closed' | 'open' | 'half-open';
export interface BreakerOptions {
    failureThreshold?: number;
    cooldownMs?: number;
    name?: string;
}
export interface BreakerSnapshot {
    name: string;
    state: BreakerState;
    failures: number;
    openedAt: number;
    cooldownRemainingMs: number;
}
export declare class CompressionBreaker {
    private readonly threshold;
    private readonly cooldownMs;
    private readonly name;
    private failures;
    private openedAt;
    private halfOpenUsed;
    constructor(options?: BreakerOptions);
    get state(): BreakerState;
    /** 是否允许本次压缩。半开状态只放行一次试探。 */
    canRun(): boolean;
    recordSuccess(): void;
    recordFailure(reason: string): void;
    snapshot(): BreakerSnapshot;
}
