import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import Fastify, { type FastifyInstance } from 'fastify'
import { inlay } from '../../src/adapters/site/plugin.js'
import { passwordHasher } from '../../src/core/auth/auth.js'
import { createPreviewToken } from '../../src/core/preview.js'
import { defineSite } from '../../src/core/registry/define.js'
import { createUnlockToken } from '../../src/core/site-lock/token.js'
import { png } from '../fixtures/media.js'
import { webSite } from '../fixtures/web.js'
import { signIn } from '../helpers/admin.js'
import { appOptions, makeApp } from '../helpers/app.js'

const SECRET = 's'.repeat(32)
const PASSWORD = 'letmein123'
const INTRO = 'This site is private. Enter the password to continue.'

const open: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((a) => a.close()))
})

async function setup(opts: { publicPaths?: string[] } = {}) {
  const site = opts.publicPaths ? defineSite({ ...webSite, publicPaths: opts.publicPaths }) : webSite
  const made = await makeApp({ withOwner: true, site })
  open.push(made.app)
  const ran = { form: false }
  made.app.get('/site.css', async (_request, reply) => reply.type('text/css').send('body{color:red}'))
  made.app.post('/api/form', async () => {
    ran.form = true
    return { ok: true }
  })
  const image = (await made.core.addMedia({ data: await png(40, 20), filename: 'team.png' }, made.owner)).media
  const lock = async () => {
    await made.core.setSitePassword(PASSWORD, made.owner)
    await made.core.setSiteLock(true, made.owner)
  }
  return { ...made, ran, image, lock }
}

async function unlockCookie(password = PASSWORD): Promise<string> {
  return `inlay_unlock=${createUnlockToken(SECRET, await passwordHasher().hash(password), new Date())}`
}

function expectScreen(res: { statusCode: number; headers: Record<string, unknown>; body: string }) {
  expect(res.statusCode).toBe(401)
  expect(res.headers['content-type']).toMatch(/^text\/html/)
  expect(res.headers['cache-control']).toBe('no-store')
  expect(res.headers['x-robots-tag']).toBe('noindex')
  expect(res.body).toContain('example.com')
  expect(res.body).toContain(INTRO)
}

/** Real HTTP GETs, so request paths reach Fastify unnormalized (`inject` parses them as URLs). */
async function rawGetter(app: FastifyInstance) {
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  return (path: string) =>
    new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
      })
      req.on('error', reject)
      req.end()
    })
}

