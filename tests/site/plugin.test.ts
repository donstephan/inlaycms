import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { inlay, type InlayOptions } from '../../src/adapters/site/plugin.js'
import type { Core } from '../../src/core/core.js'
import { f } from '../../src/core/fields/builtins.js'
import { DEFAULT_UPLOAD_TYPES } from '../../src/core/media/detect.js'
import { t } from '../../src/core/messages/index.js'
import { defineContent } from '../../src/core/registry/content.js'
import { defineCollection, defineSingleton, defineSite, defineTemplate } from '../../src/core/registry/define.js'
import type { Ctx } from '../../src/core/types.js'
import { pdf, png } from '../fixtures/media.js'
import { escapeHtml } from '../../src/jsx/html.js'
import { Testimonial, webSite } from '../fixtures/web.js'
import { appOptions, makeApp } from '../helpers/app.js'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const rt = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

const open: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()))
})

async function app(opts: Parameters<typeof makeApp>[0] = {}) {
  const made = await makeApp(opts)
  open.push(made.app)
  return made
}

async function register(opts: Partial<InlayOptions>): Promise<void> {
  const fastify = Fastify()
  open.push(fastify)
  await fastify.register(inlay, await appOptions(opts))
}

/** A real HTTP GET, so the request path reaches Fastify unnormalized (`inject` parses it as a URL). */
async function rawGet(app: FastifyInstance, path: string): Promise<{ status: number; location: string | undefined }> {
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function post(core: Core, owner: Ctx, slug: string, title: string, date = '2026-02-01') {
  const view = await core.createEntry('posts', { slug, fields: { title, date, body: rt(title) } }, owner)
  await core.publish([view.id], owner)
  return view
}

describe('inlay plugin: options', () => {
  it('rejects a short secret', async () => {
    await expect(register({ secret: 's'.repeat(31) })).rejects.toMatchObject({ code: 'config', messageId: 'config.secret' })
  })

  it.each(['ftp://x', 'https://x.com/sub', 'example.com', 'https://x.com?a=1'])('rejects baseUrl %s', async (baseUrl) => {
    await expect(register({ baseUrl })).rejects.toMatchObject({ code: 'config', messageId: 'config.baseUrl' })
  })

  it('strips a trailing slash from baseUrl', async () => {
    const { app: a } = await app({ baseUrl: 'https://example.com/' })
    const res = await a.inject('/robots.txt')
    expect(res.body).toContain('Sitemap: https://example.com/sitemap.xml\n')
  })

  it('rejects a notFound that is not a path-less singleton', async () => {
    for (const notFound of ['about', 'nav', 'nope']) {
      await expect(register({ site: defineSite({ ...webSite, notFound }) })).rejects.toMatchObject({
        code: 'definition',
        messageId: 'definition.notFound',
      })
    }
  })

  it('rejects a routed type whose template has no render', async () => {
    const site = defineSite({
      ...webSite,
      singletons: [
        ...webSite.singletons,
        defineSingleton({
          name: 'quote',
          label: 'Quote',
          template: Testimonial,
          path: '/quote',
        }),
      ],
      content: [...webSite.content, defineContent('quote', { edition: 1, content: { en: { fields: { quote: 'Hi', author: 'Ana' } } } })],
    })
    await expect(register({ site })).rejects.toMatchObject({ code: 'config', messageId: 'config.renderMissing' })
  })

  it('rejects invalid shipped content with check_failed', async () => {
    const site = defineSite({
      ...webSite,
      content: webSite.content.map((c) => (c.type === 'blog' ? defineContent('blog', { edition: 1, content: { en: { fields: {} } } }) : c)),
    })
    await expect(register({ site })).rejects.toMatchObject({ code: 'check_failed' })
  })
})

describe('inlay plugin: pages', () => {
  it('serves the home page as HTML, and HEAD with an empty body', async () => {
    const { app: a } = await app()
    const res = await a.inject('/')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.body).toContain('<h1>Welcome to Inlay</h1>')
    const head = await a.inject({ method: 'HEAD', url: '/' })
    expect(head.statusCode).toBe(200)
    expect(head.body).toBe('')
  })

  it('serves a translated page', async () => {
    const { app: a } = await app()
    const res = await a.inject('/es')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Bienvenido a Inlay')
  })

  it('redirects a trailing slash and keeps the query string', async () => {
    const { app: a } = await app()
    const res = await a.inject('/about/?utm=1')
    expect(res.statusCode).toBe(301)
    expect(res.headers.location).toBe('/about?utm=1')
  })

  it('follows redirect rules and keeps the query string', async () => {
    const { app: a, core, owner } = await app()
    await core.createRedirect({ from: '/old', to: '/about' }, owner)
    const res = await a.inject('/old?ref=a')
    expect(res.statusCode).toBe(301)
    expect(res.headers.location).toBe('/about?ref=a')
  })

  it('serves a 404 and logs a warning for a redirect loop', async () => {
    const { app: a, core, owner } = await app()
    await core.createRedirect({ from: '/a/:y', to: '/p/a/:y' }, owner)
    await core.createRedirect({ from: '/p/:x/:z', to: '/:x/:z' }, owner)
    const warnings: unknown[] = []
    a.addHook('onRequest', async (request) => {
      const warn = request.log.warn.bind(request.log)
      request.log.warn = ((...args: Parameters<typeof warn>) => (warnings.push(args), warn(...args))) as typeof warn
    })
    const res = await a.inject('/p/a/q?x=1')
    expect(res.statusCode).toBe(404)
    expect(res.headers.location).toBeUndefined()
    expect(warnings).toEqual([
      [{ loop: ['/p/:x/:z', '/a/:y'] }, t('log.redirectLoop', { path: '/p/a/q', rules: '/p/:x/:z, /a/:y' })],
    ])
  })

  it('renders the notFound singleton with status 404 in the requested locale', async () => {
    const { app: a } = await app()
    const res = await a.inject('/nope')
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.body).toContain('<h1>Page not found</h1>')
    const es = await a.inject('/es/nope')
    expect(es.statusCode).toBe(404)
    expect(es.body).toContain('<html lang="es"')
  })

  it('renders the catalog 404 without notFound', async () => {
    const { app: a } = await app({ site: defineSite({ ...webSite, notFound: null }) })
    const res = await a.inject('/nope')
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.body).toContain(escapeHtml(t('site.notFound')))
  })

  it('checks the page parameter', async () => {
    const { app: a, core, owner } = await app()
    for (const [i, slug] of ['a', 'b', 'c'].entries()) await post(core, owner, slug, `Post ${slug}`, `2026-02-0${i + 1}`)
    expect((await a.inject('/blog?page=0')).statusCode).toBe(404)
    expect((await a.inject('/blog?page=x')).statusCode).toBe(404)
    expect((await a.inject('/blog?page=-1')).statusCode).toBe(404)
    const res = await a.inject('/blog?page=2')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Page 2 of 2')
  })

  it.each(['//evil.com/', '/%2F%2Fevil.com/', '/\\evil.com/', '/%5Cevil.com/'])('never redirects %s off the site', async (url) => {
    const { app: a } = await app()
    const res = await rawGet(a, url)
    expect(res.status).toBe(404)
    expect(res.location).toBeUndefined()
  })

  it('lets developer routes registered after Inlay take precedence', async () => {
    const { app: a } = await app()
    a.get('/hello', async () => 'hi')
    const res = await a.inject('/hello')
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('hi')
  })

  it('answers a render error with 500 and the catalog error page', async () => {
    const Boom = defineTemplate({
      name: 'boom',
      label: 'Boom',
      fields: z.object({ title: f.text({ label: 'Title' }), date: f.date({ label: 'Date' }), body: f.richText({ label: 'Body' }) }),
      render: () => {
        throw new Error('boom')
      },
    })
    const site = defineSite({
      ...webSite,
      collections: [
        defineCollection({ name: 'posts', label: 'Posts', template: Boom, route: '/blog/:slug' }),
        ...webSite.collections.filter((c) => c.name !== 'posts'),
      ],
    })
    const { app: a, core, owner } = await app({ site })
    await post(core, owner, 'bang', 'Bang')
    const res = await a.inject('/blog/bang')
    expect(res.statusCode).toBe(500)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.body).toContain(escapeHtml(t('site.error')))
    expect(res.body).not.toContain('boom')
  })
})

