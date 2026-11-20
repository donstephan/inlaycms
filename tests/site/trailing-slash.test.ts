import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { renderPane } from '../../src/adapters/site/render.js'
import { createPreviewToken } from '../../src/core/preview.js'
import { defineCollection, defineSingleton, defineSite, type SiteDefinition, type TemplateDef } from '../../src/core/registry/define.js'
import { defineRoute } from '../../src/core/registry/route.js'
import { encodePath, type TrailingSlash } from '../../src/core/site/paths.js'
import { raw, renderToString } from '../../src/jsx/html.js'
import { signIn } from '../helpers/admin.js'
import { Page, webSite } from '../fixtures/web.js'
import { makeApp } from '../helpers/app.js'

const rt = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

const open: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((a) => a.close()))
})

function site(trailingSlash: TrailingSlash): SiteDefinition {
  return defineSite({
    ...webSite,
    trailingSlash,
    routes: [
      defineRoute({ method: 'GET', path: '/contact', sitemap: true, handler: () => ({ body: 'contact form' }) }),
      defineRoute({ method: 'POST', path: '/contact', handler: () => ({ body: 'sent' }) }),
    ],
  })
}

/** `t`, with the page's and its alternates' `path` and `url` written after it. */
const probed = (t: TemplateDef): TemplateDef => ({
  ...t,
  render: async (props, ctx) => {
    const alts = ctx.alternates.map((a) => `${a.locale}:${a.path}:${a.url}`).join(',')
    const probe = `<p class="probe">page=${props.page.path}:${props.page.url};alternates=${alts}</p>`
    return raw((await renderToString(t.render!(props, ctx))) + probe)
  },
})

/** `site(mode)` with probed templates and a `/contact` GET route that renders a template. */
function probeSite(mode: TrailingSlash): SiteDefinition {
  const base = site(mode)
  return defineSite({
    ...base,
    singletons: base.singletons.map((s) => (s.template.render ? defineSingleton({ ...s, template: probed(s.template) }) : s)),
    collections: base.collections.map((c) => (c.name === 'posts' ? defineCollection({ ...c, template: probed(c.template) }) : c)),
    routes: [
      defineRoute({
        method: 'GET',
        path: '/contact',
        sitemap: true,
        handler: (_request, ctx) => ctx.render(probed(Page), { fields: { title: 'Contact' } }),
      }),
    ],
  })
}

async function setup(mode: TrailingSlash = 'always', make: (mode: TrailingSlash) => SiteDefinition = site) {
  const publicDir = await mkdtemp(join(tmpdir(), 'inlay-slash-public-'))
  await writeFile(join(publicDir, 'site.css'), 'body{color:red}')
  const made = await makeApp({ site: make(mode), publicDir })
  open.push(made.app)
  const { core, owner } = made
  const ids: string[] = []
  for (const [slug, path] of [['a', undefined], ['b', undefined], ['c', undefined], ['new', '/new'], ['feed', '/feed.xml'], ['latest', undefined]] as const) {
    const fields = { title: `Post ${slug}`, date: slug === 'latest' ? '2026-03-01' : '2026-02-01', body: rt(slug) }
    const view = await core.createEntry('posts', { slug, fields, ...(path && { path }) }, owner)
    ids.push(view.id)
  }
  await core.publish(ids, owner)
  await core.createRedirect({ from: '/old/', to: '/new/' }, owner)
  await core.createRedirect({ from: '/gone', to: 'https://example.org/x' }, owner)
  return made
}

const expectRedirect = async (app: FastifyInstance, url: string, location: string, method: 'GET' | 'HEAD' = 'GET') => {
  const res = await app.inject({ method, url })
  expect(res.statusCode, url).toBe(301)
  expect(res.headers.location, url).toBe(location)
}

const expectOk = async (app: FastifyInstance, url: string) => {
  const res = await app.inject(url)
  expect(res.statusCode, url).toBe(200)
  return res
}

