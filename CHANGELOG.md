# Changelog

## v1.0.5 — 2026-11-10

### 变更

- **插件更名**：包名与插件标识统一为 `dsh-context-manager`（与仓库同名），
  `cordis.patch.yml`、`name` 导出、文档同步更新。
- **Token 节省面板**：新增 `SavingsLedger`，按 Admission / Extraction / Dedup /
  Fold / Schema 归类记账；运行期写 `savings.md` + `savings.json`，
  `costkiller_status` 工具返回同一份快照（含分模块节省与面板路径）。
- **折叠区间安全修复**：删除 `widenFoldRange`。该函数会在替换前把区间向前扩到
  「带 tool-call 的 assistant」，绕过 v1.0.4 的候选守卫，可能重新制造孤儿
  tool/call（即 v1.0.4 修复的那类事故）。现在折叠区间严格等于计划中的纯文本
  消息；新增回归测试 `fold range never widens into tool-call messages`。
- **Schema 压缩在真实宿主生效**：DSH 的 `llm` 服务挂在 agent 作用域，profile 根
  的 `ctx.get('llm')` 永远为空（日志 `schema.unavailable`）。现在同时从首条
  `agent/pre-step` 的 `payload.agent.loopCtx.llm` 补装，并新增
  `schema installs from agent-scope llm` 回归测试。

## v1.0.4 — 2026-11-10

### 事故修复：折叠导致 `INVALID_REQUEST`

- **现象**：会话 turn 21–23 连续失败
  `DeepSeek Messages tool calls need immediate results (INVALID_REQUEST)`。
- **定位**（session `b82b2558` 日志）：
  - fold #1（seq 2538，范围 1160–1186）包含 3 条带 tool-call 的 assistant；
    DSH 的 `tool/call` 事件是日志级、`surfaceOp=null`，不随区间替换移除，
    于是工具调用与其结果被拆散 → 后续请求非法。
  - fold #2（seq 2569，范围 1641–1663）只含纯文本 assistant，turn 24 正常完成。
- **修复**：折叠候选永久排除 `role === 'tool'`、`role === 'system'`、
  以及 `hasToolCall === true` 的 assistant。历史折叠从此只处理纯文本 / CoT 消息，
  工具结果继续由源头流控（Extraction/Admission）与去重总线治理。
  事故完整记录见 [docs/INCIDENT-2026-11-10-toolcall-fold.md](docs/INCIDENT-2026-11-10-toolcall-fold.md)。
- **回归测试**：`self-test` 新增 `memory.fold-excludes-toolcall`，禁止任何 tool-call
  消息进入折叠区间。
- **宿主契约测试**：新增 `src/host-sim.ts`（surface + 日志级 tool/call 模拟器）与
  `test/fixtures/toolcall-fold.json`（事故片段回放）。可复现“消息级配对合法、
  但 tool/call 失去承载 assistant”这一宿主侧违约。
- **延迟安装测试**：`verify` 新增“llm 服务晚于插件就绪”用例，确认 schema 压缩
  会自动补装。

## v1.0.3 — 2026-11-10

### 修复

- **Schema 压缩在真实 DSH 中静默失效**：插件 apply 早于 `llm` 服务注册，`ctx.get('llm')`
  返回 undefined，日志只留 `schema.unavailable`。改为延迟安装 + 重试（500ms × 20），
  成功后记录 `schema.installed`，失败才记录 `schema.unavailable`。
- `qualityPass` 语义修正：现在表示“最终摘要包含全部硬约束”（缺失会回填并记录 `backfilled`），
  不再把“需要回填”误报为失败。
- 卸载时清理重试定时器，避免悬挂 timer。

## v1.0.2 — 2026-11-10

### 修复

- **无 config 时激活失败**：DSH 用插件导出的 `Config` 校验条目配置，缺省条目传入
  `undefined`，zod object 直接报 `expected object, received undefined`。
  `Config` 改为 `.prefault({})`，未写 `config` 也能通过校验并套用全部默认值。
- 本地 profile 安装目录同步更新 `dist`。

## v1.0.1 — 2026-11-10

### 修复

- **GitHub 安装缺 `dist/`**：`dist/` 曾被 `.gitignore` 排除，`pnpm install github:...` 只得到
  `cordis.patch.yml` 与元数据，DSH 报 `Cannot find package '...dist/index.js'`。
  现在 `dist/` 随仓库发布，GitHub 安装无需本地构建即可加载。
- 安装后自检：`dist/index.js` 可被 ESM `import()` 解析出 `name / inject / Config / apply`。

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
