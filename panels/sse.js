// Server-sent-events fan-out for the panel snapshot.
//
// DSH's own Web plugins stream this way (dsh-client-hmr serves
// `text/event-stream`), and the webserver deliberately leaves SSE responses
// uncompressed, so this is an inexpensive channel: one long-lived response per
// page, a coalesced frame per change window, and a heartbeat that also detects
// half-open sockets.
//
// Two rules keep it from becoming a liability on a tiny pet widget:
//   - a hard cap on concurrent clients; the extra ones are refused, not queued;
//   - a slow client is skipped for that frame instead of buffering without
//     bound. The client-side fallback re-fetches the snapshot on reconnect, so a
//     skipped frame costs nothing.

const MAX_BUFFERED_BYTES = 256 * 1024

export class SseChannel {
  /**
   * @param {object} [options]
   * @param {number} [options.maxClients]
   * @param {number} [options.heartbeatMs]
   * @param {(level: string, message: string, detail?: object) => void} [options.log]
   */
  constructor(options = {}) {
    this.maxClients = Number.isFinite(options.maxClients) ? options.maxClients : 16
    this.heartbeatMs = Number.isFinite(options.heartbeatMs) ? options.heartbeatMs : 20_000
    this.log = typeof options.log === 'function' ? options.log : () => {}
    /** @type {Set<{res: import('node:http').ServerResponse, id: number}>} */
    this.clients = new Set()
    this.nextId = 1
    this.heartbeat = setInterval(() => this.ping(), this.heartbeatMs)
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref()
    this.disposed = false
  }

  get size() {
    return this.clients.size
  }

  /**
   * Attach one SSE response. Sends the retry hint and an initial snapshot so a
   * reconnecting page is correct without a second request.
   *
   * @returns {boolean} false when the cap was reached
   */
  add(req, res, snapshot) {
    if (this.disposed) return false
    if (this.clients.size >= this.maxClients) {
      this.log('warn', 'too many panel event subscribers; refusing one', { limit: this.maxClients })
      return false
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    if (typeof res.flushHeaders === 'function') res.flushHeaders()

    const entry = { res, id: this.nextId++ }
    this.clients.add(entry)

    const cleanup = () => {
      this.clients.delete(entry)
    }
    req.on('close', cleanup)
    req.on('error', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)

    this.writeRaw(res, 'retry: 5000\n\n')
    this.writeEvent(res, 'snapshot', snapshot)
    return true
  }

  writeRaw(res, text) {
    if (res.writableEnded || res.destroyed) return false
    try {
      if (typeof res.writableLength === 'number' && res.writableLength > MAX_BUFFERED_BYTES) return false
      res.write(text)
      return true
    } catch (err) {
      return false
    }
  }

  writeEvent(res, event, payload) {
    let data
    try {
      data = JSON.stringify(payload)
    } catch (err) {
      return false
    }
    return this.writeRaw(res, 'event: ' + event + '\ndata: ' + data + '\n\n')
  }

  /** Broadcast a frame to every subscriber; returns how many accepted it. */
  broadcast(snapshot, reason = 'change') {
    if (this.clients.size === 0) return 0
    let delivered = 0
    for (const entry of [...this.clients]) {
      if (entry.res.writableEnded || entry.res.destroyed) {
        this.clients.delete(entry)
        continue
      }
      const ok = this.writeEvent(entry.res, 'panels', { reason, ...snapshot })
      if (ok) delivered++
      else this.clients.delete(entry)
    }
    return delivered
  }

  ping() {
    if (this.clients.size === 0) return
    for (const entry of [...this.clients]) {
      if (!this.writeRaw(entry.res, ': ping\n\n')) this.clients.delete(entry)
    }
  }

  closeAll() {
    for (const entry of [...this.clients]) {
      try {
        entry.res.end()
      } catch (err) {}
    }
    this.clients.clear()
  }

  dispose() {
    this.disposed = true
    clearInterval(this.heartbeat)
    this.closeAll()
  }
}
