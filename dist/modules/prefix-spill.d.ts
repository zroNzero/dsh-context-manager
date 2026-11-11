/**
 * PrefixSpill —— 前缀无损折叠（v1.4）。
 *
 * 问题：一次请求的上下文里，绝大部分是「模型自己走过的老路」——旧工具结果（38.7%）
 * 和旧 tool-call 参数（后者的占比在丢 thinking 之后升到 45%，成为最大单项）。
 * 每一次模型调用都要按缓存价把它们重读一遍，而命中量是账单里最大的单项支出之一。
 *
 * 做法：把「最近 N 条之外」的旧工具结果、旧 tool-call 参数整段落盘，上下文里只留
 * 「收据 + 绝对路径 + 头部摘要」。信息**一个字节都没丢**——模型需要时用 read 读回来，
 * 所以这不是降智式的截断，是有损压缩的可逆版本。
 *
 * 四条硬约束：
 *   1. **纯函数**：同一段文本永远得到同一个文件名与同一段收据，因此前缀在缓存里
 *      保持字节稳定；一旦收据长度随请求漂移，整段前缀会失效（0.02 元/M → 1 元/M）。
 *   2. **绝不改消息配对的顺序或数量**：只替换文本，tool-call 的 id 与 name 原样保留，
 *      tool-call 与 tool-result 的对应关系完全不动（折叠事故的根因就是动了配对）。
 *   3. **tool-call 的 arguments 必须是合法 JSON**：provider 要求它是 JSON 字符串，
 *      直接塞一段中文收据会被拒；所以参数一律替换成 JSON 对象字面量。
 *   4. **Fail-Closed**：落盘失败就原样留着，绝不给出读不到的指针。
 */
export interface PrefixSpillOptions {
    /** 落盘目录；缺省关闭。 */
    spillDir?: string;
    /** 最近 N 条消息原样保留（模型正在用的窗口）。 */
    retainRecent?: number;
    /** 超过这个字符数的旧工具结果才折叠。 */
    minChars?: number;
    /** 超过这个字符数的旧 tool-call 参数才折叠。 */
    minArgChars?: number;
    /** 收据里保留的头部字符数（工具结果）。 */
    headChars?: number;
    /** 收据里保留的头部字符数（tool-call 参数）。 */
    argHeadChars?: number;
}
export interface PrefixSpillStats {
    folded: number;
    foldedArgs: number;
    charsBefore: number;
    charsAfter: number;
    files: string[];
}
export declare function foldOldToolResults(messages: any[], options: PrefixSpillOptions): {
    messages: any[];
    stats: PrefixSpillStats;
};
