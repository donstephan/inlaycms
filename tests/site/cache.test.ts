import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { PageCache, response } from '../../src/adapters/site/cache.js'
import type { Core } from '../../src/core/core.js'
import { f } from '../../src/core/fields/builtins.js'
import { defineContent } from '../../src/core/registry/content.js'
import { defineSingleton, defineSite, defineTemplate } from '../../src/core/registry/define.js'
import type { Ctx } from '../../src/core/types.js'
import { png } from '../fixtures/media.js'
import { makeApp } from '../helpers/app.js'

const page = (body: string) => response(200, body, 'text/html')

describe('PageCache', () => {
  it('evicts the least recently used entry', () => {
    const cache = new PageCache(2)
    cache.set('a', page('a'), 0)
    cache.set('b', page('b'), 0)
    cache.get('a')
    cache.set('c', page('c'), 0)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')?.body).toBe('a')
    expect(cache.get('c')?.body).toBe('c')
    expect(cache.size).toBe(2)
  })

  it('ignores a set with a stale generation, and clear bumps it', () => {
    const cache = new PageCache(2)
    const before = cache.generation
    cache.set('a', page('a'), before)
    cache.clear()
    expect(cache.generation).toBe(before + 1)
    expect(cache.size).toBe(0)
    cache.set('a', page('stale'), before)
    expect(cache.get('a')).toBeUndefined()
    cache.set('a', page('fresh'), cache.generation)
    expect(cache.get('a')?.body).toBe('fresh')
  })

  it('does not grow when the same key is set again', () => {
    const cache = new PageCache(5)
    cache.set('404:en', page('x'), 0)
    cache.set('404:en', page('y'), 0)
    expect(cache.size).toBe(1)
  })
})

