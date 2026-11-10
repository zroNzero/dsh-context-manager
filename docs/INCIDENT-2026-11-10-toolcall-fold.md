# INCIDENT 2026-11-10 — 历史折叠导致 `INVALID_REQUEST`

## 摘要

v1.0.x 的 Memory 折叠把「带 tool-call 的 assistant 消息 + 其 tool 结果」整体替换成一条
user 摘要。DSH 的 `tool/call` 事件是**日志级事件（`surfaceOp = null`）**，不随区间替换移除，
导致后续请求里出现「有 tool-call、却找不到紧随其后的 tool 结果」的非法消息序列。

DSH 会话 `b82b2558` 中 turn 21–23 连续失败：

```
DeepSeek Messages tool calls need immediate results   (INVALID_REQUEST)
```

## 时间线与证据（session `b82b2558`）

| 事件 | seq | 内容 |
|---|---:|---|
| fold #1 | 2538 | `surfaceOp.replace 1160–1186`，`sourceEventSeqs` 8 条 |
| — 1160 |  | assistant，`tool-call: call_00_ET_9kNb…` |
| — 1164 |  | tool result（对应 1160） |
| — 1168 |  | assistant，2 个 tool-call |
| — 1172 / 1178 |  | 两条 tool result |
| — 1182 |  | assistant，2 个 tool-call |
| — 1184 / 1186 |  | 两条 tool result |
| 孤儿事件 | 1161 / 1169 / 1173 / 1183 / 1185 | `tool/call`，`surfaceOp` 为 `null`（不在 surface 上） |
| turn 21 | 2548 | `turn/end` → error `INVALID_REQUEST` |
| turn 22 | 2556 | 同样错误 |
| turn 23 | 2564 | 同样错误 |
| fold #2 | 2569 | `surfaceOp.replace 1641–1663`，区间内 assistant **无 tool-call**（纯文本/CoT） |
| turn 24 | 2665 | `completed` |

对照组非常干净：**带 tool-call 的折叠 → 连续 3 轮失败；纯文本折叠 → 下一轮恢复正常。**

## 根因

1. Agent Loop 的请求由 surface 派生的消息构建；
2. `tool/call` 事件不参与 surface（`surfaceOp` 缺失），折叠区间无法覆盖它；
3. 折叠把 assistant(tool-call) 与其 tool 结果一起替换成 user 摘要后，
   日志中仍残留这些 `tool/call`，而它们的「立即结果」已被删除；
4. Provider 校验「tool calls need immediate results」失败，请求被拒绝。

## 修复（v1.0.4）

`src/modules/memory.ts`：

- 折叠候选永久排除：
  - `role === 'tool'`（所有工具结果）
  - `role === 'system'`
  - `hasToolCall === true`（任何含 tool-call 块的 assistant）
- 增加二次防线：候选区间若仍含 tool-call / tool 结果，直接返回空补丁并写
  `memory.pairing_rejected`；
- `memory.planned` 增加 `toolcallExcluded` 计数，便于审计。

`src/index.ts`：`collectEntries()` 为每条消息计算 `hasToolCall`（扫描 content 中的
`tool-call` 块），作为上述安全边界的输入。

## 回归测试

`src/self-test.ts` 新增 `memory.fold-excludes-toolcall`：

- 混合历史（含 tool-call assistant 与 tool 结果）折叠后，`foldedSeqs` 中不得出现
  tool 结果或 `hasToolCall=true` 的消息；
- 全是 tool-call / tool 结果的历史必须返回 `patch === null`。

## 验证

```
npm run build   EXIT=0
npm run test    4 suites, 0 failed
npm run verify  9/9
```

## 残余风险

- 历史折叠现在只处理纯文本 / CoT 消息，工具输出改由源头流控（Extraction/Admission）
  与去重总线治理，折叠收益下降但结构安全；
- 本次事故产生的旧折叠事件（seq 2538）已固化在会话日志中，但 turn 24 起请求恢复正常，
  无需手工修复；
- 若未来要折叠 tool-call 区间，必须先实现「同步移除 tool/call 事件」的机制，
  不能只替换 surface。
