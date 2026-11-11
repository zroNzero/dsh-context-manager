/**
 * 统一日志出口。
 * 红线：全工程禁止 console.log；一切关键状态、缓存拦截、净收益决策都经此处
 * 追加写入 ./debug.log（JSON Lines，便于机器检索）。
 *
 * 生产保护：日志超过 MAX_LOG_BYTES 时轮转为 debug.log.1（只保留一代），
 * 避免长期运行把磁盘写满；轮转失败不影响主链路。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/**
 * 真实的 debug.log 路径。宿主进程的 cwd 不一定是工作区（桌面端是 profile 根目录），
 * 所以必须把这个路径暴露出去，否则审计的人会去看工作区里那份只有测试噪音的日志。
 */
export declare const LOG_FILE_PATH: string;
export declare function logEvent(level: LogLevel, event: string, detail?: Record<string, unknown>): void;
