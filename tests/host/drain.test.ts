import { createServer, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { drainable } from '../../src/host/drain.js'

async function start(handler: RequestListener) {
  const server = createServer(handler)
  const drain = drainable(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  return { server, drain, url }
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
      let running = true
      let draining = false
      const loops = Array.from({ length: 8 }, async () => {
        while (running) {
          try {
            const res = await fetch(url)
            await res.text()
            if (res.status === 200) ok++
            else failures.push(`status ${res.status}`)
          } catch (e) {
            const code = (e as { cause?: { code?: string } }).cause?.code
            // Once the server stops accepting, a new connection is refused; under `serve` it goes to the new worker.
            if (!(draining && code === 'ECONNREFUSED')) failures.push(String(code ?? e))
          }
          await new Promise((done) => setTimeout(done, Math.random() * 3))
        }
      })
      await new Promise((done) => setTimeout(done, 30 + Math.random() * 20))
      draining = true
      await drain()
      running = false
      await Promise.all(loops)
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
})
