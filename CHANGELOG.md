# Changelog

## Unreleased — 真实计费与输出端杠杆

- **PRICING_TABLE**：内置 DeepSeek 官方人民币单价（flash / v4-pro，高峰/空闲），
  北京时间高峰判定（周一至周五 9–12、14–18）；`pricing.loaded` 写入日志。
- **CacheAnchor 真实冷读罚金**：`cachedPrefixTokens × (missPrice − hitPrice)`，
  价格来自 PRICING_TABLE，不再使用固定 1/30。
- **输出端硬截断**：`outputMaxTokens=1500`，JSON 闭合或代码块闭合立即 STOP，
  日志 `output.truncated`（reason = json_closed / code_closed / max_tokens）。
- **本地路由默认开启**：500ms 探测 127.0.0.1:11434；不可达写
  `routing.local_unavailable`（不阻塞）；可达且 <3000 tokens 走本地，失败写
  `routing.local_degraded` 并回退云端。

## v1.0.0-prod — 2026-11-11

### 三大杠杆 + 防降智护栏

- **AST 深度骨架化**：签名之外补回 1-hop 依赖（参数类型、抛出异常、被继承/实现/引用
  的声明名），写入 `[AST_DEP]` 行；日志 `ast.deep_dependencies`。
- **Schema 分层虚拟化**：top-3 工具全量 schema；rank 4–10 只给「参数名 + 类型」签名；
  其余只留目录 + `[TOOL_NOT_LOADED]` 显式提示 + `search_tools`。
- **工具输出形状保护**：报错/警告行保留前后 3 行上下文，连续重复行折叠为 `⟨×N⟩`；
  日志 `shape.protected`。
- **防降智对抗测试**（verify 21/21）：
  - A：2000 行复杂嵌套类型代码 → 参数类型/异常/1-hop 依赖全在；
  - B：80 工具会话 → ≤12 个注入 + `search_tools` + 显式 `TOOL_NOT_LOADED`；
  - C：中间报错日志 → 错误前 3 行上下文保留。
- `self-test 17/17`、`tsc EXIT=0`。

## v1.0.0 — Production Release — 2026-11-11

### 全量武器审计后的四项重型系统

- **SCOPE 分层预算**：按总上下文切分 Tools/Memory/Live 预算，自适应
  `retainRecent` 与旧工具字符上限；日志 `scope.budget`。
- **OSIRIS 状态密封**：system/tools/history 三套哈希 + 意图桶（bucket）；
  同一 bucket 复用工具集，解决 Tool Attention 每轮换工具导致的前缀击穿；
  日志 `osiris.seal` / `osiris.anchor`。
- **SCOUT 语义工具路由**：BM25（IDF 加权）替代朴素命中，top-5 完整 schema +
  目录 + `search_tools`；日志 `scout.route`。
- **ToolPipe 数据平面**：工具输出落盘后只传 `[PIPE] ref=pipe-xxxxxxxx`，
  新增 `read_ref` 元工具按需取回；索引持久化到 `.pipe-index.json`；
  日志 `toolpipe.publish` / `toolpipe.read`。
- 测试：`self-test 17/17`、`verify 18/18`；demo 同时输出四类日志。

## v1.3.0 — 2026-11-11

### 四件重型武器

- **Tool Attention（顶-5 懒加载）**：按意图对工具打分，只注入 top-5 完整 schema；
  其余工具在 system 消息里保留 `[TOOL_CATALOG]` 一行目录，并提供 `search_tools`
  元工具按需拉取。demo：80 → 5 个工具，schema 2,200 → 208 tokens；线上 80 工具
  场景预计 20,296 → ≤2,500。动态工具集会改变前缀，记录 `tool_attention.prefix_risk`。
- **TOON 列式无损编码**：同构 JSON 数组 → 表头 + 紧凑行；demo：120×5 行
  3,292 → 1,173 tokens（-64.4%），零信息损失（JSON.stringify + 转义可逆）。
- **语义缓存**：在精确哈希之外增加 Jaccard 关键词相似（阈值 0.85），命中重放
  并写 `cache.semantic_hit`；demo 命中分数 0.895。
