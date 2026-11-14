// 面板行的入口。DSH 按 `dsh-context-manager/panels` 解析到这个目录的 index.js。
//
// 故意不给根 package.json 写 `exports` 白名单：DSH 会用
// `dsh-context-manager/dist/index.js` 这类深层路径导入入口，一旦声明了 exports
// 而没放行这些路径，Node 抛 ERR_PACKAGE_PATH_NOT_EXPORTED，整个插件拒绝加载、
// DSH 起不来（实测就是这次的启动崩溃）。
export { name, inject, apply, PANEL_CLIENT_PATH, INDEX_ROW_TEXT } from './plugin.js'
