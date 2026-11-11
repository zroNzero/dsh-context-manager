/**
 * ExtractionModule —— 多引擎萃取（v3.4 审计修订版）。
 *
 * 顺序：核心约束（永不压缩）→ 代码结构骨架化 → JSON 压缩 → 分节压缩 → 头尾截断。
 *
 * Fail-Closed 三条硬规则：
 * 1. CORE_CONSTRAINTS 标记不闭合 → 返回原文本；
 * 2. 代码花括号不配对 / 结构渲染失败 / 声明名丢失 → 返回原文本；
 * 3. 抽取后任一约束值丢失 → 返回原文本。
 * 返回 safe=false 时，调用方（index.ts）必须使用 admitted.text（原文/收据），不得使用本模块输出。
 */
export type ExtractionMode = 'none' | 'ast' | 'json' | 'section' | 'index' | 'head-tail' | 'toon' | 'firewall';
export interface ExtractionResult {
    text: string;
    constraints: string;
    safe: boolean;
    mode: ExtractionMode;
    tokensBefore: number;
    tokensAfter: number;
    tokensSaved: number;
    reason?: string;
    /** 是否因时间预算/体量而退化到快速路径。 */
    degraded?: boolean;
    /** 本次萃取耗时（毫秒），用于延迟审计。 */
    elapsedMs?: number;
}
/** 提取不可压缩约束块；标记不闭合时返回 null（调用方 Fail-Closed）。 */
export declare function extractConstraints(text: string): string | null;
export declare function looksLikeCode(text: string): boolean;
/** 全文花括号是否配对（字符串/注释感知），不配对即视为不可解析。 */
export declare function isBalancedCode(text: string): boolean;
/**
 * 结构化骨架化：保留 import / 类名 / 方法签名 / 注释，函数体与方法体折成 `{ ... }`。
 * 返回 null 表示「不可解析」——调用方必须 Fail-Closed 使用原文本。
 */
export declare function skeletonize(text: string): string | null;
/**
 * 上下文防火墙：超过阈值（默认 250 tokens）的工具输出在进入上下文前，
 * 一律压成「结构化摘要 + 指针」，完整内容由 Admission 落盘后可 read 回读。
 * 这是 v1.1 降低综合成本的主杠杆，不依赖历史折叠，也不会击穿前缀缓存。
 */
export declare function buildFirewallSummary(text: string, maxTokens: number): {
    text: string;
    tokens: number;
    tokensBefore: number;
};
/**
 * TOON —— 列式无损重编码（v1.3）。
 *
 * 只处理「同构对象数组」：表头写一次，行数据用紧凑数组表示；
 * 值用 JSON.stringify 序列化，并对反斜杠与竖线转义，保证可逆。
 * 解析失败或收益为负时返回 null（调用方回退 json/原文）。
 */
export declare function toonEncode(text: string): {
    text: string;
    rows: number;
    cols: number;
    tokensBefore: number;
    tokensAfter: number;
} | null;
export declare function runExtraction(input: {
    text: string;
    maxTokens: number;
    budgetMs?: number;
}): ExtractionResult;
