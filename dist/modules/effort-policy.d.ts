/**
 * EFFORT POLICY —— 按任务难度分配 reasoning effort（动态「杀鸡不用牛刀」）。
 *
 * 事实依据（本案实测，会话 794b93ff，353 个 assistant 步骤）：
 *   reasoning 占输出字符 60.7%、tool-call 参数 37.6%、正文只有 1.8%。
 *   output 又是账单的 67.1%（prompt 32.0% + hit 0.9%）。
 *   也就是说 **reasoning 一项就吃掉约 40% 的账单**，而 profile 里把它固定成了 `max`
 *   （模型自身的说明：max = "Reserve for the hardest quality-first tasks"，
 *   high 才是 "the default balance for most tasks"）。
 *
 * 策略（只在「不需要深思」的地方省，绝不往上加）：
 *   1. 按**本轮用户消息**判定任务档位，整轮一致 -> 可预测、可审计、不抖动；
 *   2. 关键安全阀：只下调，绝不上调（`lower()`），宿主若已设更低就听宿主的；
 *   3. 轮内工具报错时**升级**回高思考（调试需要深度）；
 *   4. 每次决策都写日志 `effort.decided`，可回溯。
 */
export type EffortLevel = 'off' | 'low' | 'high' | 'max';
export type TurnTier = 'trivial' | 'easy' | 'normal' | 'hard';
export interface EffortPolicyConfig {
    enabled: boolean;
    trivial: EffortLevel;
    easy: EffortLevel;
    normal: EffortLevel;
    hard: EffortLevel;
    /** 轮内出现工具报错时，把该步升级到 hard 档。 */
    escalateOnError: boolean;
}
export interface EffortDecision {
    tier: TurnTier;
    /** 最终采用的 effort。 */
    effort: EffortLevel;
    /** 宿主原本要求的 effort。 */
    requested: EffortLevel;
    reason: string;
    escalated: boolean;
}
export declare function normalizeEffort(value: unknown): EffortLevel | undefined;
/** 取两者中更省的那个；用于「只下调、不上调」。 */
export declare function lowerEffort(a: EffortLevel, b: EffortLevel): EffortLevel;
/** 降一档：max -> high -> low -> off。 */
export declare function oneNotchDown(level: EffortLevel): EffortLevel;
/**
 * 最后一条消息是不是用户消息 —— 用来区分「规划步」与「执行步」。
 * 本轮首个请求以 user 结尾（需要规划）；之后的请求以 tool 结果结尾（执行既有计划）。
 */
export declare function lastMessageRole(messages: unknown): string;
export declare function looksLikeError(text: string): boolean;
/**
 * 判定本轮任务档位。只看最后一条用户消息——整轮共用同一档位，
 * 避免「同一步骤里一会儿深思一会儿不思考」造成的质量抖动。
 */
export declare function classifyTurn(text: string): {
    tier: TurnTier;
    reason: string;
};
/** 最后一条工具结果是否报错（调试步骤需要深度思考）。 */
export declare function lastToolErrored(messages: unknown): boolean;
/**
 * 把 pre-step 观测到的信号拼成最小消息视图，供 decideEffort 复用同一套分类逻辑。
 *
 * 不能直接截取最近 N 条消息：一輪里工具步骤可能很多，最后 8 条里往往已经没有
 * 用户消息，`lastUserText` 会返回空 -> 档位被误判成 normal。
 */
export declare function syntheticMessages(input: {
    userText: string;
    lastRole: string;
    toolErrored: boolean;
}): Array<{
    role: string;
    content: Array<{
        type: 'text';
        text: string;
    }>;
}>;
/** 最后一条用户消息的文本。 */
export declare function lastUserText(messages: unknown): string;
/**
 * 决定这一步的 reasoning effort。永远不高于宿主请求的值。
 */
export declare function decideEffort(input: {
    messages: unknown;
    requested?: unknown;
    policy: EffortPolicyConfig;
}): EffortDecision;