describe('inlay plugin: media', () => {
  async function withMedia() {
    const made = await app({ uploads: { types: [...DEFAULT_UPLOAD_TYPES, DOCX] } })
    const { core, owner } = made
    const image = (await core.addMedia({ data: await png(800, 400), filename: 'team.png' }, owner)).media
    const doc = (await core.addMedia({ data: pdf(), filename: 'menu.pdf' }, owner)).media
    const word = (await core.addMedia({ data: Buffer.from('random text'), filename: 'notes.docx' }, owner)).media
    return { ...made, image, doc, word }
  }

  it('serves an original image with immutable caching headers', async () => {
    const { app: a, image } = await withMedia()
    const res = await a.inject(`/media/${image.id}`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers.etag).toBe(`"${image.id}"`)
    expect(res.headers['content-disposition']).toMatch(/^inline/)
    expect(res.rawPayload.subarray(1, 4).toString()).toBe('PNG')
  })

  it('answers a matching If-None-Match with 304', async () => {
    const { app: a, image } = await withMedia()
    const res = await a.inject({ url: `/media/${image.id}`, headers: { 'if-none-match': `"${image.id}"` } })
    expect(res.statusCode).toBe(304)
    expect(res.body).toBe('')
  })

  it('serves PDFs inline and other files as attachments', async () => {
    const { app: a, doc, word } = await withMedia()
    const p = await a.inject(`/media/${doc.id}`)
    expect(p.headers['content-type']).toBe('application/pdf')
    expect(p.headers['content-disposition']).toMatch(/^inline/)
    const w = await a.inject(`/media/${word.id}`)
    expect(w.statusCode).toBe(200)
    expect(w.headers['content-disposition']).toMatch(/^attachment; filename\*=UTF-8''notes\.docx$/)
    expect(w.headers['x-content-type-options']).toBe('nosniff')
  })

  it('serves variants and 404s unknown widths, formats and ids', async () => {
    const { app: a, image, doc } = await withMedia()
    const res = await a.inject(`/media/${image.id}/640.webp`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/webp')
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(res.headers.etag).toBe(`"${image.id}"`)
    for (const url of [
      `/media/${image.id}/333.webp`,
      `/media/${image.id}/640.gif`,
      `/media/${image.id}/640`,
      `/media/${doc.id}/640.webp`,
      `/media/${'0'.repeat(64)}`,
      `/media/${'0'.repeat(64)}/640.webp`,
    ]) {
      const miss = await a.inject(url)
      expect(miss.statusCode, url).toBe(404)
      expect(miss.headers['content-type'], url).toBe('text/plain; charset=utf-8')
    }
  })
})

describe('inlay plugin: sitemap and robots', () => {
  it('serves sitemap.xml', async () => {
    const { app: a } = await app()
    const res = await a.inject('/sitemap.xml')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/xml/)
    expect(res.body).toContain('<loc>https://example.com/es</loc>')
  })

  it('serves robots.txt', async () => {
    const { app: a } = await app()
    const res = await a.inject('/robots.txt')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(res.body).toBe('User-agent: *\nDisallow: /_inlay/\nSitemap: https://example.com/sitemap.xml\n')
  })
})

