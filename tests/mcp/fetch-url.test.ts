import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fetchRemoteFile, isPublicAddress } from '../../src/adapters/mcp/fetch-url.js'
import { InlayError } from '../../src/core/errors.js'
import type { MessageId } from '../../src/core/messages/index.js'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})

/** A server on 127.0.0.1 (never any other address), and its origin. */
async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const allowAll = () => true

/** The message id `promise` rejects with, as an `InlayError`. */
async function failure(promise: Promise<unknown>): Promise<MessageId> {
  try {
    await promise
  } catch (e) {
    expect(e).toBeInstanceOf(InlayError)
    return (e as InlayError).messageId
  }
  throw new Error('expected a failure')
}

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    'fd00::1',
    'fe80::1',
    '224.0.0.1',
    'ff02::1',
    'not an address',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it.each(['93.184.216.34', '2606:4700::1111', '::ffff:93.184.216.34'])('allows %s', (address) => {
    expect(isPublicAddress(address)).toBe(true)
  })
})

describe('fetchRemoteFile', () => {
  it('refuses a server on 127.0.0.1 by default', async () => {
    let hit = false
    const origin = await serve((_req, res) => {
      hit = true
      res.end('secret')
    })
    expect(await failure(fetchRemoteFile(`${origin}/a.txt`, { maxBytes: 100 }))).toBe('error.fetchBlocked')
    expect(hit).toBe(false)
  })

  it('refuses a host name that resolves to a local address, without connecting', async () => {
    let hit = false
    const origin = await serve((_req, res) => {
      hit = true
      res.end('secret')
    })
    const url = origin.replace('127.0.0.1', 'localhost')
    expect(await failure(fetchRemoteFile(`${url}/a.txt`, { maxBytes: 100 }))).toBe('error.fetchBlocked')
    expect(hit).toBe(false)
  })

  it.each(['http://[::1]/', 'http://[::ffff:10.0.0.1]/', 'http://169.254.169.254/latest/meta-data', 'http://2130706433/'])(
    'refuses the literal address in %s',
    async (url) => {
      expect(await failure(fetchRemoteFile(url, { maxBytes: 100 }))).toBe('error.fetchBlocked')
    },
  )

  it('gets the file and its name from Content-Disposition when the address is allowed', async () => {
    const origin = await serve((_req, res) => {
      res.setHeader('content-disposition', 'attachment; filename="photo one.jpg"')
      res.end('hello')
    })
    const file = await fetchRemoteFile(`${origin}/download?id=1`, { maxBytes: 100, isAllowed: allowAll })
    expect(Buffer.from(file.data).toString()).toBe('hello')
    expect(file.filename).toBe('photo one.jpg')
  })

  it('connects through a host name once every address it resolves to is allowed', async () => {
    const seen: string[] = []
    const origin = await serve((_req, res) => res.end('by name'))
    const url = `${origin.replace('127.0.0.1', 'localhost')}/a.txt`
    const file = await fetchRemoteFile(url, { maxBytes: 100, isAllowed: (address) => (seen.push(address), true) })
    expect(Buffer.from(file.data).toString()).toBe('by name')
    expect(seen).toContain('127.0.0.1')
  })

  it('names the file after the last path segment without Content-Disposition', async () => {
    const origin = await serve((_req, res) => res.end('hello'))
    const file = await fetchRemoteFile(`${origin}/images/sunset%20beach.png?x=1`, { maxBytes: 100, isAllowed: allowAll })
    expect(file.filename).toBe('sunset beach.png')
  })

  it('follows a redirect to an allowed address', async () => {
    const target = await serve((_req, res) => res.end('moved'))
    const origin = await serve((_req, res) => {
      res.writeHead(302, { location: `${target}/final.txt` }).end()
    })
    const file = await fetchRemoteFile(`${origin}/start`, { maxBytes: 100, isAllowed: allowAll })
    expect(Buffer.from(file.data).toString()).toBe('moved')
    expect(file.filename).toBe('final.txt')
  })

  it('refuses a redirect to a disallowed address', async () => {
    let hit = false
    const inside = await serve((_req, res) => {
      hit = true
      res.end('secret')
    })
    const origin = await serve((_req, res) => {
      res.writeHead(302, { location: `${inside.replace('127.0.0.1', '[::1]')}/secret` }).end()
    })
    const onlyFirstHop = (address: string) => address === '127.0.0.1'
    expect(await failure(fetchRemoteFile(`${origin}/start`, { maxBytes: 100, isAllowed: onlyFirstHop }))).toBe(
      'error.fetchBlocked',
    )
    expect(hit).toBe(false)
  })

  it('gives up after 3 redirects', async () => {
    const origin = await serve((req, res) => {
      const n = Number(req.url?.slice(1) ?? 0)
      res.writeHead(302, { location: `/${n + 1}` }).end()
    })
    expect(await failure(fetchRemoteFile(`${origin}/0`, { maxBytes: 100, isAllowed: allowAll }))).toBe('error.fetchFailed')
  })

  it('refuses a body larger than maxBytes, declared or not', async () => {
    const declared = await serve((_req, res) => res.end('x'.repeat(11)))
    expect(await failure(fetchRemoteFile(declared, { maxBytes: 10, isAllowed: allowAll }))).toBe('error.fetchTooLarge')
    const chunked = await serve((_req, res) => {
      res.write('x'.repeat(6))
      res.end('x'.repeat(5))
    })
    expect(await failure(fetchRemoteFile(chunked, { maxBytes: 10, isAllowed: allowAll }))).toBe('error.fetchTooLarge')
    const exact = await fetchRemoteFile(chunked, { maxBytes: 11, isAllowed: allowAll })
    expect(exact.data.length).toBe(11)
  })

  it.each(['file:///etc/passwd', 'ftp://example.com/a.jpg', 'not a url'])('refuses %s', async (url) => {
    expect(await failure(fetchRemoteFile(url, { maxBytes: 100 }))).toBe('error.fetchScheme')
  })

  it('refuses a redirect to another scheme', async () => {
    const origin = await serve((_req, res) => res.writeHead(302, { location: 'file:///etc/passwd' }).end())
    expect(await failure(fetchRemoteFile(origin, { maxBytes: 100, isAllowed: allowAll }))).toBe('error.fetchScheme')
  })

  it('fails on an error status', async () => {
    const origin = await serve((_req, res) => res.writeHead(404).end('nope'))
    expect(await failure(fetchRemoteFile(origin, { maxBytes: 100, isAllowed: allowAll }))).toBe('error.fetchFailed')
  })

  it('times out on a server that never answers', async () => {
    const origin = await serve(() => {})
    const started = Date.now()
    expect(await failure(fetchRemoteFile(origin, { maxBytes: 100, timeoutMs: 200, isAllowed: allowAll }))).toBe(
      'error.fetchTimeout',
    )
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('times out on a body that never ends', async () => {
    const origin = await serve((_req, res) => res.write('start'))
    expect(await failure(fetchRemoteFile(origin, { maxBytes: 100, timeoutMs: 200, isAllowed: allowAll }))).toBe(
      'error.fetchTimeout',
    )
  })
})
