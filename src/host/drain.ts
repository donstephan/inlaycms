import type { Server, ServerResponse } from 'node:http'
import { Server as NetServer } from 'node:net'

/**
 * Lets a worker of `inlaycms serve` stop without dropping a visitor's request. `server.close()` also closes every
 * idle keep-alive socket at once, and a client that was just then sending its next request down one gets
 * ECONNRESET. The returned `drain` instead stops accepting connections (in a cluster worker, the primary hands new
 * ones to the other workers), answers every request on the sockets still open with `Connection: close`, lets idle
 * sockets end at the keep-alive timeout the client was told about, and resolves once none is left.
 * Call it before the server starts listening.
 */
export function drainable(server: Server): () => Promise<void> {
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
    // `net.Server#close`, not `http.Server#close`, which closes idle sockets first.
    return new Promise<void>((done) => NetServer.prototype.close.call(server, () => done()))
  }
}