- **本地路由探测**：`localBaseUrl`（默认 127.0.0.1:11434）500ms 探测；
  不可达写 `routing.local_unavailable` 且不阻塞主链路，可达时对简单任务走本地并写
  `routing.local_hit`。演示同时覆盖两种结局。
- 测试：`self-test 13/13`、`verify 18/18`。

## v1.2.0 — 2026-11-11

### 请求级历史重写 + 精确哈希响应缓存（不碰 session surface）

- **HistoryRewriter**：在 `llm.stream` 发送前重写 `request.messages`：
  - 旧 tool 结果 → 头/尾/错误行 + 重跑提示；
  - 旧 assistant 文本 → 剥离 CoT、截断；
  - user / system / 最近 N 条保持原样。
  只改 content、不删除不重排消息，`toolCallId` 配对完全保留，不会复现孤儿 tool/call。
  实测：`8,042 → 4,788 tokens（-40.4%）`，日志 `context.rewritten`。
- **ResponseCache**：按 `model + messages + tools` 精确哈希缓存流式响应，
  TTL 5 分钟、32 条 / 8MB；命中直接重放，日志 `cache.response_hit`。
- 新增配置：`rewriteEnabled`（默认 true）、`rewriteRetainRecent`(8)、
  `rewriteToolChars`(700)、`rewriteAssistantChars`(400)、
  `responseCacheEnabled`(true)、`responseCacheTtlMs`(300000)。
- 测试：`self-test 10/10`、`verify 18/18`（新增请求级重写与缓存重放断言）。

## v1.1.0 — 2026-11-11

### A 杠杆：上下文防火墙（Pointer-First） + B 杠杆：寿命摊销

- **上下文防火墙**：工具输出超过 `firewallTokens`（默认 250）时，非结构化压缩一律
  替换为「结构化摘要（头/尾/错误行）+ 落盘指针」，强制 `extractionMode != none`。
- **阈值下放**：`extractionTokens 500`、`admissionTokens 800`，让 1–2k 输出真正进入压缩。
- **CacheAnchor 寿命摊销**：`netBenefit = savedByCompression × (1 + 剩余回合) − 冷读代价`；
  `assumedTurns` 默认 40，剩余回合 = `assumedTurns − turn`。折叠不再“见破前缀就拦”。
- 日志新增 `remainingTurns` / `lifetimeCompression`；实测轨迹：
  `prefixBreak=true, savedTokens=2458, remainingTurns=1998, netBenefit=4825382 → approved`。
- 测试：`self-test 9/9`、`verify 16/16`（新增 `extraction.firewall-summary`、
  `firewall summarizes >250 token outputs`、`amortized fold accepted under prefix break`）。

## v1.0.13 — 2026-11-11

### 分账修正：extraction / admission 不再混记

- 之前「extraction + 落盘指针」的节省全部记到 `extraction`，导致面板
  `admission` 恒为 0（即使 `admitted=true`）。
- 现按两段拆账：`extraction` = 原文 → 压缩文；`admission` = 压缩文 → 指针化结果，
  两者之和仍等于该次工具输出的总节省，`totalSavedTokens` 不变。
- `byModuleBefore` 同步拆分（extraction before = 原文，admission before = 压缩文）。

## v1.0.12 — 2026-11-11

### 恢复 hook 链路 + 工作区解析 + 每维压缩率（schemaVersion 5）

- **修复 hook 全挂**：`workspace.ts` 在 cordis 代理上读取 `agent.options` 会抛
  `cannot get property "options" without inject`，导致 pre-step / post-execute
  整段被 catch 吞掉（线上 380 次失败、压缩全停）。现在所有代理属性访问逐项
  `try/catch`；schema 安装同样加保护；新增
  `workspace.safe-proxy`（self-test）与 `hooks survive opaque agent proxy`（verify）。
- **workspace 解析**：优先 `ctx.sessions.get(id)`，取不到时
  `sessions.list().find(header.id)` 兜底；hook 收到字符串 sessionId 时也能解析；
  保留 `workspace.resolved` / `workspace.unresolved` 日志（含 hookCwd / storeCwd）。
- **每维压缩率**：`savings.json` 升到 `schemaVersion: 5`，顶层与每个工作区新增
  `byModuleBefore`（每模块原始 token）；面板用 `byModule / byModuleBefore` 算每维比例。
  `fold` 也记录 before，面板可自行决定是否展示。
