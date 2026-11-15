# tools

全部是**离线的只读诊断脚本**：读 `debug.log`、会话转录或已落盘的账本，不参与插件运行时，
也不联网。`node tools/<name>.mjs [参数]` 直接跑。

## 回归闸门（改完代码必须跑，失败即不许发版）

| 脚本 | 守什么 |
|---|---|
| `panel-check.mjs` | 面板金额必须能由「三个 token 分量 × 官方单价」逐项复算 |
| `scope-check.mjs` | 每个会话只能看到本工作区的数据；日期集合与金额逐项对齐；未知会话必须为空 |
| `day-check.mjs` | 按日分账：日志解析、补齐不覆盖、跨重启持久化、非法日期忽略 |
| `route-harness.mjs` | host 路由契约：绝对路径挂载、`{ok:true}` envelope、真实账本经路由可返回、dispose 干净 |
| `route-order-check.mjs` | 客户端 `main` / `sidebar.panellist` 的注册顺序与 id/key 对齐 |
| `status-shape-check.mjs` | `costkiller_status` 的返回必须逐层（含嵌套对象）满足它自己声明的 schema |
| `replay-verify.mjs` | 用真实会话转录离线重放压缩，验证「三档改写不破坏请求合法性」 |
| `prefix-replay.mjs` | 前缀稳定性回放 |
| `cache-opportunity.mjs` | 缓存可复用窗口与机会成本 |

## 计费与账本（对账用）

`bill-truth.mjs`（provider usage 逐条对账）、`bill-all.mjs`、`usage-truth.mjs`、
`usage-shape.mjs`、`billing-report.mjs`、`epoch-report.mjs`、`miss-quality.mjs`、
`effort-effect.mjs`、`effort-join.mjs`、`roundtrip.mjs`。

## 压缩效果测量

`payload-forecast.mjs`、`prefix-stability.mjs`、`spill-forecast.mjs`、`evict-forecast.mjs`、
`composition.mjs`、`context-composition.mjs`、`sent-composition.mjs`、`dup-scan.mjs`、
`context-budget.mjs`、`ceiling.mjs`、`assistant-split.mjs`、`system-size.mjs`、
`event-sizes.mjs`、`request-budget.mjs`、`header-shape.mjs`。

## 会话与故障取证

`session-decode.mjs`（解码 `.zstd` 会话转录）、`probe-session.mjs`、`verify-live.mjs`、
`fail-probe.mjs`。

> 这些脚本读的都是本机真实数据，输出里可能含路径与 token 数；不要贴到公开 issue。