describe("trailingSlash: 'always'", () => {
  it('serves a page at its slashed path and sends the slashless form there', async () => {
    const { app } = await setup()
    expect((await expectOk(app, '/about/')).body).toContain('About us')
    await expectRedirect(app, '/about', '/about/')
    await expectRedirect(app, '/about', '/about/', 'HEAD')
    await expectRedirect(app, '/about?utm=1', '/about/?utm=1')
  })

  it('leaves the home page alone and slashes a locale root', async () => {
    const { app } = await setup()
    expect((await app.inject('/')).statusCode).toBe(200)
    await expectRedirect(app, '/es', '/es/')
    expect((await expectOk(app, '/es/')).body).toContain('Bienvenido a Inlay')
  })

  it('keeps the query string after the slash', async () => {
    const { app } = await setup()
    await expectRedirect(app, '/blog?page=2', '/blog/?page=2')
    expect((await expectOk(app, '/blog/?page=2')).body).toContain('Page 2 of 3')
  })

  it('sends both forms of an old URL to the presented target in one hop', async () => {
    const { app } = await setup()
    await expectRedirect(app, '/old/', '/new/')
    await expectRedirect(app, '/old', '/new/')
    await expectOk(app, '/new/')
  })

  it('sends an external target exactly as written', async () => {
    const { app } = await setup()
    await expectRedirect(app, '/gone/', 'https://example.org/x')
    await expectRedirect(app, '/gone', 'https://example.org/x')
  })

  it('sends case and default-locale variants to the presented path in one hop', async () => {
    const { app } = await setup()
    await expectRedirect(app, '/About/', '/about/')
    await expectRedirect(app, '/About', '/about/')
    await expectRedirect(app, '/en/about', '/about/')
    await expectRedirect(app, '/en/about/', '/about/')
  })

  it('presents a GET code route and leaves its POST route where it is', async () => {
    const { app } = await setup()
    await expectRedirect(app, '/contact', '/contact/')
    await expectRedirect(app, '/contact?x=1', '/contact/?x=1')
    const get = await expectOk(app, '/contact/')
    expect(get.body).toBe('contact form')
    const post = await app.inject({ method: 'POST', url: '/contact', payload: { a: 1 } })
    expect(post.statusCode).toBe(200)
    expect(post.body).toBe('sent')
  })

  it('leaves reserved paths alone', async () => {
    const { app } = await setup()
    for (const url of ['/sitemap.xml', '/robots.txt', '/public/site.css']) {
      const res = await app.inject(url)
      expect(res.statusCode, url).toBe(200)
      expect(res.headers.location, url).toBeUndefined()
    }
  })

  it('never serves a cached page at the slashless path', async () => {
    const { app } = await setup()
    await expectRedirect(app, '/about', '/about/')
    const page = await expectOk(app, '/about/')
    expect(page.headers['x-inlay-cache']).toBe('miss')
    await expectRedirect(app, '/about', '/about/')
    expect((await expectOk(app, '/about/')).headers['x-inlay-cache']).toBe('hit')
  })

  it('keeps a path whose last segment has a dot slashless', async () => {
    const { app } = await setup()
    expect((await expectOk(app, '/feed.xml')).body).toContain('Post feed')
    await expectRedirect(app, '/feed.xml/', '/feed.xml')
  })

  it('opens a preview link at the presented path', async () => {
    const { app } = await setup()
    const token = createPreviewToken('s'.repeat(32), new Date('2026-01-01T00:00:00.000Z'))
    for (const path of ['/about', '/about/']) {
      const res = await app.inject(`/_inlay/preview?token=${token}&path=${encodeURIComponent(path)}`)
      expect(res.statusCode, path).toBe(302)
      expect(res.headers.location, path).toBe('/about/')
    }
  })
})

