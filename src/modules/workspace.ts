/**
 * WorkspaceRef —— 会话工作区的稳定标识。
 *
 * 消费端要按工作区分账，且「同一工作区在不同会话 / 不同进程重启后必须是同一个 key」。
 * 因此 id 取规范化绝对路径的短 hash：
 * - 盘符小写、分隔符统一为反斜杠、去掉尾部斜杠；
 * - hash 输入再做小写化，避免大小写差异造成重复账本。
 */

import { createHash } from 'node:crypto'
import path from 'node:path'

export interface WorkspaceRef {
  id: string
  /** 规范化后的绝对路径（展示用）。 */
  path: string
  /** 末段短名（展示用）。 */
  label: string
}

const UNKNOWN = '(unknown)'

export function normalizeWorkspacePath(input: string): string {
  if (typeof input !== 'string') return ''
  let value = input.trim()
  if (value.length === 0) return ''
  value = value.replace(/\//g, '\\')
  value = value.replace(/^([A-Za-z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`)
  value = value.replace(/\\+$/, '')
  return value
}

export function workspaceRef(input: string | undefined | null): WorkspaceRef {
  const normalized = normalizeWorkspacePath(String(input ?? '')) || UNKNOWN
  const id = createHash('sha256').update(normalized.toLowerCase()).digest('hex').slice(0, 12)
  const segments = normalized.split('\\').filter((part) => part.length > 0)
  const label = segments.length > 0 ? segments[segments.length - 1]! : normalized
  return { id, path: normalized, label }
}

/** 从会话/代理对象上尽量解析工作目录；找不到返回 null（由调用方决定 fallback）。 */
export function resolveSessionWorkspace(session: any, agent?: any): string | null {
  const candidates: unknown[] = [
    session?.cwd,
    session?.header?.cwd,
    session?.workspace,
    session?.workspacePath,
    session?.projectRoot,
    session?.options?.cwd,
    agent?.options?.cwd,
    agent?.loopCtx?.options?.cwd,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate
  }
  return null
}

/** 供测试与调用方使用：由原始路径直接得到 ref。 */
export function workspaceRefFromSession(session: any, agent?: any): WorkspaceRef | null {
  const cwd = resolveSessionWorkspace(session, agent)
  return cwd === null ? null : workspaceRef(cwd)
}

/** 仅用于展示：把绝对路径截成最后两段，避免面板过宽。 */
export function shortWorkspaceLabel(work: WorkspaceRef): string {
  if (work.label && work.label !== UNKNOWN) return work.label
  return path.basename(work.path) || work.path
}
