# CostKillerOrchestrator 交接启动提示词（v2.0 生产冲刺）

> 用法：在新工作区（`D:\PC\dsh\dsh-context-manager`）新开对话，整段粘贴本文件。
> 目标：在**不降智、不降速**的前提下，把真实账单降幅做到 **≥50%**；未达标禁止打生产 tag。

---

## 角色与授权

你是 CostKillerOrchestrator 的生产版负责人，拥有完整代码与终端权限，处于创造模式：
可以重构模块、替换算法、推翻旧实现。唯一不可越界的，是下面“硬红线”和“验收门”。

## 关于创造模式（已核对 DSH 官方文档，勿再凭记忆）

- 创造模式 = 为空白 Session 选择 **`cordis` preset**；入口在 Web 预设选择器与插件页
  「让 Agent 创建插件」，用于创建/修改 DSH 插件与 preset。
- 随包通过 `skill-filesystem` 挂载 skills：`agent-experience`（工具描述与高效上下文加载）、
  `cordis-plugin-development`（Cordis 插件开发流程，含按需读取的 `references/` 与 `templates/`）、
  `editing-cordis-compositions` 等。**开工前先加载 `cordis-plugin-development` 与 `agent-experience`（如可用）。**
- 插件 API 以宿主类型声明 / `@deepseek-ai/*` 包为准，不要凭记忆猜 service 名或 hook 形状。
- 创造模式只切换 preset，**不额外提升权限**；硬红线、Fail-Closed 与 tag 规则照旧生效。

## 工作区与现状

- 仓库：`D:\PC\dsh\dsh-context-manager`（DSH 插件，profile 通过 Junction 指向该目录）
- 当前 main：`3d210e2`；**没有** `v1.0.0-prod` tag（曾违规打过，已删除，未达标不得再打）
- 测试：`self-test 17/17`、`verify 21/21`、`tsc EXIT=0`
- 已集成模块：
  - `extraction.ts`：AST 骨架 + 1-hop 依赖（`[AST_DEP]`）、TOON、防火墙、形状保护
  - `schema-index.ts`：分层 schema（top3 全量 / 7 签名 / 目录 + `search_tools`）、请求级历史重写、OSIRIS/SCOPE/SCOUT、响应缓存、输出截断
  - `cacheAnchor.ts`：净收益 + 寿命摊销 + 官方单价冷读罚金
  - `savings-ledger.ts`：byWorkspace / byModuleBefore / 面板数据
  - `tool-pipe.ts`：`[PIPE] ref` 数据平面 + `read_ref` 元工具
  - `pricing.ts`：DeepSeek 官方人民币单价（flash / v4-pro，高峰/空闲）
  - `output-guard.ts`：1500 token 上限 + JSON/代码块闭合 STOP
  - `osiris.ts` / `scope.ts` / `tool-attention.ts` / `response-cache.ts` / `workspace.ts`
- 真实测量（最近模型测算，非实盘）：
  - 工具密集会话（28,338 prompt → 6,848，输出 1500→1000）：约 **-58.7%**（flash 空闲）
  - 纯聊天会话（8,042 → 4,788）：约 **-35.5%**
  - 综合：45%–55%，**未实盘验证**

## 第一件事：先读再动

0. 加载 `cordis-plugin-development` 与 `agent-experience` skills（创造模式随包提供；不可用则说明原因）。
1. `docs/weapons_v2.txt`（50 项武器库，含当前状态）
2. `README.md`、`CHANGELOG.md`、`docs/INCIDENT-2026-11-10-toolcall-fold.md`
3. `src/index.ts`、`src/modules/*`、`src/verify.ts`、`src/self-test.ts`
4. `debug.log` 最近 200 行、`savings.json`
5. `git log --oneline -20`、`git tag -l`

## 终极目标（四道门，缺一不可）

1. **真实账单降幅 ≥50%**：必须用官方单价 + 真实会话 token 统计，不许用估算糊弄；
2. 三大杠杆生效：AST 1-hop、Schema 分层、输出形状保护；
3. 防降智测试全绿（verify A/B/C + 新增真实场景）；
4. 无孤儿 tool-call、无宿主契约破坏。

只有四门全过，才允许：
`git tag -a v1.0.0-prod -m "Final Production Release"` 并推送。

## 已知卡点与优先攻坚

1. **工具集与缓存冲突**：Tool Attention 每轮换工具会破前缀；OSIRIS 已用 intent bucket 冻结，但跨 bucket 仍会漂移。→ 做“会话级工具集锁定 + 相似意图合并”。
2. **输出截断的计费真实性**：客户端停止消费是否真的让 provider 停止 decode，需要用真实账单验证。
3. **本地路由**：`localRouting` 已默认 true，500ms 探测 127.0.0.1:11434；本机无 Ollama 时只记 `routing.local_unavailable`。需要实测 `routing.local_hit` 并计入免单。
4. **TTL Keepalive（武器 30）**：Provider 缓存 TTL 约 4 分钟，空闲后重放前缀可恢复命中；去做探测与 keepalive 调度。
5. **RCR-Router（武器 37）**：Executor / Judge 角色拆分上下文，潜在大幅降 token。
6. **KV 级武器（24/25/33/34）**：API 不暴露，插件层无法实现；不要再尝试伪造。

## 下一步建议（可直接开工）

1. 建真实账本：每请求记录 `tokensBefore/After`、命中/未命中拆分、输出 token、按官方单价算人民币；
2. 用真实工具密集会话实测降幅，替换模型估算；
3. 实现 TTL Keepalive 探测：记录缓存命中率随空闲时间的变化；
4. 实现会话级工具集锁定 + RCR 角色路由；
5. 用 `verify` 增补“真实场景 A/B/C”（长代码、80 工具、报错日志）并截图 debug.log。

## 硬红线（违反即失败）

1. 禁止裸 `console.log`；所有决策写 `./debug.log`，敏感信息脱敏；
2. 任何压缩导致核心约束丢失 → 立即 Fail-Closed 回退原文；
3. 禁止折叠带 tool-call 的 assistant 消息（会复现孤儿 tool/call 事故）；
4. 禁止为了降本改底层消息配对、禁止空返回伪装成功；
5. 未达标禁止打 tag、禁止把估算写成实测；
6. 不降速：本地探测/路由失败必须无感回退，不得阻塞主链路。

## 交付物

1. 更新后的审计表（50 项状态变化）；
2. 代码 + 全绿测试（`npm run build && node dist/self-test.js && node dist/verify.js`）；
3. 真实 `debug.log`：`pricing.loaded`、`output.truncated`、`routing.local_hit|degraded`、`tool_attention.layered`、`osiris.seal`、`ast.deep_dependencies`、`shape.protected`、`toolpipe.publish|read`；
4. 实盘账单报告：空闲/高峰、flash/v4-pro、工具密集/聊天 四象限；
5. 达标才打 `v1.0.0-prod`，否则说明物理极限（卡在百分之几、卡点是什么）。

## 常用命令

```powershell
cd D:\PC\dsh\dsh-context-manager
npm run build
node dist/self-test.js
node dist/verify.js
npm run demo
Get-Content .\debug.log -Tail 200
```

现在开始：先读武器库与代码，再写测量脚本，最后再改压缩策略。禁止先动 tag。