describe('inlay plugin: app.inlay', () => {
  it('reads published singletons with fallback', async () => {
    const { app: a } = await app()
    const about = await a.inlay.getDocument<{ title: string }>('about', { locale: 'es' })
    expect(about).toMatchObject({ type: 'about', locale: 'en', fallback: true, url: '/es/acerca' })
    expect(about!.fields.title).toBe('About us')
    const home = await a.inlay.getDocument('home')
    expect(home).toMatchObject({ locale: 'en', fallback: false, url: '/' })
    expect(home!.fields).toMatchObject({ title: 'Home' })
  })

  it('reads entries by slug', async () => {
    const { app: a, core, owner } = await app()
    await post(core, owner, 'hello', 'Hello')
    expect(await a.inlay.getDocument('posts', { slug: 'hello' })).toMatchObject({ title: 'Hello', url: '/blog/hello' })
    expect(await a.inlay.getDocument('posts', { slug: 'missing' })).toBeNull()
    expect(await a.inlay.getDocument('posts')).toBeNull()
  })

  it('queries published entries', async () => {
    const { app: a, core, owner } = await app()
    await post(core, owner, 'one', 'One', '2026-02-01')
    await post(core, owner, 'two', 'Two', '2026-02-02')
    await core.createEntry('posts', { slug: 'draft', fields: { title: 'Draft', date: '2026-02-03', body: rt('x') } }, owner)
    const all = await a.inlay.query<{ date: string }>('posts', { sort: { field: 'date', direction: 'desc' } })
    expect(all.items.map((e) => e.title)).toEqual(['Two', 'One'])
    expect(all.total).toBe(2)
    const es = await a.inlay.query('posts', { locale: 'es', limit: 1, page: 2, sort: 'oldest' })
    expect(es).toMatchObject({ total: 2, page: 2, pages: 2 })
    expect(es.items[0]).toMatchObject({ title: 'Two', fallback: true })
  })

  it('destroys the database on close', async () => {
    const { app: a } = await app()
    await a.ready()
    await a.close()
    await expect(a.inlay.core.listRedirects()).rejects.toThrow()
  })
})

describe('inlay plugin: read-only', () => {
  const owner: Ctx = { actor: { id: 'user-owner', name: 'Olivia Owner', role: 'owner' }, source: 'admin' }

  it('refuses every write through the core and the admin, but reads, dry runs and logging in work', async () => {
    const fastify = Fastify()
    open.push(fastify)
    await fastify.register(inlay, await appOptions({ readOnly: true }))
    const core = fastify.inlay.core
    const refused = { code: 'read_only', messageId: 'error.previewReadOnly' }
    await expect(core.createEntry('posts', { slug: 'x', fields: { title: 'X' } }, owner)).rejects.toMatchObject(refused)
    await expect(core.createRedirect({ from: '/a', to: '/b' }, owner)).rejects.toMatchObject(refused)
    await expect(core.addMedia({ data: await png(5, 5), filename: 'x.png' }, owner)).rejects.toMatchObject(refused)
    await expect(core.setSiteLock(true, owner)).rejects.toMatchObject(refused)
    await expect(core.backup(owner)).rejects.toMatchObject(refused)
    await expect(core.publish([], owner, { dryRun: true })).resolves.toBeDefined()
    expect(await core.findSingleton('home', 'en')).not.toBeNull()

    const write = await fastify.inject({
      method: 'POST',
      url: '/admin/redirects',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'from=/a&to=/b',
    })
    expect(write.statusCode).toBe(403)
    expect(write.body).toContain(escapeHtml(t('error.previewReadOnly')))
    const login = await fastify.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://example.com' },
      payload: 'email=a@example.com&password=wrong',
    })
    expect(login.statusCode).not.toBe(403)
  })
})
