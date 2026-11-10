/**
 * RoutingModule —— 本地优先路由（v3.5）。
 *
 * 策略（按优先级）：
 * 1. 存在跨文件依赖 → 云端（云端上下文更完整）；
 * 2. Extraction 压降后上下文 < smallContextTokens（默认 4000）→ 强制本地；
 * 3. 极短、无推理要求的任务 → 本地；
 * 4. 其余 → 云端。
 *
 * 本地调用硬超时 5 秒；超时/连接失败一律降级云端，并写
 * `[Routing] Fallback to cloud due to timeout` 审计日志。
 */
export interface RoutingOptions {
    baseUrl?: string;
    model?: string;
    timeoutMs?: number;
    failureThreshold?: number;
    cooldownMs?: number;
    /** 压降后上下文低于该值即强制本地。 */
    smallContextTokens?: number;
}
export interface RoutingContext {
    prompt: string;
    contextTokens: number;
    crossFileDependency: boolean;
}
export type RoutingReason = 'small-context' | 'trivial-task' | 'cross-file-dependency' | 'complex-context';
export interface RoutingDecision {
    route: 'local' | 'cloud';
    reason: RoutingReason;
    contextTokens: number;
}
export interface RoutingResult {
    route: 'local' | 'cloud';
    text: string;
    reason: string;
    latencyMs: number;
    degraded: boolean;
}
/** 短任务判定：<500 字符、未出现推理关键词。 */
export declare function isTrivialTask(text: string): boolean;
/** 跨文件依赖探测：显式 import/require 多文件路径、或同时出现多个源文件引用。 */
export declare function hasCrossFileDependency(text: string): boolean;
export declare class RoutingModule {
    private readonly baseUrl;
    private readonly model;
    private readonly timeoutMs;
    private readonly failureThreshold;
    private readonly cooldownMs;
    private readonly smallContextTokens;
    private failures;
    private openUntil;
    constructor(options?: RoutingOptions);
    get circuitOpen(): boolean;
    /** 纯策略决策（不发起网络请求），供 pre-step 记录与外部编排使用。 */
    decide(context: RoutingContext): RoutingDecision;
    /** 决策 + 必要时尝试本地调用；失败/超时返回云端结果。 */
    routeWithContext(context: RoutingContext, signal?: AbortSignal): Promise<{
        decision: RoutingDecision;
        result: RoutingResult;
    }>;
    /** 尝试本地执行；失败/超时/熔断一律 route='cloud' 且 degraded=true。 */
    attemptLocal(prompt: string, signal?: AbortSignal): Promise<RoutingResult>;
}