describe('site cache', () => {
  const open: FastifyInstance[] = []
  afterEach(async () => {
    await Promise.all(open.splice(0).map((a) => a.close()))
  })

  async function app(opts: Parameters<typeof makeApp>[0] = {}) {
    const made = await makeApp(opts)
    open.push(made.app)
    return made
  }

  const cacheHeader = async (a: FastifyInstance, url: string) => (await a.inject(url)).headers['x-inlay-cache']

  async function editHeadline(core: Core, owner: Ctx, headline: string, publish: boolean) {
    const home = await core.liveSingleton('home', 'en')
    const view = await core.getDocument(home!.documentId)
    const data = structuredClone(view!.data)
    data.slots.hero!.data.headline = headline
    await core.saveDraft(home!.documentId, { baseRevisionId: view!.revision.id, data }, owner)
    if (publish) await core.publish([home!.documentId], owner)
  }

  it('hits on the second request, and misses with new content after a publish', async () => {
    const { app: a, core, owner } = await app()
    expect(await cacheHeader(a, '/')).toBe('miss')
    expect(await cacheHeader(a, '/')).toBe('hit')
    await editHeadline(core, owner, 'Fresh headline', true)
    const res = await a.inject('/')
    expect(res.headers['x-inlay-cache']).toBe('miss')
    expect(res.body).toContain('Fresh headline')
  })

  it('keeps a hit through saveDraft, but not through other live changes', async () => {
    const { app: a, core, owner } = await app()
    await a.inject('/')
    await editHeadline(core, owner, 'Draft only', false)
    expect(await cacheHeader(a, '/')).toBe('hit')

    await core.createRedirect({ from: '/old', to: '/about' }, owner)
    expect(await cacheHeader(a, '/')).toBe('miss')

    await a.inject('/')
    const media = (await core.addMedia({ data: await png(10, 10), filename: 'a.png' }, owner)).media
    await core.setMediaAlt(media.id, 'Alt', owner)
    expect(await cacheHeader(a, '/')).toBe('miss')

    const post = await core.createEntry(
      'posts',
      { slug: 'x', fields: { title: 'X', date: '2026-02-01', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] } } },
      owner,
    )
    await core.publish([post.id], owner)
    await a.inject('/')
    await core.deleteEntry(post.groupId, owner)
    expect(await cacheHeader(a, '/')).toBe('miss')
  })

  it('ignores other query parameters but caches ?page separately', async () => {
    const { app: a } = await app()
    await a.inject('/')
    expect(await cacheHeader(a, '/?utm_source=x')).toBe('hit')
    expect(await cacheHeader(a, '/blog')).toBe('miss')
    expect(await cacheHeader(a, '/blog?page=2')).toBe('miss')
    expect(await cacheHeader(a, '/blog?page=2')).toBe('hit')
    expect(await cacheHeader(a, '/blog?page=1')).toBe('hit')
  })

  it('shares one cached 404 page per locale', async () => {
    const { app: a } = await app()
    const first = await a.inject('/a')
    expect(first.statusCode).toBe(404)
    expect(first.headers['x-inlay-cache']).toBe('miss')
    const second = await a.inject('/b')
    expect(second.statusCode).toBe(404)
    expect(second.headers['x-inlay-cache']).toBe('hit')
    expect(await cacheHeader(a, '/es/c')).toBe('miss')
  })

  it('caches the sitemap, and clearCache empties the cache', async () => {
    const { app: a } = await app()
    expect(await cacheHeader(a, '/sitemap.xml')).toBe('miss')
    expect(await cacheHeader(a, '/sitemap.xml')).toBe('hit')
    a.inlay.clearCache()
    expect(await cacheHeader(a, '/sitemap.xml')).toBe('miss')
  })

  it('does not serve a cached page for a non-canonical path', async () => {
    const { app: a } = await app()
    expect(await cacheHeader(a, '/about')).toBe('miss')
    expect(await cacheHeader(a, '/about')).toBe('hit')
    const res = await a.inject('/about/')
    expect(res.statusCode).toBe(301)
    expect(res.headers.location).toBe('/about')
    expect(res.headers['x-inlay-cache']).toBeUndefined()
  })

  it('never caches redirects', async () => {
    const { app: a, core, owner } = await app()
    await core.createRedirect({ from: '/old', to: '/about' }, owner)
    const res = await a.inject('/old')
    expect(res.statusCode).toBe(301)
    expect(res.headers['x-inlay-cache']).toBeUndefined()
  })

  it('sends no cache header when the cache is off', async () => {
    const { app: a } = await app({ cache: false })
    expect((await a.inject('/')).headers['x-inlay-cache']).toBeUndefined()
    expect((await a.inject('/')).headers['x-inlay-cache']).toBeUndefined()
    expect((await a.inject('/nope')).headers['x-inlay-cache']).toBeUndefined()
  })

  it('does not store a render that started before a publish', async () => {
    let started!: () => void
    const reached = new Promise<void>((resolve) => (started = resolve))
    let release!: () => void
    let held = true
    const gate = new Promise<void>((resolve) => (release = resolve))
    const Gated = defineTemplate({
      name: 'gated',
      label: 'Gated',
      fields: z.object({ title: f.text({ label: 'Title' }) }),
      render: async ({ fields }) => {
        const title = fields.title
        if (held) {
          held = false
          started()
          await gate
        }
        return `<h1>${title}</h1>`
      },
    })
    const site = defineSite({
      locales: ['en'],
      defaultLocale: 'en',
      singletons: [
        defineSingleton({
          name: 'home',
          label: 'Home',
          template: Gated,
          path: '/',
        }),
      ],
      content: [defineContent('home', { edition: 1, content: { en: { fields: { title: 'Old title' } } } })],
    })
    const { app: a, core, owner } = await app({ site })

    const pending = a.inject('/')
    await reached
    const home = await core.liveSingleton('home', 'en')
    const view = await core.getDocument(home!.documentId)
    const data = { ...view!.data, fields: { title: 'New title' } }
    await core.saveDraft(home!.documentId, { baseRevisionId: view!.revision.id, data }, owner)
    await core.publish([home!.documentId], owner)
    release()
    await pending

    const next = await a.inject('/')
    expect(next.headers['x-inlay-cache']).toBe('miss')
    expect(next.body).toContain('New title')
  })
})

