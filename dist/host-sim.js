"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.HostSimulator = void 0;
exports.validateMessages = validateMessages;
exports.simulateRangeFold = simulateRangeFold;
class HostSimulator {
    input;
    bySeq;
    surface = [];
    constructor(events) {
        this.input = [...events].sort((a, b) => a.seq - b.seq);
        this.bySeq = new Map(this.input.map((event) => [event.seq, event]));
    }
    build() {
        this.surface = [];
        for (const event of this.input) {
            if (event.onSurface === false)
                continue;
            if (event.replace) {
                const start = this.surface.indexOf(event.replace.start);
                const end = this.surface.indexOf(event.replace.end);
                if (start >= 0 && end >= start)
                    this.surface.splice(start, end - start + 1, event.seq);
                else
                    this.surface.push(event.seq);
            }
            else {
                this.surface.push(event.seq);
            }
        }
        return this;
    }
    messages() {
        return this.surface.map((seq) => {
            const event = this.bySeq.get(seq);
            return {
                seq,
                role: event?.role ?? 'unknown',
                text: event?.text ?? '',
                toolCalls: event?.toolCalls ?? [],
                toolCallId: event?.toolCallId,
            };
        });
    }
    /** 事件里声明的、但 surface 上没有 assistant 承载的 tool/call。 */
    orphanToolCalls() {
        const carried = new Set();
        for (const message of this.messages()) {
            if (message.role !== 'assistant')
                continue;
            for (const callId of message.toolCalls)
                carried.add(callId);
        }
        const orphans = [];
        for (const event of this.input) {
            if (event.type !== 'tool/call')
                continue;
            const callId = event.toolCallId ?? '';
            if (callId.length > 0 && !carried.has(callId))
                orphans.push(callId);
        }
        return orphans;
    }
    validate() {
        const problems = validateMessages(this.messages());
        for (const callId of this.orphanToolCalls()) {
            problems.push(`tool/call ${callId} has no surface assistant message`);
        }
        return problems;
    }
}
exports.HostSimulator = HostSimulator;
function validateMessages(messages) {
    const problems = [];
    let pending = [];
    for (const message of messages) {
        if (message.role === 'assistant' && message.toolCalls.length > 0) {
            if (pending.length > 0) {
                problems.push(`tool calls ${pending.join(',')} not answered before assistant seq ${message.seq}`);
            }
            pending = [...message.toolCalls];
            continue;
        }
        if (message.role === 'tool') {
            const callId = message.toolCallId ?? '';
            const index = pending.indexOf(callId);
            if (index < 0) {
                problems.push(`orphan tool result ${callId || '(missing id)'} at seq ${message.seq}`);
                continue;
            }
            pending.splice(index, 1);
            continue;
        }
        if (pending.length > 0) {
            problems.push(`tool calls ${pending.join(',')} have no immediate results before ${message.role} seq ${message.seq}`);
            pending = [];
        }
    }
    if (pending.length > 0)
        problems.push(`dangling tool calls ${pending.join(',')} at end of context`);
    return problems;
}
/**
 * 模拟一次「区间折叠」：把 [startSeq, endSeq] 的 surface 消息整体替换为一条 user 摘要。
 * 返回折叠后的消息序列（纯函数，不改原数组）。
 */
function simulateRangeFold(messages, startSeq, endSeq, summarySeq = endSeq + 1) {
    const start = messages.findIndex((message) => message.seq === startSeq);
    const end = messages.findIndex((message) => message.seq === endSeq);
    if (start < 0 || end < start)
        return [...messages];
    const next = [...messages];
    next.splice(start, end - start + 1, {
        seq: summarySeq,
        role: 'user',
        text: '[MEMORY] folded',
        toolCalls: [],
    });
    return next;
}
