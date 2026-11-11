/**
 * PrefixSpill —— 前缀无损折叠（v1.5）。
 *
 * 问题：一次请求的上下文里，绝大部分是「模型自己走过的老路」——旧工具结果约占 39%。
 * 每一次模型调用都要按缓存价把它们重读一遍，是账单里最大的单项支出之一。
 *
 * 做法：把「最近 N 条之外」的旧工具结果整段落盘，上下文里只留
 * 「收据 + 文件名 + 头部摘要」。信息**一个字节都没丢**——模型需要时用 read 读回来。
 *
 * 五条硬约束：
 *   1. **绝不改动 assistant 的任何字节**。这条是事故换来的：v1.4 曾把旧 tool-call 的
 *      arguments 换成 `{"_spill":...}` 收据，结果模型把它当成调用范式照抄，直接产出
 *      `{"_spill":...}` 当 write 的参数，宿主判 MALFORMED_RESPONSE（tool input is
 *      invalid JSON），整轮失败。assistant 消息是模型的模仿模板，不是可压缩的自由文本。
 *      因此本模块只碰 `role === 'tool'` 的消息。
 *   2. **纯函数**：同一段文本永远得到同一个文件名与同一段收据，因此前缀在缓存里
 *      保持字节稳定；一旦收据长度随请求漂移，整段前缀会失效（0.02 元/M → 1 元/M）。
 *   3. **绝不改消息配对的顺序或数量**：只替换 tool 消息的文本，tool-call 的 id 与 name
 *      原样保留，tool-call 与 tool-result 的对应关系完全不动。
 *   4. **收据要短**：它出现在每一条折叠里，哈希 64→12 位、路径→裸文件名、
 *      头部 160→100 字符，合计省下约 1/4 的收据开销。
 *   5. **Fail-Closed**：落盘失败就原样留着，绝不给出读不到的指针。
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
