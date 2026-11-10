/**
 * 统一日志出口。
 * 红线：全工程禁止 console.log；一切关键状态、缓存拦截、净收益决策都经此处
 * 追加写入 ./debug.log（JSON Lines，便于机器检索）。
 *
 * 生产保护：日志超过 MAX_LOG_BYTES 时轮转为 debug.log.1（只保留一代），
 * 避免长期运行把磁盘写满；轮转失败不影响主链路。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export declare function logEvent(level: LogLevel, event: string, detail?: Record<string, unknown>): void;
