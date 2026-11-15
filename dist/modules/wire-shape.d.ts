/**
 * WireShape —— 出站消息表在**宿主序列化器**眼里的形状约束。
 *
 * 背景（2026-11-15 14:26 线上事故）：deepseek-account 的 `systemPromptUpdate`
 * 是 `in-history`，所以系统提示词每次变化，宿主都会往历史里追加一条快照
 * `system` 消息，并配一条 `developer` 消息（tool-addition / tool-removal）。
 * 宿主的 Messages 序列化器对这类「系统更新」有硬性落位规则：
 *
 *   flushSystemUpdates():
 *     if (messages.at(-1)?.role !== 'user') → unsupported(
 *       'system update without a preceding user or tool-result turn')
 *
 * 也就是：系统更新只能紧跟在**用户消息或工具结果**之后落位；落位点发生在
 * 「下一条 assistant 之前」和「请求末尾」。工具结果在 wire 上就是 user 角色，
 * 所以它们同时充当 system 更新的落位锚点。
 *
 * 我们的历史重写会删消息（整对逐出 tool-call + tool 结果）。只要被删的那条
 * 工具结果正好是某段系统更新的落位锚点，wire 上最后一条就变成 assistant，
 * 宿主直接 `UNSUPPORTED_CONTENT`，整轮失败 —— 而且会**持续**失败，直到压缩
 * 把这段历史换掉为止（实测连续失败 4 轮）。
 *
 * 所以：删消息之前先算出「哪些工具结果是锚点」，锚点不许删；重写之后再用
 * `assertSystemUpdateGeometry` 复核一次，形状一旦不对就整体回退（Fail-Closed）。
 */
/**
 * 返回**不能删**的工具结果下标：它们是后续某次「系统更新落位」的唯一锚点。
 *
 * 判定与宿主序列化器同构：从后往前看，若一条 assistant（或请求末尾）之前隔着
 * 至少一条 system/developer，而它前面最近的一条非 system/developer 消息是工具
 * 结果，那么这条工具结果一旦被删，落位就会失败。
 */
export declare function wireAnchorToolIndices(messages: any[]): Set<number>;
/**
 * Fail-Closed 复核：整张表是否满足「系统更新落位」约束。
 *
 * 与宿主序列化器同构地走一遍：缓冲 system/developer，遇到 assistant 或走到末尾
 * 时必须能落位（上一条 wire 消息是 user / tool）。返回 false 表示这张表会被宿主
 * 拒绝，调用方必须回退到未改写的原始消息。
 */
export declare function assertSystemUpdateGeometry(messages: any[]): boolean;