describe("trailingSlash: 'always' URLs written out", () => {
  it('presents the canonical, og:url and hreflang alternates', async () => {
    const { app } = await setup()
    const about = (await expectOk(app, '/about/')).body
    expect(about).toContain('<link rel="canonical" href="https://example.com/about/">')
    expect(about).toContain('<meta property="og:url" content="https://example.com/about/">')
    const home = (await expectOk(app, '/es/')).body
    expect(home).toContain('<link rel="canonical" href="https://example.com/es/">')
    expect(home).toContain('hreflang="en" href="https://example.com/"')
    expect(home).toContain('hreflang="es" href="https://example.com/es/"')
    expect(home).toContain('hreflang="x-default" href="https://example.com/"')
  })

  it('keeps the page query after the slash and leaves the home page at the root', async () => {
    const { app } = await setup()
    expect((await expectOk(app, '/blog/?page=2')).body).toContain('<link rel="canonical" href="https://example.com/blog/?page=2">')
    expect((await expectOk(app, '/')).body).toContain('<link rel="canonical" href="https://example.com/">')
  })

  it('serves a code route at its slashed path', async () => {
    const { app } = await setup()
    expect((await expectOk(app, '/contact/')).body).toBe('contact form')
  })

  it('writes slashed locs and alternates in the sitemap', async () => {
    const { app } = await setup()
    const xml = (await expectOk(app, '/sitemap.xml')).body
    const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]!)
    expect(locs).toContain('https://example.com/')
    expect(locs).toContain('https://example.com/about/')
    expect(locs).toContain('https://example.com/contact/')
    expect(locs.filter((l) => l !== 'https://example.com/' && l !== 'https://example.com/feed.xml' && !l.endsWith('/'))).toEqual([])
    expect(xml).toContain('hreflang="es" href="https://example.com/es/"/>')
    expect(xml).toContain('hreflang="en" href="https://example.com/about/"/>')
  })

  it('presents entry.url in templates', async () => {
    const { app } = await setup()
    expect((await expectOk(app, '/blog/')).body).toContain('<a href="/blog/latest/">Post latest</a>')
    const pages = await Promise.all(['/blog/', '/blog/?page=2', '/blog/?page=3'].map(async (url) => (await expectOk(app, url)).body))
    expect(pages.join('')).toContain('<a href="/new/">Post new</a>')
    expect(pages.join('')).toContain('<a href="/feed.xml">Post feed</a>')
  })

  it('presents the canonical of a code route that renders a template', async () => {
    const { app } = await setup('always', probeSite)
    expect((await expectOk(app, '/contact/')).body).toContain('<link rel="canonical" href="https://example.com/contact/">')
  })

  it('presents ctx.link to a document and leaves typed URLs as written', async () => {
    const { app, core, owner } = await setup()
    const about = (await core.findSingleton('about', 'en'))!
    const nav = (await core.getDocument((await core.findSingleton('nav', 'en'))!.id))!
    const data = structuredClone(nav.data)
    data.fields.links = [
      { link: { document: about.groupId } },
      { link: { url: '/raw', text: 'Raw' } },
      { link: { url: 'https://x.org', text: 'X' } },
    ]
    await core.saveDraft(nav.id, { baseRevisionId: nav.headRev, data }, owner)
    await core.publish([nav.id], owner)
    const body = (await expectOk(app, '/blog/')).body
    expect(body).toContain('<nav><a href="/about/">About</a><a href="/raw">Raw</a><a href="https://x.org">X</a></nav>')
  })

  it('presents a rich text link to a document', async () => {
    const { app, core, owner } = await setup()
    const blog = (await core.findSingleton('blog', 'en'))!
    const about = (await core.getDocument((await core.findSingleton('about', 'en'))!.id))!
    const data = structuredClone(about.data)
    data.fields.body = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Read the blog', marks: [{ type: 'link', attrs: { document: blog.groupId } }] }] }],
    }
    await core.saveDraft(about.id, { baseRevisionId: about.headRev, data }, owner)
    await core.publish([about.id], owner)
    expect((await expectOk(app, '/about/')).body).toContain('<a href="/blog/">Read the blog</a>')
  })

  it('presents ctx.page.url and ctx.alternates[].url and keeps their paths', async () => {
    const { app } = await setup('always', probeSite)
    expect((await expectOk(app, '/es/')).body).toContain('<p class="probe">page=/es:/es/;alternates=en:/:/,es:/es:/es/</p>')
    expect((await expectOk(app, '/about/')).body).toContain('page=/about:/about/;')
    expect((await expectOk(app, '/feed.xml')).body).toContain('page=/feed.xml:/feed.xml;')
    expect((await expectOk(app, '/contact/')).body).toContain('page=/contact:/contact/;alternates=</p>')
  })
})

describe("trailingSlash: 'always' admin", () => {
  it('gives the preview pane a slashed base href', async () => {
    for (const [mode, base] of [['always', '/about/'], ['never', '/about']] as const) {
      const { core } = await setup(mode)
      const about = (await core.findSingleton('about', 'en'))!
      const doc = (await core.liveDocuments([about.groupId], 'en', { state: 'preview' })).get(about.groupId)!
      const result = await renderPane(core, doc, { page: 1, baseUrl: 'https://example.com' })
      expect(result.ok, mode).toBe(true)
      if (result.ok) expect(result.html, mode).toContain(`<base href="${base}">`)
    }
  })

  it('links the published page with its slash', async () => {
    const made = await makeApp({ site: site('always'), withOwner: true })
    open.push(made.app)
    const admin = await signIn(made.app, 'owner@example.com')
    const about = (await made.core.findSingleton('about', 'en'))!
    await made.core.patchDraft(about.id, { baseRevisionId: about.headRev, ops: [{ path: ['fields', 'title'], value: 'About again' }] }, made.owner)
    const pending = (await made.core.getDocument(about.id))!
    const res = await admin.post('/admin/publish', { ids: about.id, expect: JSON.stringify({ [about.id]: pending.headRev }), _dialog: '1' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<a href="/about/"')
  })
})

describe("trailingSlash: 'never'", () => {
  it('still sends a slashed path to the slashless form', async () => {
    const { app } = await setup('never')
    await expectRedirect(app, '/about/', '/about')
    await expectOk(app, '/about')
    await expectRedirect(app, '/old/', '/new')
    await expectRedirect(app, '/old', '/new')
    await expectRedirect(app, '/en/old', '/new')
    await expectRedirect(app, '/contact/', '/contact')
    expect((await expectOk(app, '/contact')).body).toBe('contact form')
  })

  it('gives ctx.page.url and ctx.alternates[].url as the encoded path', async () => {
    const { app, core, owner } = await setup('never', probeSite)
    const fields = { title: 'Café', date: '2026-02-01', body: rt('café') }
    const view = await core.createEntry('posts', { slug: 'cafe', fields, path: '/café' }, owner)
    await core.publish([view.id], owner)
    const body = (await expectOk(app, encodePath('/café'))).body
    expect(body).toContain(`page=/café:${encodePath('/café')};alternates=en:/café:${encodePath('/café')},`)
    expect((await expectOk(app, '/es')).body).toContain('page=/es:/es;alternates=en:/:/,es:/es:/es</p>')
  })
})
