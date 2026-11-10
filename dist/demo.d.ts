/**
 * 端到端演示 v3.5：CoT 蒸馏 / 缓存门控 / 路由决策 / Spill 回收。
 *
 * 1. 121k 字符工具输出 → AST 提纯 + 落盘指针；
 * 2. 历史含 <thought> 的 21 条中间消息 → CoT 蒸馏 + Fold（CacheAnchor 放行）；
 * 3. 第二轮折叠改到已发送前缀 → CacheAnchor 拦截；
 * 4. 路由：小上下文强制本地（mock Ollama 命中）+ 慢服务超时降级；
 * 5. Spill GC：TTL 回收，pinned 文件保留；
 * 6. 批量 20 条输出，统计整体降幅。
 */
export {};
