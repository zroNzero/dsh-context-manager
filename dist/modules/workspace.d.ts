/**
 * WorkspaceRef —— 会话工作区的稳定标识。
 *
 * 消费端要按工作区分账，且「同一工作区在不同会话 / 不同进程重启后必须是同一个 key」。
 * 因此 id 取规范化绝对路径的短 hash：
 * - 盘符小写、分隔符统一为反斜杠、去掉尾部斜杠；
 * - hash 输入再做小写化，避免大小写差异造成重复账本。
 */
export interface WorkspaceRef {
    id: string;
    /** 规范化后的绝对路径（展示用）。 */
    path: string;
    /** 末段短名（展示用）。 */
    label: string;
}
export declare function normalizeWorkspacePath(input: string): string;
export declare function workspaceRef(input: string | undefined | null): WorkspaceRef;
/** 从会话/代理对象上尽量解析工作目录；找不到返回 null（由调用方决定 fallback）。 */
export declare function resolveSessionWorkspace(session: any, agent?: any): string | null;
/** 供测试与调用方使用：由原始路径直接得到 ref。 */
export declare function workspaceRefFromSession(session: any, agent?: any): WorkspaceRef | null;
/** 仅用于展示：把绝对路径截成最后两段，避免面板过宽。 */
export declare function shortWorkspaceLabel(work: WorkspaceRef): string;
