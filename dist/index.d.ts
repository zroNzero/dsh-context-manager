/**
 * CostKillerOrchestrator 入口。
 *
 * 钩子编排：
 * - tools/post-execute: Admission（超大输出落盘）→ Extraction（约束 + 骨架/JSON/分节）
 * - agent/pre-step: Memory 折叠 → CacheAnchor 净收益门控 → 通过才提交 surface 补丁
 *
 * 铁律：
 * - 所有状态经 logEvent 写 ./debug.log，全工程无 console.log。
 * - 模块只产出 Patch；payload 永不被原地修改。
 * - 任何异常都 Fail-Open 到原行为，绝不阻断对话。
 */
import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-context-manager";
export declare const inject: string[];
export declare const Config: z.ZodPrefault<z.ZodObject<{
    maxInputTokens: z.ZodDefault<z.ZodNumber>;
    maxOutputTokens: z.ZodDefault<z.ZodNumber>;
    foldAtRatio: z.ZodDefault<z.ZodNumber>;
    retainRecent: z.ZodDefault<z.ZodNumber>;
    minSaveTokens: z.ZodDefault<z.ZodNumber>;
    spillDir: z.ZodDefault<z.ZodString>;
    admissionTokens: z.ZodDefault<z.ZodNumber>;
    extractionTokens: z.ZodDefault<z.ZodNumber>;
    firewallTokens: z.ZodDefault<z.ZodNumber>;
    assumedTurns: z.ZodDefault<z.ZodNumber>;
    rewriteEnabled: z.ZodDefault<z.ZodBoolean>;
    rewriteRetainRecent: z.ZodDefault<z.ZodNumber>;
    rewriteToolChars: z.ZodDefault<z.ZodNumber>;
    rewriteAssistantChars: z.ZodDefault<z.ZodNumber>;
    prefixSpillEnabled: z.ZodDefault<z.ZodBoolean>;
    prefixSpillRetainRecent: z.ZodDefault<z.ZodNumber>;
    prefixSpillMinChars: z.ZodDefault<z.ZodNumber>;
    prefixSpillHeadChars: z.ZodDefault<z.ZodNumber>;
    dropStaleReasoning: z.ZodDefault<z.ZodEnum<{
        off: "off";
        auto: "auto";
    }>>;
    dropStaleReasoningRetainRecent: z.ZodDefault<z.ZodNumber>;
    responseCacheEnabled: z.ZodDefault<z.ZodBoolean>;
    responseCacheTtlMs: z.ZodDefault<z.ZodNumber>;
    outputGuardEnabled: z.ZodDefault<z.ZodBoolean>;
    outputMaxTokens: z.ZodDefault<z.ZodNumber>;
    semanticCacheThreshold: z.ZodDefault<z.ZodNumber>;
    semanticCacheEnabled: z.ZodDefault<z.ZodBoolean>;
    keepaliveEnabled: z.ZodDefault<z.ZodBoolean>;
    keepaliveTtlMs: z.ZodDefault<z.ZodNumber>;
    keepaliveRefreshes: z.ZodDefault<z.ZodNumber>;
    keepaliveMinPromptTokens: z.ZodDefault<z.ZodNumber>;
    dynamicEffortEnabled: z.ZodDefault<z.ZodBoolean>;
    effortTrivial: z.ZodDefault<z.ZodEnum<{
        off: "off";
        low: "low";
        high: "high";
        max: "max";
    }>>;
    effortEasy: z.ZodDefault<z.ZodEnum<{
        off: "off";
        low: "low";
        high: "high";
        max: "max";
    }>>;
    effortNormal: z.ZodDefault<z.ZodEnum<{
        off: "off";
        low: "low";
        high: "high";
        max: "max";
    }>>;
    effortHard: z.ZodDefault<z.ZodEnum<{
        off: "off";
        low: "low";
        high: "high";
        max: "max";
    }>>;
    effortEscalateOnError: z.ZodDefault<z.ZodBoolean>;
    toolAttentionEnabled: z.ZodDefault<z.ZodBoolean>;
    toolAttentionTopK: z.ZodDefault<z.ZodNumber>;
    localBaseUrl: z.ZodDefault<z.ZodString>;
    localRouting: z.ZodDefault<z.ZodBoolean>;
    spillMaxFiles: z.ZodDefault<z.ZodNumber>;
    spillTtlHours: z.ZodDefault<z.ZodNumber>;
    compressionBudgetMs: z.ZodDefault<z.ZodNumber>;
    dedupCapacity: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>>;
export type CostKillerConfig = z.infer<typeof Config>;
export declare function apply(ctx: Context, rawConfig?: Partial<CostKillerConfig>): () => void;
