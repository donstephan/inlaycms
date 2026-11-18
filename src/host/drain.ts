import type { Server, ServerResponse } from 'node:http'
import { Server as NetServer } from 'node:net'

/** How long a draining worker keeps its idle keep-alive connections open for a client's next request. */
export const DRAIN_GRACE_MS = 2_000

/**
 * Lets a worker of `inlaycms serve` stop without dropping a visitor's request. `server.close()` also closes every
 * idle keep-alive socket at once, and a client that was just then sending its next request down one gets
 * ECONNRESET. The returned `drain` instead stops accepting connections (in a cluster worker, the primary hands new
 * ones to the other workers) and answers every request on the sockets still open with `Connection: close`. Clients
 * may keep an idle connection for over a minute (Fastify tells them 72 seconds), so the ones still idle after
 * `graceMs` are closed then; it resolves once no connection is left. Call it before the server starts listening.
 */
export function drainable(server: Server, graceMs = DRAIN_GRACE_MS): () => Promise<void> {
  let draining = false
  const open = new Set<ServerResponse>()
  server.prependListener('request', (_req, res: ServerResponse) => {
    if (draining) return void res.setHeader('Connection', 'close')
    open.add(res)
    res.on('close', () => open.delete(res))
  })
  return () => {
    draining = true
    for (const res of open) if (!res.headersSent) res.setHeader('Connection', 'close')
    open.clear()
    const timer = setTimeout(() => server.closeIdleConnections(), graceMs)
    // `net.Server#close`, not `http.Server#close`, which closes idle sockets first.
    return new Promise<void>((done) =>
      NetServer.prototype.close.call(server, () => {
        clearTimeout(timer)
        done()
      }),
    )
  }
}