describe('site lock gate', () => {
  it('changes nothing while the lock is off', async () => {
    const { app } = await setup()
    const res = await app.inject('/')
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toMatch(/^public/)
    expect(res.headers['x-robots-tag']).toBeUndefined()
  })

  it('shows the password screen for pages, media, sitemap and developer routes', async () => {
    const { app, image, lock } = await setup()
    await lock()
    for (const url of ['/', '/about', `/media/${image.id}`, '/sitemap.xml', '/site.css', '/no-such-page']) {
      const res = await app.inject(url)
      expectScreen(res)
      expect(res.body).not.toContain('Welcome to Inlay')
      expect(res.body).not.toContain('About us')
      expect(res.body).not.toContain('<urlset')
      expect(res.body).not.toContain('color:red')
    }
  })

  it('keeps the next path', async () => {
    const { app, lock } = await setup()
    await lock()
    const res = await app.inject('/about?x=1&y="2"')
    expect(res.body).toContain('<input type="hidden" name="next" value="/about?x=1&amp;y=%222%22">')
    expect((await app.inject('/about?x=1')).body).toContain('<input type="hidden" name="next" value="/about?x=1">')
  })

  it('lets the admin, auth, MCP and preview paths through', async () => {
    const { app, lock } = await setup()
    await lock()
    expect((await app.inject('/admin/login')).statusCode).toBe(200)
    expect((await app.inject('/.well-known/oauth-protected-resource')).statusCode).not.toBe(401)
    const preview = await app.inject('/_inlay/preview?token=bad')
    expect(preview.statusCode).toBe(403)
    expect(preview.body).not.toContain(INTRO)
  })

  it('locks unknown paths under the exemptions', async () => {
    const { app, lock } = await setup({ publicPaths: ['/healthz'] })
    await lock()
    for (const url of ['/_inlay/nope', '/_inlay', '/.well-known/nope', '/mcp/nope', '/healthz', '/api/auth']) {
      const res = await app.inject(url)
      expectScreen(res)
      expect(res.body, url).not.toContain('<nav')
      expect(res.body, url).not.toContain('Page not found')
    }
  })

  it('serves robots.txt as disallow-all', async () => {
    const { app, lock } = await setup()
    await lock()
    const res = await app.inject('/robots.txt')
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('User-agent: *\nDisallow: /\n')
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('lets in a valid unlock cookie, privately', async () => {
    const { app, image, lock } = await setup()
    await lock()
    const cookie = await unlockCookie()
    const page = await app.inject({ url: '/', headers: { cookie } })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Welcome to Inlay')
    expect(page.headers['cache-control']).toMatch(/^private,/)
    expect(page.headers['x-robots-tag']).toBe('noindex')
    const media = await app.inject({ url: `/media/${image.id}`, headers: { cookie } })
    expect(media.statusCode).toBe(200)
    expect(media.headers['cache-control']).toBe('private, max-age=31536000, immutable')
  })

  it('keeps every let-through response private', async () => {
    const { app, core, owner, lock } = await setup()
    app.get('/hourly', async (_request, reply) => reply.header('cache-control', 'max-age=3600').send('ok'))
    app.get('/hourly-public', async (_request, reply) => reply.header('cache-control', 'max-age=3600, public').send('ok'))
    app.get('/plain', async () => 'ok')
    app.get('/secret', async (_request, reply) => reply.header('cache-control', 'no-store').send('ok'))
    await core.createRedirect({ from: '/old', to: '/about' }, owner)
    await lock()
    const cookie = await unlockCookie()
    const get = async (url: string) => (await app.inject({ url, headers: { cookie } })).headers['cache-control']
    expect(await get('/hourly')).toBe('private, max-age=3600')
    expect(await get('/hourly-public')).toBe('private, max-age=3600')
    expect(await get('/plain')).toBe('private, no-cache')
    expect(await get('/secret')).toBe('no-store')
    const redirect = await app.inject({ url: '/old', headers: { cookie } })
    expect(redirect.statusCode).toBe(301)
    expect(String(redirect.headers['cache-control'])).toMatch(/^private/)
  })

  it('refuses an unlock cookie after the password changes', async () => {
    const { app, core, owner, lock } = await setup()
    await lock()
    const cookie = await unlockCookie()
    expect((await app.inject({ url: '/', headers: { cookie } })).statusCode).toBe(200)
    await core.setSitePassword('another-pass', owner)
    expectScreen(await app.inject({ url: '/', headers: { cookie } }))
  })

  it('lets in signed-in admins and preview cookies', async () => {
    const { app, lock } = await setup()
    await lock()
    const editor = await signIn(app, 'editor@example.com')
    expect((await editor.get('/')).statusCode).toBe(200)
    const link = await app.inject(`/_inlay/preview?token=${createPreviewToken(SECRET, new Date())}`)
    const header = link.headers['set-cookie']
    const cookie = String(Array.isArray(header) ? header[0] : header).split(';')[0]!
    expect(cookie).toMatch(/^inlay_preview=/)
    expect((await app.inject({ url: '/', headers: { cookie } })).statusCode).toBe(200)
  })

  it("ignores a cookie that previews a staged release: that release's own preview answers it, not the live site", async () => {
    const { app, lock } = await setup()
    await lock()
    const cookie = `inlay_preview=${createPreviewToken(SECRET, new Date(), { release: 'rel-staged' })}`
    expectScreen(await app.inject({ url: '/', headers: { cookie } }))

    // The forced preview of that very release lets it through, as its proxy checked it.
    const preview = Fastify()
    open.push(preview)
    await preview.register(inlay, { ...(await appOptions({ site: webSite })), preview: 'forced', release: { id: 'rel-staged', name: 'Staged' } })
    await preview.inlay.core.setSitePassword(PASSWORD, { actor: { id: null, name: 'System', role: 'system' }, source: 'admin' })
    await preview.inlay.core.setSiteLock(true, { actor: { id: null, name: 'System', role: 'system' }, source: 'admin' })
    expect((await preview.inject({ url: '/', headers: { cookie } })).statusCode).toBe(200)
    const other = `inlay_preview=${createPreviewToken(SECRET, new Date(), { release: 'rel-other' })}`
    expectScreen(await preview.inject({ url: '/', headers: { cookie: other } }))
  })

  it('exempts publicPaths exactly', async () => {
    const { app, lock } = await setup({ publicPaths: ['/healthz'] })
    app.get('/healthz', async () => 'ok')
    await lock()
    expect((await app.inject('/healthz')).statusCode).toBe(200)
    expectScreen(await app.inject('/healthz/x'))
  })

  it('refuses publicPaths that are not paths', async () => {
    const fastify = Fastify()
    open.push(fastify)
    const site = defineSite({ ...webSite, publicPaths: ['healthz'] })
    await expect(fastify.register(inlay, await appOptions({ site }))).rejects.toMatchObject({
      code: 'definition',
      messageId: 'definition.publicPath',
    })
  })

  it('locks path tricks around the exemptions', async () => {
    const { app, image, lock } = await setup()
    await lock()
    const tricks = [`/admin/..%2Fmedia/${image.id}`, '/_inlay/../sitemap.xml', `//media/${image.id}`, '/adminx', `/_inlay/%2e%2e/media/${image.id}`]
    for (const url of tricks) {
      const res = await app.inject(url)
      expect(res.statusCode, url).toBe(401)
      expect(res.body, url).toContain(INTRO)
      expect(res.rawPayload.includes('PNG'), url).toBe(false)
      expect(res.body, url).not.toContain('<urlset')
    }
    const get = await rawGetter(app)
    for (const url of tricks) {
      const res = await get(url)
      expect(res.status, url).toBe(401)
      expect(res.body.toString(), url).toContain(INTRO)
      expect(res.body.includes('PNG'), url).toBe(false)
      expect(res.body.toString(), url).not.toContain('<urlset')
    }
  })

  it('never revalidates for a locked-out visitor', async () => {
    const { app, lock } = await setup()
    const first = await app.inject('/')
    const etag = String(first.headers.etag)
    expect((await app.inject({ url: '/', headers: { 'if-none-match': etag } })).statusCode).toBe(304)
    await lock()
    expectScreen(await app.inject({ url: '/', headers: { 'if-none-match': etag } }))
  })

  it('locks HEAD and POST too', async () => {
    const { app, ran, lock } = await setup()
    await lock()
    const head = await app.inject({ method: 'HEAD', url: '/' })
    expect(head.statusCode).toBe(401)
    expect(head.body).not.toContain('Welcome to Inlay')
    const form = await app.inject({ method: 'POST', url: '/api/form', payload: { a: 1 } })
    expectScreen(form)
    expect(ran.form).toBe(false)
  })

  it('does not serve a page cached while public', async () => {
    const { app, lock } = await setup()
    expect((await app.inject('/about')).headers['x-inlay-cache']).toBe('miss')
    expect((await app.inject('/about')).headers['x-inlay-cache']).toBe('hit')
    await lock()
    const res = await app.inject('/about')
    expectScreen(res)
    expect(res.headers['x-inlay-cache']).toBeUndefined()
    expect(res.body).not.toContain('About us')
  })
})
