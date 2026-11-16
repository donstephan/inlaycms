import { createHmac } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { inlay } from '../../src/adapters/site/plugin.js'
import { previewLink } from '../../src/adapters/site/preview.js'
import type { Core } from '../../src/core/core.js'
import { createPreviewToken, PREVIEW_TTL_MS, verifyPreviewToken } from '../../src/core/preview.js'
import type { Ctx, DocumentData } from '../../src/core/types.js'
import { appOptions } from '../helpers/app.js'

const secret = 'p'.repeat(32)
const rt = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const owner: Ctx = { actor: { id: 'user-owner', name: 'Olivia Owner', role: 'owner' }, source: 'admin' }

describe('preview tokens', () => {
  const now = new Date('2026-03-01T12:00:00.000Z')
  const at = (ms: number) => new Date(now.getTime() + ms)

  it('is valid until 24h after it was made', () => {
    const token = createPreviewToken(secret, now)
    expect(token).toMatch(/^v2\.[0-9a-z]+\.-\.[A-Za-z0-9_-]+$/)
    expect(verifyPreviewToken(secret, token, at(PREVIEW_TTL_MS - 1))).toEqual({ expiresAt: at(PREVIEW_TTL_MS), release: null })
    expect(verifyPreviewToken(secret, token, at(PREVIEW_TTL_MS + 1))).toBeNull()
  })

  it('names the release it previews, signed', () => {
    const token = createPreviewToken(secret, now, { release: 'rel-1' })
    expect(token).toMatch(/^v2\.[0-9a-z]+\.rel-1\.[A-Za-z0-9_-]+$/)
    expect(verifyPreviewToken(secret, token, now)).toEqual({ expiresAt: at(PREVIEW_TTL_MS), release: 'rel-1' })
    const [v, expiry, , sig] = token.split('.') as [string, string, string, string]
    expect(verifyPreviewToken(secret, `${v}.${expiry}.rel-2.${sig}`, now)).toBeNull()
    expect(verifyPreviewToken(secret, `${v}.${expiry}.-.${sig}`, now)).toBeNull()
    expect(() => createPreviewToken(secret, now, { release: '../x' })).toThrow()
  })

  it('still accepts a v1 token, as previewing the live site', () => {
    const payload = `v1.${(now.getTime() + 1000).toString(36)}`
    const token = `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`
    expect(verifyPreviewToken(secret, token, now)).toEqual({ expiresAt: at(1000), release: null })
  })

  it('rejects tampered, foreign and malformed tokens', () => {
    const token = createPreviewToken(secret, now)
    const [v, expiry, release, sig] = token.split('.') as [string, string, string, string]
    const flipped = `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`
    expect(verifyPreviewToken(secret, `${v}.${expiry}.${release}.${flipped}`, now)).toBeNull()
    expect(verifyPreviewToken(secret, `${v}.${(parseInt(expiry, 36) + 1000).toString(36)}.${release}.${sig}`, now)).toBeNull()
    expect(verifyPreviewToken(secret, `v1.${expiry}.${sig}`, now)).toBeNull()
    expect(verifyPreviewToken('q'.repeat(32), token, now)).toBeNull()
    expect(verifyPreviewToken(secret, 'abc', now)).toBeNull()
    expect(verifyPreviewToken(secret, '', now)).toBeNull()
  })
})

