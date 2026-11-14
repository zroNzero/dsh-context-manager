/**
 * 通用面板骨架 · host 半：注册一条只读 JSON 路由。
 *
 * 四条契约（都是实测踩出来的）：
 *   1. 宿主按**绝对路径**精确匹配 → 必须带前导斜杠 '/api/...'；
 *      客户端才用相对地址 'api/...'（浏览器补全同源）。
 *   2. ctx.inject(deps, cb) 的回调收到的是**载有该服务的 ctx**，不是服务本身，
 *      要再取一次 carrier.get('connection')。
 *   3. 返回值是 `() => Promise<void>`；卸载时必须吞掉 rejection，否则冒未处理拒绝。
 *   4. 面板是可选功能：connection 不存在 / 注册抛错都只记日志，绝不影响主链路。
 */

export const PANEL_ROUTE = 'api/my-plugin/summary'

export interface PanelRouteHost {
  get?: (name: string) => any
  inject?: (deps: string[], fn: (carrier: any) => unknown) => unknown
}

function jsonResponse(body: unknown): unknown {
  const text = JSON.stringify(body)
  const ResponseCtor = (globalThis as any).Response
  if (typeof ResponseCtor === 'function') {
    return new ResponseCtor(text, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }
  // 极老的宿主没有全局 Response；退化成最小可用形状。
  return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: text }
}

export function registerPanelRoute(
  host: PanelRouteHost,
  read: () => unknown,
  onError?: (message: string) => void,
  onMount?: (path: string) => void,
): () => void {
  let dispose: (() => void) | null = null

  /** 返回 null 表示这个 connection 形状不对，调用方应改用 inject 再试一次。 */
  const mount = (connection: any): (() => void) | null => {
    const registry = connection?.fetch
    if (registry === null || registry === undefined || typeof registry.register !== 'function') {
      return null
    }
    const path = PANEL_ROUTE.startsWith('/') ? PANEL_ROUTE : `/${PANEL_ROUTE}`
    const handle = registry.register({
      path,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: () => jsonResponse({ ok: true, ...(read() as object) }),
    })
    onMount?.(path)
    if (typeof handle === 'function') {
      return () => {
        try {
          const pending = (handle as () => unknown)()
          if (pending !== null && typeof (pending as any)?.then === 'function') {
            ;(pending as Promise<unknown>).then(undefined, () => {})
          }
        } catch {}
      }
    }
    return () => {
      try {
        handle?.dispose?.()
      } catch {}
    }
  }

  /** 回调参数是 ctx，不是服务。 */
  const serviceOf = (carrier: any): any =>
    carrier !== null && carrier !== undefined && typeof carrier.get === 'function'
      ? carrier.get('connection')
      : carrier

  try {
    const existing = typeof host.get === 'function' ? host.get('connection') : undefined
    if (existing !== null && existing !== undefined) {
      const mounted = mount(existing)
      if (mounted !== null) {
        dispose = mounted
        return () => dispose?.()
      }
    }
    if (typeof host.inject === 'function') {
      host.inject(['connection'], (carrier: any) => {
        const mounted = mount(serviceOf(carrier))
        if (mounted === null) onError?.('connection.fetch.register 不可用')
        else dispose = mounted
      })
      return () => dispose?.()
    }
    onError?.('connection 服务不可用')
  } catch (error) {
    onError?.(error instanceof Error ? error.message : String(error))
  }
  return () => {}
}
