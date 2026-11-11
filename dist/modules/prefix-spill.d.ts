/**
 * PrefixSpill —— 前缀无损折叠（v1.3 主杠杆）。
 *
 * 问题：一次请求的上下文里，旧工具结果占 ~39%（实测 650K 字符预算下 251K 字符），
 * 每一次模型调用都要按缓存价把它们重读一遍。它们**几乎全是新内容就已经没了价值**的
 * 历史回显，但删掉又会让模型丢信息。
 *
 * 做法：把「最近 N 条之外」的旧工具结果整段落盘，上下文里只留
 * 「收据 + 绝对路径 + 字节数 + 头部摘要」。信息**一个字节都没丢**——模型需要时可以
 * 用 read 把原文件读回来，所以这不是降智式的截断，是有损压缩的可逆版本。
 *
 * 两条硬约束：
 *   1. **纯函数**：同一段文本永远得到同一个文件名与同一段收据，因此前缀在缓存里
 *      保持字节稳定；一旦收据长度随请求漂移，整段前缀会失效（0.02 元/M 变 1 元/M）。
 *   2. **绝不改消息配对的顺序或数量**：只替换 content 文本，tool-call 与 tool-result
 *      的对应关系完全不动（折叠事故的根因就是动了配对）。
 */
export interface PrefixSpillOptions {
    /** 落盘目录；缺省关闭。 */
    spillDir?: string;
    /** 最近 N 条消息原样保留（模型正在用的窗口）。 */
    retainRecent?: number;
    /** 超过这个字符数的旧工具结果才折叠。 */
    minChars?: number;
    /** 收据里保留的头部字符数。 */
    headChars?: number;
}
export interface PrefixSpillStats {
    folded: number;
    charsBefore: number;
    charsAfter: number;
    files: string[];
}
export declare function foldOldToolResults(messages: any[], options: PrefixSpillOptions): {
    messages: any[];
    stats: PrefixSpillStats;
};
