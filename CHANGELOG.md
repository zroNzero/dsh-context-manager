# Changelog

## v1.0.0 — 2026-11-10

首个生产版本（CostKillerOrchestrator）。

### 核心能力

- **CacheAnchor 净收益门控**：`coldReadPenalty = cachedPrefixTokens × (missPrice − hitPrice)`；
  `netBenefit <= 0` 或前缀破坏收益不足时拒绝 Patch，并写 `[Block]` 审计日志。
- **源头痛点治理**：AST 骨架化、JSON 压缩、index-first 清单压缩、head-tail + 落盘指针。
- **CoT 蒸馏**：`<thought>` / `[思考]` 块压成一行 `[决策: …]`，随折叠物理移除。
- **上下文状态卡**：折叠摘要包含 `[CONTEXT_INDEX]`（目标/决策/未决/约束/下一步），并做约束回填校验。
- **去重总线**：相同工具输出第二次起只保留指针。
- **Schema 瘦身**：仅截断 description（默认 120 字符），工具集与参数结构不变，前缀稳定可缓存。
- **本地路由**：压降后 <4000 tokens 且无跨文件依赖 → 本地 Ollama；5s 硬超时自动降级。
- **压缩熔断**：连续 3 次失败/零收益 → open，冷却后半开试探。
- **Spill 治理**：TTL + 数量上限 + pin 保护，避免落盘无限膨胀。

### 工程

- 时间预算萃取（默认 50ms），超大输入（>250k 字符）走快速通道。
- 全量 TypeScript strict 编译；`npm run build/test/verify/demo` 全部 EXIT=0。
- 无 `console.log`；`debug.log` 5MB 轮转。

### 修复

- `joinSignatures` 误把 `const x = …` 当作多行签名合并，导致方法体泄漏进骨架。
- `dedupeKey` 归一化空白会误判不同输出为重复，改为仅去尾部空白后精确哈希。
- Schema / Routing 日志无节流，长会话下日志膨胀；改为结果变化时记录。
