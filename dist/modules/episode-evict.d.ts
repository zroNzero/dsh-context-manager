/**
 * EpisodeEvict —— 已完成的工具调用「整对逐出」（武器库 #14 CWL / #15 AgentDiet）。
 *
 * 问题：`write` / `edit` 的 tool-call 参数里装着**整个文件内容**。实测本会话
 * tool-call 参数合计 701,535 字符，其中 600 字符以上的占 492,260 字符——
 * 而那些文件早已写到磁盘上了。每个请求都要按缓存价把这份历史重读一遍。
 *
 * 为什么不能像 v1.4 那样只换参数：模型拿历史当模仿模板。把参数换成收据后，
 * 它照着把自己的调用也写成收据，宿主判 `MALFORMED_RESPONSE`（tool input is
 * invalid JSON），整轮失败。教训是 **assistant 的 tool-call 结构不能变成假形状**。
 *
 * 所以这里不「改」调用，而是把「调用 + 它的结果」**成对删掉**：
 *   - 配对完整性：assistant 的 tool-call 与其 tool 结果同时移除，不会留下孤儿
 *     tool 消息（那会被 provider 拒）；
 *   - 模仿安全：历史里不再出现这个调用的任何形状，模型无从模仿错误范式；
 *   - 无损：整对内容先落盘，assistant 消息里留一行纯文本指针
 *     `[evicted tool episode → episode-<hash>.json]`，需要时 read 读回；
 *   - 字节稳定：指针文本是「这一对内容」的纯函数，同一对永远产出同一行，
 *     且逐出发生在保留边界附近（尾部），不会把整段前缀打散导致缓存全灭。
 */
export interface EpisodeEvictOptions {
    spillDir?: string;
    /** 最近 N 条消息原样保留。 */
    retainRecent?: number;
    /** 参数超过这个字符数的调用才整体逐出（小的保持原样，留住最近的操作脉络）。 */
    minArgChars?: number;
}
export interface EpisodeEvictStats {
    episodes: number;
    droppedMessages: number;
    charsSaved: number;
    files: string[];
}
/**
 * 配对完整性硬校验（Fail-Closed 的唯一依据）。
 *
 * 线上事故（2026-11-11 15:00Z）：逐出后整轮报
 * `INVALID_REQUEST: tool_use ids were found without tool_result blocks immediately after`。
 * 教训：任何「删消息」的优化都必须先能证明配对没被破坏，否则收益再大也不能上线。
 *
 * 检查两个方向：
 *   1. 每个 tool-call 的 id，必须在它**之后**存在同名 tool 结果；
 *   2. 每个 tool 结果，必须在它**之前**存在同名 tool-call。
 * 注意结果通常出现 caller 语境里，两方向都查才能真正排除孤儿。
 */
export declare function assertToolPairing(messages: any[]): boolean;
export declare function evictOldEpisodes(messages: any[], options: EpisodeEvictOptions): {
    messages: any[];
    stats: EpisodeEvictStats;
};