- 旧字段全部保留；`self-test 8/8`、`verify 14/14`。

## v1.0.11 — 2026-11-10

### 工作区解析与压缩触发

- **workspace 解析改走权威路径**：`ctx.sessions.get(sessionId)?.header?.cwd`（SessionStore），
  不再依赖 hook 传入对象上的 cwd 字段；解析失败时写 `workspace.unresolved` 诊断日志
  （含 hook cwd / store cwd / sessionId）。
- **真实流量下压缩不触发**：线上工具输出多在 1.5k tokens，而原默认
  `extractionTokens=2500 / admissionTokens=4000`，导致只有 schema 在省。
  默认值调整为 `extractionTokens=800`、`admissionTokens=1500`、`minSaveTokens=100`，
  让 1–2.5k 的输出也能进入结构化压缩 / 落盘指针。

## v1.0.10 — 2026-11-10

### 工作区解析诊断

- 扩充会话 cwd 的候选字段（`header/meta/info/options` 等），并记录
  `workspace.resolved` / `workspace.unresolved`，便于在真实宿主上定位解析失败。

## v1.0.9 — 2026-11-10

### 面板契约 v4：按工作区分账 + 比例分母

- `savings.json` 升级到 `schemaVersion: 4`，新增：
  - `byWorkspace`：按会话工作区（稳定短 hash）分账，含路径、短名、各模块统计、
    `tokensBeforeTotal/AfterTotal`；顶层字段保持为各工作区之和。
  - `tokensBeforeTotal / tokensAfterTotal`：每次请求 prompt token 的压缩前/后累计，
    供面板计算 `1 - after/before`；当前只覆盖 schema 维度，标记
    `tokensBeforeTotalEstimated: true`。
- 工作区识别使用会话 cwd（`session.cwd / header.cwd / ...`），不再依赖 `process.cwd()`；
  `workspaceId` 对大小写、分隔符、尾斜杠不敏感，跨重启稳定。
- 旧字段全部保留（`totalSavedTokens`、`byModule`、`perRequestSavings`、
  `eventSavings`、`contextReduction`、`estimatedCostTokens`、`ledgerId`、`revision`）。
- 回归测试：`savings.ledger-cost-model` 覆盖双工作区、稳定 id、before/after 累计。

## v1.0.8 — 2026-11-10

### 面板契约与计费口径

- `savings.json` 升级为快照契约（schemaVersion 3）：新增 `ledgerId`、`revision`，
  消费方必须按 ledgerId **替换**而不是跨重启累加（面板曾出现 131 事件 / 377k 的累积虚高）。
- 新增缓存感知成本估算 `estimatedCostTokens`：
  schema 位于缓存前缀（价格 1/30），工具输出按未命中价 1，加权后才是可比较的账单近似。
- `totalSavedTokens` 明确为「prompt 中少发的 token 数」，并在 `savings.md` 写明
  它不是账单；fold 作为一次性上下文缩减单独展示。
- 回归测试：`savings.ledger-cost-model`。

## v1.0.7 — 2026-11-10

### 修复：折叠记账虚高（面板数字不符预期）

- `planMemoryFold` 曾用「整个上下文的 token 数」作为节省基数，
  实际只折叠了少量候选消息，导致 fold 节省被放大到整个上下文
  （例：只折叠 1 条消息却记 163,287 tokens），同时虚高 CacheAnchor 的净收益。
- 现在按「实际候选消息 token − 摘要 token」计量；上下文总量单独作为
  `contextTokens` 仅用于观测。
- 节省面板新增口径区分：`perRequestSavings`（schema，按请求累计）、
  `eventSavings`（admission/extraction/dedup）、`contextReduction`（fold，一次性），
  并在 `savings.md` 写明三者相加不等于账单。
- 回归测试：`memory.savings-accounting`（大上下文 + 小候选，断言节省不超过候选本身）。

## v1.0.6 — 2026-11-10

### 清理

- 移除设计输入文档 `structure.txt` / `weapons.txt`（不再随仓库发布）。
- 运行时产物（`debug.log`、`savings.*`、`spill/`）保持被 `.gitignore` 排除。

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
