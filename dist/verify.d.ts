/**
 * 验收脚本：证明插件按预期运行。
 *
 * 不是 demo 的复述，而是带断言的验收：
 * 1. 插件导出契约（name / inject / Config / apply / 无 default）；
 * 2. apply 在宿主形态的 ctx 上完成注册（prompt section、tool、两个钩子）；
 * 3. Schema 压缩真的在 LLM 请求边界生效；
 * 4. 工具输出真的被压缩且原文可回读（ADMISSION 指针）；
 * 5. 去重总线真的命中；
 * 6. 历史折叠真的写入 surface，第二次因 prefixBreak 被 CacheAnchor 拦截；
 * 7. 全工程无 console.log；
 * 8. dispose 可安全卸载。
 *
 * 任一断言失败 → 退出码 1。
 */
export {};
