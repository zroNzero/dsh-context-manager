# 红线（Red Lines）

> 来源：2026-11-11 到 11-12 的真实事故，不是理论推演。每条后面都跟着现场报错。
> 任何优化在动手前先过这四条；**过不了就不做，不管能省多少。**

---

## RL-1 协议合法性：tool-call 与 tool-result 必须成对且相邻

**事故**：`INVALID_REQUEST: messages.104.2: tool_use ids were found without
tool_result blocks immediately after: call_00_...`（2026-11-11 15:00Z，逐出功能）。

**含义**：
- 每个 `tool-call` 的 id，必须在**紧随其后**的消息里找到同名 `tool` 结果；
- 每个 `tool` 结果，必须在它之前存在同名 `tool-call`；
- 顺序不能颠倒，也不能只删一半。

**推论**：任何「删消息 / 删 block」的优化，必须先能用
`assertToolPairing()` 证明结果合法，否则 Fail-Closed 返回原文。

---

## RL-2 模仿安全：assistant 消息必须是「模型会写出来的形状」

**事故**：`MALFORMED_RESPONSE: tool input is invalid JSON`（2026-11-11 13:45Z）。

**现场**：v1.4 把历史 tool-call 的 `arguments` 换成收据
`{"_spill":"...","_chars":N,"_head":"..."}`。模型把它当调用范式照抄，
真的把收据当 `write` 的参数发出去，整轮失败。

**含义**：
- assistant 的 `content` 是 **few-shot 示范**，不是可压缩的自由文本；
- 不能改 `arguments`、不能塞假块、不能在调用位置放指针；
- 可以整条保留，或整条消失（消失也要满足 RL-1），**没有中间态**。

**推论**：可压缩面只有 `role: 'tool'` 的内容（环境输出）——而且宿主自己
已经在用 `[ADMISSION]` 收据，那才是被允许的形状。

---

## RL-3 thinking 契约：当前轮的 thinking 必须原样回传

**事故**：三次 `INVALID_REQUEST: The content[].thinking in the thinking mode
must be passed back to the API.`

**含义**：
- 当前轮 assistant 的 `reasoning` / `thinking` 块必须逐字回传；
- 历史轮可以不带（探针 `reasoning.probe` 实测 `allowed`）；
- 任何时候都不得改写 thinking 的**内容**。

**边界**：`stripStaleReasoning` 只删「最近 N 条之外」的 thinking 块，
最近窗口原样保留。删整块可以，改半个字不行。

---

## RL-4 质量不降：不拿理解力换 token

**含义**：
- 不把 reasoning effort 降到 `low`/`off`（实测 `high→low` 不省钱，
  344 vs 357；`off` 是关思考）；
- 不丢 CORE_CONSTRAINTS 与用户原始指令；
- 不把「模型需要据此决策的内容」替换成摘要。
- 有损压缩必须可逆（落盘 + 指针），且指针可读。

---

## 附加约束（不是红线，但会吃掉收益）

| 约束 | 原因 |
|---|---|
| **字节稳定** | 压缩输出必须是内容的纯函数。同一历史永远产出同一字节；否则前缀缓存失效，0.02 元/M 变 1 元/M（50×） |
| **无额外 read** | 落盘收据若导致模型多读一次，一次 read = 一次完整请求（≈¥0.003），会吃掉收益 |
| **本机可复现** | 不能只在线上验证。线上验证的代价是一次断轮 + 一次重启（重启还破缓存，≈¥0.09） |

---

## 判定流程（每次改动照此走）

1. 该改动碰不碰 `role: 'assistant'`？碰 → 只能整条保留/整条消失 → 必须过 RL-1 校验。
2. 该改动改不改 `arguments` / 假块 / 指针位置？改 → 违反 RL-2，停。
3. 该改动删不删最近窗口内的 thinking？删 → 违反 RL-3，停。
4. 该改动降不降 effort、丢不丢约束？降/丢 → 违反 RL-4，停。
5. 输出是不是内容的纯函数？否 → 破缓存，停。
6. 能不能在本机先用真实消息表回放验证？不能 → 不许上线。