describe('preview mode', () => {
  const open: FastifyInstance[] = []
  afterEach(async () => {
    await Promise.all(open.splice(0).map((a) => a.close()))
  })

  /** An app whose clock ticks 1ms per call; `advance` jumps it forward. */
  async function setup(baseUrl = 'https://example.com') {
    let time = Date.parse('2026-01-01T00:00:00.000Z')
    const now = () => new Date(time++)
    const app = Fastify()
    open.push(app)
    await app.register(inlay, await appOptions({ secret, baseUrl, now }))
    return { app, core: app.inlay.core, advance: (ms: number) => void (time += ms) }
  }

  async function editHome(core: Core, change: (data: DocumentData) => void) {
    const home = await core.findSingleton('home', 'en')
    const view = await core.getDocument(home!.id)
    const data = structuredClone(view!.data)
    change(data)
    await core.saveDraft(view!.id, { baseRevisionId: view!.headRev, data }, owner)
  }

  async function seed(core: Core) {
    await core.createEntry('posts', { slug: 'draft-post', fields: { title: 'Draft post', date: '2026-02-01', body: rt('Soon') } }, owner)
    const quote = await core.createEntry('testimonials', { fields: { quote: 'Lovely', author: 'Ben' } }, owner)
    await editHome(core, (d) => {
      d.slots.hero!.data.headline = 'Unpublished headline'
      d.slots.quotes = { enabled: true, data: { items: [quote.groupId] } }
    })
  }

  async function openLink(app: FastifyInstance, path: string) {
    const url = new URL(app.inlay.previewUrl(path))
    return app.inject(`${url.pathname}${url.search}`)
  }

  const cookieOf = (res: { headers: Record<string, unknown> }) => {
    const header = res.headers['set-cookie']
    return String(Array.isArray(header) ? header[0] : header)
  }

  async function previewCookie(app: FastifyInstance): Promise<string> {
    const res = await openLink(app, '/')
    return cookieOf(res).split(';')[0]!
  }

  it('builds the preview link from baseUrl', async () => {
    const { app } = await setup()
    const url = new URL(app.inlay.previewUrl('/blog/draft-post'))
    expect(url.origin).toBe('https://example.com')
    expect(url.pathname).toBe('/_inlay/preview')
    expect(url.searchParams.get('path')).toBe('/blog/draft-post')
    expect(url.searchParams.get('token')).toMatch(/^v2\.[0-9a-z]+\.-\./)
    expect(new URL(app.inlay.previewUrl()).searchParams.get('path')).toBe('/')
  })

  it('sets the cookie and redirects to the path', async () => {
    const { app } = await setup()
    const res = await openLink(app, '/blog/draft-post')
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/blog/draft-post')
    const cookie = cookieOf(res)
    expect(cookie).toMatch(/^inlay_preview=v2\.[^;]+; /)
    expect(cookie).toContain('; Path=/')
    expect(cookie).toContain('; HttpOnly')
    expect(cookie).toContain('; SameSite=Lax')
    expect(cookie).toContain('; Max-Age=86400')
    expect(cookie).toContain('; Secure')
  })

  it('leaves out Secure on an http site', async () => {
    const { app } = await setup('http://localhost:3000')
    expect(cookieOf(await openLink(app, '/'))).not.toContain('Secure')
  })

  it('redirects to / for a path that is not a clean site path', async () => {
    const { app } = await setup()
    for (const path of ['//evil.com', 'https://evil.com', '/\\evil.com']) {
      const res = await openLink(app, path)
      expect(res.statusCode, path).toBe(302)
      expect(res.headers.location, path).toBe('/')
    }
    const token = createPreviewToken(secret, new Date('2026-01-01T00:00:00.000Z'))
    for (const path of ['//evil.com', 'https://evil.com', '/\\evil.com', '/%2F%2Fevil.com', '/about/', 'about']) {
      const res = await app.inject(`/_inlay/preview?token=${token}&path=${encodeURIComponent(path)}`)
      expect(res.statusCode, path).toBe(302)
      expect(res.headers.location, path).toBe('/')
    }
    expect((await app.inject(`/_inlay/preview?token=${token}`)).headers.location).toBe('/')
    const encoded = await app.inject(`/_inlay/preview?token=${token}&path=${encodeURIComponent('/caf%C3%A9')}`)
    expect(encoded.headers.location).toBe('/caf%C3%A9')
  })

  it('refuses an expired or bad token with a 403 and no cookie', async () => {
    const { app, advance } = await setup()
    const url = new URL(app.inlay.previewUrl('/'))
    advance(PREVIEW_TTL_MS + 1000)
    for (const target of [`${url.pathname}${url.search}`, '/_inlay/preview?token=abc&path=/', '/_inlay/preview?path=/']) {
      const res = await app.inject(target)
      expect(res.statusCode, target).toBe(403)
      expect(res.headers['set-cookie'], target).toBeUndefined()
      expect(res.body).toContain('<meta name="robots" content="noindex">')
      expect(res.body).toContain('Preview link expired')
    }
  })

  it('shows drafts with the cookie, never cached, with noindex and the banner', async () => {
    const { app, core } = await setup()
    await seed(core)
    const cookie = await previewCookie(app)

    const post = await app.inject({ url: '/blog/draft-post', headers: { cookie } })
    expect(post.statusCode).toBe(200)
    expect(post.headers['cache-control']).toBe('no-store')
    expect(post.headers['x-robots-tag']).toBe('noindex')
    expect(post.headers['x-inlay-cache']).toBeUndefined()
    expect(post.body).toContain('<meta name="robots" content="noindex">')
    expect(post.body).toContain('<h1>Draft post</h1>')
    expect(post.body).toMatch(/<body><div class="inlay-preview"[^>]*>[^<]*You are previewing unpublished changes/)
    expect(post.body).toMatch(/<a href="\/_inlay\/preview\/exit"[^>]*>Exit preview<\/a>/)

    expect((await app.inject('/')).headers['x-inlay-cache']).toBe('miss')
    const home = await app.inject({ url: '/', headers: { cookie: `other=1; ${cookie}` } })
    expect(home.body).toContain('<h1>Unpublished headline</h1>')
    expect(home.body).toContain('<blockquote>Lovely<cite>Ben</cite></blockquote>')
    expect(home.headers['x-inlay-cache']).toBeUndefined()

    const live = await app.inject('/')
    expect(live.headers['x-inlay-cache']).toBe('hit')
    expect(live.body).toContain('<h1>Welcome to Inlay</h1>')
    expect(live.body).not.toContain('Lovely')
    expect(live.body).not.toContain('inlay-preview')
    expect((await app.inject('/blog/draft-post')).statusCode).toBe(404)
  })

  it('does not cache preview pages for later live requests', async () => {
    const { app, core } = await setup()
    await seed(core)
    const cookie = await previewCookie(app)
    await app.inject({ url: '/', headers: { cookie } })
    const live = await app.inject('/')
    expect(live.headers['x-inlay-cache']).toBe('miss')
    expect(live.body).toContain('<h1>Welcome to Inlay</h1>')
  })

  it('serves live pages for an expired or tampered cookie', async () => {
    const { app, core, advance } = await setup()
    await seed(core)
    const cookie = await previewCookie(app)
    const tampered = await app.inject({ url: '/', headers: { cookie: `${cookie}x` } })
    expect(tampered.body).toContain('<h1>Welcome to Inlay</h1>')
    advance(PREVIEW_TTL_MS)
    const res = await app.inject({ url: '/', headers: { cookie } })
    expect(res.body).toContain('<h1>Welcome to Inlay</h1>')
    expect(res.body).not.toContain('inlay-preview')
    expect(res.headers['cache-control']).not.toBe('no-store')
    expect((await app.inject({ url: '/blog/draft-post', headers: { cookie } })).statusCode).toBe(404)
  })

  it('lists the problems of an incomplete draft instead of rendering it', async () => {
    const { app, core } = await setup()
    await core.createEntry('posts', { slug: 'blank', fields: { title: '', date: '2026-02-01', body: rt('x') } }, owner)
    const cookie = await previewCookie(app)
    const res = await app.inject({ url: '/blog/blank', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toContain('<li>Title is required.</li>')
    expect(res.body).toContain('<meta name="robots" content="noindex">')
    expect(res.body).toMatch(/<a href="\/_inlay\/preview\/exit"[^>]*>Exit preview<\/a>/)
    expect(res.body).not.toContain('<article>')
  })

  it('shows the live site for a cookie that previews a release this app does not serve', async () => {
    const { app, core } = await setup()
    await seed(core)
    const url = new URL(previewLink({ baseUrl: 'https://example.com', secret, now: () => new Date('2026-01-01T00:00:00.000Z') }, '/', { release: 'rel-1' }))
    const res = await app.inject(`${url.pathname}${url.search}`)
    expect(res.statusCode).toBe(302)
    const cookie = cookieOf(res).split(';')[0]!
    expect(cookie).toMatch(/^inlay_preview=v2\.[0-9a-z]+\.rel-1\./)
    const home = await app.inject({ url: '/', headers: { cookie } })
    expect(home.body).toContain('<h1>Welcome to Inlay</h1>')
    expect(home.body).not.toContain('inlay-preview')
  })

  it('renders every request in preview when preview is forced, naming the release', async () => {
    const app = Fastify()
    open.push(app)
    await app.register(inlay, await appOptions({ secret, preview: 'forced', release: { id: 'rel-1', name: 'Spring refresh' } }))
    await seed(app.inlay.core)
    const home = await app.inject('/')
    expect(home.statusCode).toBe(200)
    expect(home.headers['cache-control']).toBe('no-store')
    expect(home.headers['x-robots-tag']).toBe('noindex')
    expect(home.body).toContain('<h1>Unpublished headline</h1>')
    expect(home.body).toContain('Previewing release Spring refresh')
    expect(home.body).not.toContain('/admin/publish')
    expect(home.body).toMatch(/<a href="\/_inlay\/preview\/exit"[^>]*>Exit preview<\/a>/)
    expect((await app.inject('/blog/draft-post')).statusCode).toBe(200)
  })

  it('exits preview by clearing the cookie', async () => {
    const { app } = await setup()
    const res = await app.inject('/_inlay/preview/exit')
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/')
    const cookie = cookieOf(res)
    expect(cookie).toMatch(/^inlay_preview=; /)
    expect(cookie).toContain('; Max-Age=0')
    expect(cookie).toContain('; Path=/')
  })
})
