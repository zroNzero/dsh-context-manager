/**
 * BILLING —— 真实账单账本（Gate 1 的地基）。
 *
 * 与 SavingsLedger 的区别（也是本次生产化的核心）：
 * - SavingsLedger 记的是「估算省了多少 token」，`tokensBeforeTotalEstimated: true`；
 * - BillingLedger 只记 provider 回传的 usage（`StreamChunk.usage`），按官方人民币单价
 *   换算，并给出反事实成本（counterfactual）。
 *
 * 反事实怎么算才不是糊弄：
 * 1. 本次请求的真实 prompt token = inputTokens(miss) + cacheReadTokens(hit)，由 provider 给出；
 * 2. 同一次请求里，压缩前后的载荷字符数都精确可得（beforeChars / afterChars）；
 * 3. 因此该请求的「字符 -> token」换算是**实测的**：tokensPerChar = realPromptTokens / afterChars；
 * 4. 被移除的字符数差分经同一系数换算，得到 removedPromptTokens —— 这是本请求实测的、
 *    而不是全局拍脑袋的估算；
 * 5. 反事实成本 = (prompt + removed) 按本次请求实测的 hit/miss 构成分别计价。
 *    removed 落在缓存前缀里的部分按 hit 价，落在新增部分里的按 miss 价，构成比例取实测值。
 *
 * 输出 token 一律不虚报收益：客户端截断是否真让 provider 少 decode 仍需实盘验证
 * （见 README「已知卡点 2」），所以只以 `unverifiedOutputTokens` 单独列示，不计入降幅。
 */
export interface ProviderUsage {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}
export interface BillingRequestInput {
    at?: number;
    purpose?: string;
    model: string;
    /** provider 原样回传的 usage；缺失时本条记录不计入成本（绝不估算补齐）。 */
    usage: ProviderUsage | undefined;
    /** 同一个请求压缩前的模型可见载荷字符数（含 system / messages / tools）。 */
    beforeChars: number;
    /** 同一个请求压缩后的字符数。 */
    afterChars: number;
    /** 被输出截断丢弃的 token（未经验证，单独列示）。 */
    unverifiedOutputTokens?: number;
}
export interface BillingRecord {
    at: number;
    purpose: string;
    model: string;
    peak: boolean;
    window: 'peak' | 'offpeak';
    /** 未命中缓存、按 miss 价计费的新增 prompt token。 */
    missTokens: number;
    /** 命中缓存、按 hit 价计费的 prompt token。 */
    hitTokens: number;
    outputTokens: number;
    /** provider 真实计费（人民币）。 */
    actualCost: number;
    /** 反事实计费（同一请求不压缩时的成本）。 */
    counterfactualCost: number;
    savedCost: number;
    /** 本请求实测移除的 prompt token（经字符比校准）。 */
    removedPromptTokens: number;
    savedMissTokens: number;
    savedHitTokens: number;
    unverifiedOutputTokens: number;
}
export interface BillingBucket {
    requests: number;
    missTokens: number;
    hitTokens: number;
    outputTokens: number;
    actualCost: number;
    counterfactualCost: number;
    savedCost: number;
}
export interface BillingSnapshot {
    schemaVersion: 1;
    /** 只有拿到 provider usage 的请求才计入。 */
    requests: number;
    /** 拿到 usage 但字符数不变（压缩未生效）的请求数。 */
    requestsWithoutReduction: number;
    actualCost: number;
    counterfactualCost: number;
    savedCost: number;
    /** 真实账单降幅 = 1 - actual / counterfactual。分母为 0 时为 0。 */
    reduction: number;
    currency: 'CNY';
    missTokens: number;
    hitTokens: number;
    outputTokens: number;
    cacheHitRate: number;
    unverifiedOutputTokens: number;
    byPurpose: Record<string, BillingBucket>;
    byModel: Record<string, BillingBucket>;
    byWindow: Record<string, BillingBucket>;
    /** 最近一次请求的计价快照，便于面板显示当前单价。 */
    lastPricing: {
        tier: string;
        window: 'peak' | 'offpeak';
        hit: number;
        miss: number;
        output: number;
    } | null;
    updatedAt: string;
}
/**
 * provider 的 `cacheReadTokens` 是**会话累计值**，不是单请求值。
 *
 * 实测证据（2026-11-11，会话 794b93ff 重启后的连续请求）：usage chunk 里的原始值是
 * 262016 → 262400 → 262912 → 263296 → 264960，而宿主会话日志里同一批请求的
 * `assistant/message.usage.cacheReadTokens` 恰好也是这几个值（累计列）。
 * 也就是说上游给的就是累计数，直接当单请求命中会让每次请求虚增约 26 万 hit token。
 *
 * 用法：同一个 sessionId 顺序调用 normalize()，拿返回值当单请求命中。
 * 若数值回退（换了 provider 会话/上下文重置），按新序列重新起算。
 */
export declare class CacheReadNormalizer {
    private readonly seen;
    normalize(sessionId: string, raw: number): number;
    reset(sessionId?: string): void;
}
export declare class BillingLedger {
    private readonly records;
    private noReduction;
    private unverifiedOutput;
    private lastPricing;
    private readonly byPurpose;
    private readonly byModel;
    private readonly byWindow;
    /** 记录一次真实请求。usage 缺失时返回 null，绝不估算补齐。 */
    record(input: BillingRequestInput): BillingRecord | null;
    /** 全部记录（含零削减请求），用于调试与断言。 */
    all(): readonly BillingRecord[];
    snapshot(): BillingSnapshot;
    renderMarkdown(): string;
}
