import { Agent, createServer, request, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { drainable } from '../../src/host/drain.js'

async function start(handler: RequestListener, graceMs?: number) {
  const server = createServer(handler)
  // Fastify's default, which it also tells clients in Keep-Alive: they keep an idle connection for over a minute.
  server.keepAliveTimeout = 72_000
  const drain = drainable(server, graceMs)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  return { server, drain, url }
}

/** A GET through `agent`, telling whether it went down a reused keep-alive socket, which `fetch` can't. */
function get(url: string, agent: Agent) {
  return new Promise<{ status: number; reused: boolean }>((resolve, reject) => {
    const req = request(url, { agent }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0, reused: req.reusedSocket }))
    })
    req.on('error', (error) => reject(Object.assign(error, { reused: req.reusedSocket })))
    req.end()
  })
}

describe('drainable', () => {
  // Clients that keep reusing their keep-alive sockets while the server shuts down, as visitors (or a proxy) do while
  // `inlaycms serve` swaps releases. Closing the server outright resets a request already on its way down an idle
  // socket, about once in a few thousand requests; draining must never.
  it('shuts a server down without resetting a request on a reused keep-alive socket', async () => {
    let ok = 0
    const failures: string[] = []
    for (let round = 0; round < 30; round++) {
      const { server, drain, url } = await start((_req, res) => res.end('ok'))
      const agent = new Agent({ keepAlive: true })
      let running = true
      let draining = false
      const loops = Array.from({ length: 8 }, async () => {
        while (running) {
          try {
            const res = await get(url, agent)
            if (res.status === 200) ok++
            else failures.push(`status ${res.status}`)
          } catch (e) {
            const { code, reused } = e as { code?: string; reused: boolean }
            // Once the server stops accepting, a new connection is refused, or reset if it was still waiting to be
            // accepted when the server closed (a slow event loop). Under `serve` the cluster primary owns the
            // listening socket and hands both to the new worker; only a reused keep-alive socket is drain's to keep.
            if (!(draining && !reused)) failures.push(`${code ?? e}${reused ? ' on a reused socket' : ''}`)
          }
          await new Promise((done) => setTimeout(done, Math.random() * 3))
        }
      })
      await new Promise((done) => setTimeout(done, 30 + Math.random() * 20))
      draining = true
      await drain()
      running = false
      await Promise.all(loops)
      agent.destroy()
      server.closeAllConnections()
    }
    expect(ok).toBeGreaterThan(0)
    expect(failures).toEqual([])
  }, 30_000)

  it('answers a request already in flight with Connection: close, then closes', async () => {
    const { server, drain, url } = await start((_req, res) => setTimeout(() => res.end('slow'), 100))
    const pending = fetch(url)
    await new Promise((done) => setTimeout(done, 20))
    const drained = drain()
    const res = await pending
    expect(await res.text()).toBe('slow')
    expect(res.headers.get('connection')).toBe('close')
    await drained
    expect(server.listening).toBe(false)
  })

  it('closes a connection still idle once the grace period is over', async () => {
    const { server, drain, url } = await start((_req, res) => res.end('ok'), 200)
    expect(await (await fetch(url)).text()).toBe('ok')
    const started = Date.now()
    await drain()
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(server.listening).toBe(false)
  })
})
