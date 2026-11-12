"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.BillingLedger = exports.CacheReadNormalizer = exports.EFFORT_OUTPUT_FACTOR = void 0;
exports.outputFactorFor = outputFactorFor;
const pricing_js_1 = require("./pricing.js");
/**
 * 各 reasoning effort 档位的**相对输出量**（以 max 为 1.0）。
 *
 * 来源：2026-11-11 的配对校准（同 3 条 prompt × 4 档，真实调用）：
 *   max 608 token / high 344 / low 357 / off 96
 * 折算：high 0.566、low 0.587、off 0.158。
 *
 * 用途：把「这一步只用了 high」换算成「如果按用户配置的 max 跑，会多花多少输出 token」，
 * 这样 effort 杠杆才能进真实账本，而不是只存在于报告里。
 * 注意这是**短 prompt 校准值**，用于比例估算；快照里会标明来源。
 */
exports.EFFORT_OUTPUT_FACTOR = {
    max: 1,
    high: 0.566,
    low: 0.587,
    off: 0.158,
};
function outputFactorFor(effort) {
    if (!effort)
        return undefined;
    const value = exports.EFFORT_OUTPUT_FACTOR[effort];
    return typeof value === 'number' && value > 0 ? value : undefined;
}
const emptyBucket = () => ({
    requests: 0,
    missTokens: 0,
    hitTokens: 0,
    outputTokens: 0,
    actualCost: 0,
    counterfactualCost: 0,
    savedCost: 0,
    removedPromptTokens: 0,
    avoidedOutputTokens: 0,
});
const addTo = (bucket, record) => {
    bucket.requests += 1;
    bucket.missTokens += record.missTokens;
    bucket.hitTokens += record.hitTokens;
    bucket.outputTokens += record.outputTokens;
    bucket.actualCost += record.actualCost;
    bucket.counterfactualCost += record.counterfactualCost;
    bucket.savedCost += record.savedCost;
    bucket.removedPromptTokens += record.removedPromptTokens;
    bucket.avoidedOutputTokens += record.avoidedOutputTokens ?? 0;
};
const reductionOf = (actual, counterfactual) => counterfactual > 0 ? Math.max(0, 1 - actual / counterfactual) : 0;
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
class CacheReadNormalizer {
    seen = new Map();
    normalize(sessionId, raw) {
        const value = Math.max(0, Math.trunc(raw || 0));
        const prev = this.seen.get(sessionId);
        if (prev === undefined) {
            // 第一次见到这个会话：累计值里包含了我们没观测到的历史（典型是插件在会话中途
            // 重启），无法把其中任何一段归属给当前请求，因此只记起点、这一次记 0 命中。
            // 宁可少记一次（发生在几百次请求里的一次），也不能把 26 万 token 记到单次请求上。
            this.seen.set(sessionId, value);
            return 0;
        }
        const delta = value >= prev ? value - prev : value;
        this.seen.set(sessionId, value);
        return Math.max(0, delta);
    }
    reset(sessionId) {
        if (sessionId === undefined)
            this.seen.clear();
        else
            this.seen.delete(sessionId);
    }
}
exports.CacheReadNormalizer = CacheReadNormalizer;
class BillingLedger {
    records = [];
    noReduction = 0;
    unverifiedOutput = 0;
    lastPricing = null;
    byPurpose = new Map();
    byModel = new Map();
    byWindow = new Map();
    /** 记录一次真实请求。usage 缺失时返回 null，绝不估算补齐。 */
    record(input) {
        const miss = Math.max(0, Math.trunc(input.usage?.inputTokens ?? 0));
        const hit = Math.max(0, Math.trunc(input.usage?.cacheReadTokens ?? 0));
        const out = Math.max(0, Math.trunc(input.usage?.outputTokens ?? 0));
        if (!input.usage || (miss === 0 && hit === 0 && out === 0))
            return null;
        const at = input.at ?? Date.now();
        const price = (0, pricing_js_1.priceFor)(input.model, new Date(at));
        this.lastPricing = price;
        const actualCost = (0, pricing_js_1.costOf)(miss, price.miss) + (0, pricing_js_1.costOf)(hit, price.hit) + (0, pricing_js_1.costOf)(out, price.output);
        // 反事实：被移除的内容仍然存在时的 prompt。
        const removedChars = Math.max(0, input.beforeChars - input.afterChars);
        const promptTokens = miss + hit;
        const tokensPerChar = input.afterChars > 0 && promptTokens > 0 ? promptTokens / input.afterChars : 0;
        const removedPromptTokens = removedChars > 0 ? Math.round(removedChars * tokensPerChar) : 0;
        // 构成比例取本请求实测值：命中部分按 hit 价，新增部分按 miss 价。
        const hitRatio = promptTokens > 0 ? hit / promptTokens : 0;
        const savedHitTokens = Math.round(removedPromptTokens * hitRatio);
        const savedMissTokens = removedPromptTokens - savedHitTokens;
        // effort 杠杆：这一步实际只用了 effort 档位，如果按用户配置的 baseline 跑会多花多少输出。
        // 比例来自配对校准（EFFORT_OUTPUT_FACTOR），因此这一项是「实测比例 × 真实 token」。
        const actualFactor = outputFactorFor(input.effort);
        const baselineFactor = outputFactorFor(input.baselineEffort) ?? 1;
        const effortScales = actualFactor !== undefined && input.effort !== input.baselineEffort && baselineFactor > actualFactor;
        const avoidedOutputTokens = effortScales
            ? Math.max(0, Math.round((out * baselineFactor) / actualFactor) - out)
            : 0;
        const counterfactualCost = actualCost +
            (0, pricing_js_1.costOf)(savedHitTokens, price.hit) +
            (0, pricing_js_1.costOf)(savedMissTokens, price.miss) +
            (0, pricing_js_1.costOf)(avoidedOutputTokens, price.output);
        const unverified = Math.max(0, Math.trunc(input.unverifiedOutputTokens ?? 0));
        const record = {
            at,
            purpose: input.purpose ?? 'unknown',
            model: price.tier,
            peak: price.peak,
            window: price.peak ? 'peak' : 'offpeak',
            missTokens: miss,
            hitTokens: hit,
            outputTokens: out,
            actualCost,
            counterfactualCost,
            savedCost: counterfactualCost - actualCost,
            removedPromptTokens,
            savedMissTokens,
            avoidedOutputTokens,
            savedHitTokens,
            unverifiedOutputTokens: unverified,
        };
        // 口径修正（2026-11-11）：没有任何削减的请求也**必须**计入真实账单。
        // 把它们排除掉，分母就只剩「被压缩过的那部分请求」，降幅会被系统性放大——
        // 这正是「把估算写成实测」的另一种形态。包括 keepalive 这类纯支出请求。
        this.records.push(record);
        if (removedPromptTokens === 0)
            this.noReduction += 1;
        this.unverifiedOutput += unverified;
        const bump = (map, key) => {
            const bucket = map.get(key) ?? emptyBucket();
            addTo(bucket, record);
            map.set(key, bucket);
        };
        bump(this.byPurpose, record.purpose);
        bump(this.byModel, record.model);
        bump(this.byWindow, record.window);
        return record;
    }
    /** 全部记录（含零削减请求），用于调试与断言。 */
    all() {
        return this.records;
    }
    snapshot() {
        const total = emptyBucket();
        for (const record of this.records)
            addTo(total, record);
        const promptTokens = total.missTokens + total.hitTokens;
        return {
            schemaVersion: 1,
            requests: total.requests,
            /**
             * 实测口径（不是 chars/4 估算）：
             *   promptTokens / outputTokens 来自 provider usage；
             *   removedTokens / avoidedOutputTokens 是「本请求少发的量」，
             *   由被移除的字符数 × 该请求实测的 tokens-per-char 系数换算，
             *   因此锚定在真实计费上，可作为省钱 KPI 的分子。
             */
            promptTokens: total.hitTokens + total.missTokens,
            removedTokens: total.removedPromptTokens,
            avoidedOutputTokens: total.avoidedOutputTokens,
            requestsWithoutReduction: this.noReduction,
            actualCost: total.actualCost,
            counterfactualCost: total.counterfactualCost,
            savedCost: total.savedCost,
            reduction: reductionOf(total.actualCost, total.counterfactualCost),
            currency: 'CNY',
            missTokens: total.missTokens,
            hitTokens: total.hitTokens,
            outputTokens: total.outputTokens,
            cacheHitRate: promptTokens > 0 ? total.hitTokens / promptTokens : 0,
            unverifiedOutputTokens: this.unverifiedOutput,
            byPurpose: Object.fromEntries([...this.byPurpose.entries()].sort((a, b) => b[1].actualCost - a[1].actualCost)),
            byModel: Object.fromEntries(this.byModel.entries()),
            byWindow: Object.fromEntries(this.byWindow.entries()),
            lastPricing: this.lastPricing
                ? {
                    tier: this.lastPricing.tier,
                    window: this.lastPricing.peak ? 'peak' : 'offpeak',
                    hit: this.lastPricing.hit,
                    miss: this.lastPricing.miss,
                    output: this.lastPricing.output,
                }
                : null,
            updatedAt: new Date().toISOString(),
        };
    }
    renderMarkdown() {
        const s = this.snapshot();
        const pct = (v) => `${(v * 100).toFixed(1)}%`;
        const cny = (v) => `¥${v.toFixed(4)}`;
        const rows = Object.entries(s.byPurpose)
            .map(([k, v]) => `| ${k} | ${v.requests} | ${cny(v.actualCost)} | ${cny(v.counterfactualCost)} | ${pct(reductionOf(v.actualCost, v.counterfactualCost))} |`)
            .join('\n');
        return [
            '# 真实账单（provider usage × 官方单价）',
            '',
            `- 请求数：${s.requests}（无削减 ${s.requestsWithoutReduction}）`,
            `- 真实花费：${cny(s.actualCost)}；反事实：${cny(s.counterfactualCost)}`,
            `- **真实降幅：${pct(s.reduction)}**`,
            `- token：miss ${s.missTokens} / hit ${s.hitTokens} / out ${s.outputTokens}；缓存命中率 ${pct(s.cacheHitRate)}`,
            `- 未验证的输出截断 token：${s.unverifiedOutputTokens}（不计入降幅）`,
            '',
            '| 用途 | 请求 | 真实花费 | 反事实 | 降幅 |',
            '|---|---:|---:|---:|---:|',
            rows,
            '',
        ].join('\n');
    }
}
exports.BillingLedger = BillingLedger;
