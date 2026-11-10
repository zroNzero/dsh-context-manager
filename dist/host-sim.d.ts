/**
 * HostSimulator —— 宿主契约模拟器（测试专用）。
 *
 * 2026-11-10 事故的教训：只断言“插件内部状态”不足以发现宿主侧违约。
 * 本模块按 DSH 的真实结构建模：
 * - surface：会被请求派生的消息节点（assistant / tool / user / system）
 * - 日志级事件：tool/call（surfaceOp=null），不参与 surface，但属于会话日志
 *
 * 校验规则（provider 约束 + 事故特征）：
 * 1. assistant 的每个 tool-call 必须被紧随其后的 tool 结果逐一对上；
 * 2. 不允许出现孤儿 tool 结果；
 * 3. 每个日志级 tool/call 事件，必须在 surface 上存在承载它的 assistant 消息
 *    —— 折叠把 assistant 删掉、tool/call 留下，就会在这里报错。
 */
export interface SimEvent {
    seq: number;
    type: string;
    role?: string;
    text?: string;
    toolCalls?: readonly string[];
    toolCallId?: string;
    /** 默认 true；日志级事件（tool/call）为 false。 */
    onSurface?: boolean;
    /** 若存在，表示该事件是替换事件：用自身替换 [start, end] 区间。 */
    replace?: {
        start: number;
        end: number;
    };
}
export interface SimMessage {
    seq: number;
    role: string;
    text: string;
    toolCalls: readonly string[];
    toolCallId?: string;
}
export declare class HostSimulator {
    private readonly input;
    private readonly bySeq;
    private surface;
    constructor(events: readonly SimEvent[]);
    build(): this;
    messages(): SimMessage[];
    /** 事件里声明的、但 surface 上没有 assistant 承载的 tool/call。 */
    orphanToolCalls(): string[];
    validate(): string[];
}
export declare function validateMessages(messages: readonly SimMessage[]): string[];
/**
 * 模拟一次「区间折叠」：把 [startSeq, endSeq] 的 surface 消息整体替换为一条 user 摘要。
 * 返回折叠后的消息序列（纯函数，不改原数组）。
 */
export declare function simulateRangeFold(messages: readonly SimMessage[], startSeq: number, endSeq: number, summarySeq?: number): SimMessage[];