describe('site cache: HTTP headers', () => {
  const open: FastifyInstance[] = []
  afterEach(async () => {
    await Promise.all(open.splice(0).map((a) => a.close()))
  })

  async function app(opts: Parameters<typeof makeApp>[0] = {}) {
    const made = await makeApp(opts)
    open.push(made.app)
    return made
  }

  async function editHeadline(core: Core, owner: Ctx, headline: string) {
    const home = await core.liveSingleton('home', 'en')
    const view = await core.getDocument(home!.documentId)
    const data = structuredClone(view!.data)
    data.slots.hero!.data.headline = headline
    await core.saveDraft(home!.documentId, { baseRevisionId: view!.revision.id, data }, owner)
    await core.publish([home!.documentId], owner)
  }

  async function previewCookie(a: FastifyInstance): Promise<string> {
    const url = new URL(a.inlay.previewUrl('/'))
    const res = await a.inject(`${url.pathname}${url.search}`)
    const header = res.headers['set-cookie']
    const raw = Array.isArray(header) ? header[0]! : (header as string)
    return raw.split(';')[0]!
  }

  it('sends an ETag, a shared max-age and Vary: Cookie on a published page', async () => {
    const { app: a } = await app()
    const res = await a.inject('/')
    expect(res.statusCode).toBe(200)
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{16,}"$/)
    expect(res.headers['cache-control']).toBe('public, max-age=0, s-maxage=15, stale-if-error=86400')
    expect(res.headers.vary).toBe('Cookie')
  })

  it('answers a matching If-None-Match with 304 and no body, including a weak tag', async () => {
    const { app: a } = await app()
    const etag = (await a.inject('/')).headers.etag as string
    const strong = await a.inject({ url: '/', headers: { 'if-none-match': etag } })
    expect(strong.statusCode).toBe(304)
    expect(strong.body).toBe('')
    expect(strong.headers.etag).toBe(etag)
    expect(strong.headers['cache-control']).toBe('public, max-age=0, s-maxage=15, stale-if-error=86400')
    const weak = await a.inject({ url: '/', headers: { 'if-none-match': `"other", W/${etag}` } })
    expect(weak.statusCode).toBe(304)
    const other = await a.inject({ url: '/', headers: { 'if-none-match': '"other"' } })
    expect(other.statusCode).toBe(200)
  })

  it('changes the ETag after a publish, so a stale If-None-Match gets the new page', async () => {
    const { app: a, core, owner } = await app()
    const before = (await a.inject('/')).headers.etag as string
    await editHeadline(core, owner, 'Fresh headline')
    const res = await a.inject({ url: '/', headers: { 'if-none-match': before } })
    expect(res.statusCode).toBe(200)
    expect(res.headers.etag).not.toBe(before)
    expect(res.body).toContain('Fresh headline')
  })

  it('keeps the ETag of an unchanged page through an unrelated live change', async () => {
    const { app: a, core, owner } = await app()
    const before = (await a.inject('/about')).headers.etag as string
    await core.createRedirect({ from: '/old', to: '/about' }, owner)
    const res = await a.inject({ url: '/about', headers: { 'if-none-match': before } })
    expect(res.headers['x-inlay-cache']).toBe('miss')
    expect(res.statusCode).toBe(304)
  })

  it('works the same with the memory cache off', async () => {
    const { app: a } = await app({ cache: false })
    const etag = (await a.inject('/')).headers.etag as string
    expect(etag).toMatch(/^"[0-9a-f]{16,}"$/)
    const res = await a.inject({ url: '/', headers: { 'if-none-match': etag } })
    expect(res.statusCode).toBe(304)
    expect(res.headers['cache-control']).toBe('public, max-age=0, s-maxage=15, stale-if-error=86400')
  })

  it('sends the same headers on the 404 page and the sitemap', async () => {
    const { app: a } = await app()
    const missing = await a.inject('/nope')
    expect(missing.statusCode).toBe(404)
    expect(missing.headers.etag).toMatch(/^"[0-9a-f]{16,}"$/)
    expect(missing.headers['cache-control']).toBe('public, max-age=0, s-maxage=15, stale-if-error=86400')
    const again = await a.inject({ url: '/other', headers: { 'if-none-match': missing.headers.etag as string } })
    expect(again.statusCode).toBe(304)
    const sitemap = await a.inject('/sitemap.xml')
    expect(sitemap.headers.etag).toMatch(/^"[0-9a-f]{16,}"$/)
    expect(sitemap.headers['cache-control']).toBe('public, max-age=0, s-maxage=15, stale-if-error=86400')
  })

  it('keeps preview, redirects and errors out of shared caches', async () => {
    const { app: a, core, owner } = await app()
    const cookie = await previewCookie(a)
    const preview = await a.inject({ url: '/', headers: { cookie } })
    expect(preview.statusCode).toBe(200)
    expect(preview.headers['cache-control']).toBe('no-store')
    expect(preview.headers.etag).toBeUndefined()
    const etag = (await a.inject('/')).headers.etag as string
    const conditional = await a.inject({ url: '/', headers: { cookie, 'if-none-match': etag } })
    expect(conditional.statusCode).toBe(200)

    await core.createRedirect({ from: '/old', to: '/about' }, owner)
    const redirect = await a.inject('/old')
    expect(redirect.statusCode).toBe(301)
    expect(redirect.headers['cache-control']).toBeUndefined()
    expect(redirect.headers.etag).toBeUndefined()
  })

  it('takes the shared max-age and stale-if-error from the cdn option', async () => {
    const { app: a } = await app({ cdn: { maxAge: 60, staleIfError: 0 } })
    expect((await a.inject('/')).headers['cache-control']).toBe('public, max-age=0, s-maxage=60')
    const { app: b } = await app({ cdn: { maxAge: 0 } })
    expect((await b.inject('/')).headers['cache-control']).toBe('public, max-age=0, s-maxage=0, stale-if-error=86400')
  })
})
