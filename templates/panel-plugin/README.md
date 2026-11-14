# DSH 面板插件骨架（左侧栏 + 独立页面 + 会话标签页）

把这四个约定抄对，任何插件都能拥有「左侧栏条目 + 独立页面 + 会话内标签页」。

```
templates/panel-plugin/
├── package.json.template      # 清单：exports["./client"] + dsh.client
├── cordis.patch.yml           # 让 profile 加载本包
├── client.js                  # 客户端半：单文件经典脚本（可运行，改 3 处即可用）
├── src/host-route.ts          # host 半：注册只读 JSON 路由
└── tools/check-slots.mjs      # 自检：id/key 对齐、注册顺序
```

## 快速开始

```bash
mkdir my-plugin && cd my-plugin
cp -r <此目录>/* .
# 全局替换 my-plugin → 你的包名
# 替换 PANEL_TITLE / ROUTE / SummaryBody 里的取数与渲染
```

然后：

```bash
npm run build            # 若有 tsc；纯 JS 可跳过
node tools/check-slots.mjs
```

把包 link 进 profile（`dependencies` 用 `link:` 或安装），并确保 `dsh.profile.bundles`
里有你的包名，**重启 DSH**。

## 四个约定

### 1. 客户端必须是「经典脚本」，不是 ES 模块

DSH 通过 `window.__ModuleLoader__` 加载 UI 半。文件必须：

- 调 `window.__ModuleLoader__.load({ id, factory })` 自注册；
- `id` 等于 `package.json` 的 `name`；
- `factory` 末尾 `return module.exports`；
- **单文件**，不能有相对路径 `require`（只有 `react` 等平台模块能 resolve）；
- 不能有顶层 `import` / `export`。

```js
window.__ModuleLoader__.load({
  id: 'my-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const module = { exports: {} }
    module.exports = { name: 'my-plugin', inject: ['slots'], apply }
    return module.exports
  },
})
```

`apply(ctx)` 里所有注册都要包在 `ctx.effect(...)` / `ctx.slots.inject(...)` 中，
否则插件重载会留下幽灵条目。

### 2. package.json 三处声明

```json
{
  "name": "my-plugin",
  "main": "dist/index.js",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./client": "./client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-sidebar",
        "@deepseek-ai/dsh-client-ui-conversation"
      ]
    }
  }
}
```

`files` 别忘了加 `client.js`。`dsh.client.inject` 只决定**加载顺序**（保证 slot 声明方已就绪），
不是代码 import —— 代码里只能 `require('react')`。

### 3. 左侧栏 + 独立页面：两处 slot

```js
const PANEL_ID = 'my-plugin'   // 必须同时是 main 的 key 和 sidebarl 的 id
const PANEL_ORDER = 40

function apply(ctx) {
  // A. 独立页面：main 是 keyed slot，只认 key
  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: PANEL_ID },
    props => h(Page, props),
  ))

  // B. 左侧栏条目：点击由 shell 转成 selectPanel(id)
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER,
      label: () => '我的面板' },
    props => h(Icon, { size: props?.size }),
  ))
}
```

- `main` 只写 `key`，**不要**写 `id` / `order`（它是 keyed slot，scope root）。
- `sidebar.panellist` 用 `id` + `order` + `label`。
- **`sidebar.panellist.id` 必须等于 `main.key`** —— 否则点击切不过去（表现为点了没反应）。
- 注册顺序：先 `main` 再 `sidebar.panellist`。
- `main` 页面**收不到** session / close / api 等 props（只有 `conversation` key 绑定会话），
  数据要自己 `fetch`。

### 4. 数据：客户端相对地址，host 绝对路径

```js
// 客户端
fetch('api/my-plugin/summary', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: '{}' })
```

```ts
// host（见 src/host-route.ts）
connection.fetch.register({
  path: '/api/my-plugin/summary',   // ← 必须带前导斜杠
  methods: ['POST'],
  requestBody: 'buffered',
  fetch: () => jsonResponse({ ok: true, ... }),
})
```

两个必踩的坑：

| 坑 | 现象 | 正确做法 |
|---|---|---|
| host 路径少了 `/` | 浏览器 404 | host 用绝对 `/api/...`，客户端用相对 `api/...` |
| 把 `ctx.inject` 回调参数当服务 | `register is not a function` | 回调收到的是 ctx，要 `carrier.get('connection')` |

## 会话内标签页（conversation.view）

与「对话 / 上下文 / 编队」并列的标签，注册到 `conversation.view`：

```js
ctx.slots.inject('conversation.view', () => ctx.slots.register(
  { name: 'conversation.view', id: 'my-tab', order: 40,
    label: () => '我的标签' },     // label 可传字符串或函数
  props => h(Tab, props),
))
```

slot 契约（live inspect 实测）：

| 项 | 值 |
|---|---|
| kind | `list` |
| scope | `session` |
| 注册字段 | `id`（必填）、`order`（可选）、`label`（可选，`string \| () => string`） |
| 自带占用者 | `WC/chat`(0)、`WC/trajectory`(10)、`dsh-context/context`(20)、`dsh-context/fleet`(30) |

**要点**：

1. `id` 用自己的名字 —— 新 id 会**并列新增**一格；复用已占用的 id（如 `chat`）
   会**进入那一格并替换**它（`replaceRisk: none` 但会 shadow），别误用。
2. `order` 建议留间隔（10/20/30/40），方便别人插空。
3. `label` 传**函数**，切换语言时会被重新求值，无需重新注册。
4. 标签页**不会被告知「自己是否可见」** —— 可见性由 shell 管，不要自己判断。
   要按可见性省开销，只能靠 `host === 'sidebar'` 时读 `useTabInfo`（仅侧栏视图有）。
5. props 里可用 `standardProps`（按需取用）：`sessionId`、`useChat`、`useProjection`、
   `useConversation`、`useSessions`、`useWorkspaces`、`useSession`、`useInput`、`inputActions`、
   `useAccess`、`useTrajectory` 等；ownerProps 提供 `openView` / `viewRequest` /
   `inspectCall` / `completeViewRequest`。

> 想让标签页和左侧栏面板**共用同一份 UI**：把同一个组件同时注册到 `main`（key）和
> `conversation.view`（id）即可；注意两条路径的 props 不同，组件要用可选链兜住。

## 样式

没有 CSS-in-JS 机制。在 `apply` 里注入一次 `<style>`，并让 `ctx.effect` 负责卸载：

```js
const CSS_ID = 'my-plugin-css'
function injectCss() {
  if (document.getElementById(CSS_ID)) return () => {}
  const tag = document.createElement('style')
  tag.id = CSS_ID
  tag.textContent = '.my-root{display:flex;gap:8px}'
  document.head.appendChild(tag)
  return () => tag.remove()
}
ctx.effect(injectCss, 'my-plugin: styles')
```

## 生效方式

| 改动 | 需要 |
|---|---|
| `client.js`、`src/`（host） | **重启 DSH** |
| 只改样式但仍走 `client.js` | 同上（打包在启动时加载） |

## 自检清单

```bash
node tools/check-slots.mjs
```

校验四件事：

1. `PANEL_ID === main.key === sidebar.panellist.id`
2. `main` 注册里没有 `id` / `order`
3. 文件里有 `__ModuleLoader__` 且末尾 `return module.exports`
4. 没有任何顶层 `import` / `export` 语句

host 侧另外确认：`panel.route.ready`（成功）或 `panel.route.unavailable`（失败）
一定出现在日志里 —— 静默失败最难查。
