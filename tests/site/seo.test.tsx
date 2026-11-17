import { renderPage } from '../../src/adapters/site/render.js'
import { buildHead, injectHead } from '../../src/adapters/site/head.js'
import { renderSitemap } from '../../src/adapters/site/sitemap.js'
import type { Core } from '../../src/core/core.js'
import { defineContent } from '../../src/core/registry/content.js'
import { defineSingleton, defineSite, defineTemplate } from '../../src/core/registry/define.js'
import { f } from '../../src/core/fields/builtins.js'
import type { Ctx, DocumentData, LiveState } from '../../src/core/types.js'
import { z } from 'zod'
import { png } from '../fixtures/media.js'
import { webSite } from '../fixtures/web.js'
import { makeCore } from '../helpers/core.js'

const baseUrl = 'https://example.com'
const rt = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

async function world(site = webSite) {
  const w = await makeCore({ site, media: true })
  const { media } = await w.core.addMedia({ data: await png(800, 400), filename: 'team.png' }, w.owner)
  await w.core.applyShippedContent()
  return { ...w, mediaId: media.id }
}

async function edit(core: Core, ctx: Ctx, type: string, locale: string, change: (d: DocumentData) => void) {
  const summary = await core.findSingleton(type, locale)
  const view = await core.getDocument(summary!.id)
  const data = structuredClone(view!.data)
  change(data)
  await core.saveDraft(view!.id, { baseRevisionId: view!.headRev, data }, ctx)
  await core.publish([view!.id], ctx)
}

async function render(core: Core, type: string, locale = 'en', page = 1, state: LiveState = 'published') {
  const doc = await core.liveSingleton(type, locale, { state })
  return renderPage(core, doc!, { state, page, baseUrl })
}

describe('head tags', () => {
  it('uses the SEO values and lists hreflang alternates', async () => {
    const { core, owner } = await world()
    await edit(core, owner, 'home', 'en', (d) => {
      d.fields.seo = { title: 'SEO Home', description: 'About "us"' }
    })
    const html = await render(core, 'home')
    expect(html).toContain('<title>SEO Home</title>')
    expect(html).toContain('<meta name="description" content="About &quot;us&quot;">')
    expect(html).toContain('<link rel="canonical" href="https://example.com/">')
    expect(html).toContain('hreflang="en" href="https://example.com/"')
    expect(html).toContain('hreflang="es" href="https://example.com/es"')
    expect(html).toContain('hreflang="x-default" href="https://example.com/"')
    expect(html).toContain('<meta property="og:title" content="SEO Home">')
    expect(html).toContain('<meta property="og:url" content="https://example.com/">')
    expect(html).not.toContain('noindex')
  })

  it('falls back to the page title', async () => {
    const { core } = await world()
    expect(await render(core, 'home')).toContain('<title>Home</title>')
  })

  it('points a fallback page at the default-locale URL, without hreflang', async () => {
    const { core } = await world()
    const html = await render(core, 'about', 'es')
    expect(html).toContain('<link rel="canonical" href="https://example.com/about">')
    expect(html).not.toContain('hreflang')
  })

  it('adds ?page=N to the canonical', async () => {
    const { core } = await world()
    expect(await render(core, 'blog', 'en', 2)).toContain('<link rel="canonical" href="https://example.com/blog?page=2">')
    expect(await render(core, 'blog', 'en', 1)).toContain('<link rel="canonical" href="https://example.com/blog">')
  })

  it('sets noindex in preview', async () => {
    const { core } = await world()
    expect(await render(core, 'home', 'en', 1, 'preview')).toContain('<meta name="robots" content="noindex">')
  })

  it('gives a path-less page no canonical or og:url, and noindex', async () => {
    const { core } = await world()
    const html = await render(core, 'notFound')
    expect(html).toContain('<title>')
    expect(html).not.toContain('rel="canonical"')
    expect(html).not.toContain('og:url')
    expect(html).toContain('<meta name="robots" content="noindex">')
  })

  it('uses the 1280px JPEG variant for og:image', async () => {
    const { core, owner, mediaId } = await world()
    await edit(core, owner, 'home', 'en', (d) => {
      d.fields.seo = { image: { media: mediaId } }
    })
    expect(await render(core, 'home')).toContain(
      `<meta property="og:image" content="https://example.com/media/${mediaId}/1280.jpeg">`,
    )
  })

  it('escapes an SEO title that tries to break out', async () => {
    const { core, owner } = await world()
    await edit(core, owner, 'home', 'en', (d) => {
      d.fields.seo = { title: '</title><script>x</script>' }
    })
    const html = await render(core, 'home')
    expect(html).toContain('<title>&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;</title>')
    expect(html).not.toContain('<script>')
  })

  it('leaves a template without </head> unchanged apart from the doctype', async () => {
    const Bare = defineTemplate({
      name: 'bare',
      label: 'Bare',
      fields: z.object({ title: f.text({ label: 'Title' }), seo: f.seo().optional() }),
      render: () => <main>hi</main>,
    })
    const site = defineSite({
      locales: ['en'],
      defaultLocale: 'en',
      singletons: [
        defineSingleton({ name: 'bare', label: 'Bare', template: Bare, path: '/' }),
      ],
      content: [defineContent('bare', { edition: 1, content: { en: { fields: { title: 'Bare' } } } })],
    })
    const { core } = await world(site)
    expect(await render(core, 'bare')).toBe('<!doctype html><main>hi</main>')
  })

  it('injects before the first </head>, case-insensitively', () => {
    const head = buildHead({
      title: 'T',
      description: null,
      image: null,
      ogType: 'website',
      article: null,
      canonical: '/',
      alternates: [],
      defaultLocale: 'en',
      baseUrl,
      preview: false,
    })
    expect(injectHead('<head></HEAD><head></head>', head).startsWith('<head><title>T</title>')).toBe(true)
  })
})

describe('sitemap', () => {
  it('lists live, non-fallback, routable documents', async () => {
    const { core, owner } = await world()
    const fields = (title: string) => ({ title, date: '2026-01-01', body: rt('x') })
    const live = await core.createEntry('posts', { slug: 'live', fields: fields('Live') }, owner)
    await core.createEntry('posts', { slug: 'draft', fields: fields('Draft') }, owner)
    const gone = await core.createEntry('posts', { slug: 'gone', fields: fields('Gone') }, owner)
    const custom = await core.createEntry('posts', { slug: 'cust', path: '/special', fields: fields('Custom') }, owner)
    await core.publish([live.id, gone.id, custom.id], owner)
    await core.deleteEntry(gone.groupId, owner)

    const entries = await core.sitemapEntries()
    const paths = entries.map((e) => e.path)
    expect(paths).toEqual(expect.arrayContaining(['/', '/es', '/about', '/blog', '/blog/live', '/special']))
    expect(paths).not.toContain('/blog/draft')
    expect(paths).not.toContain('/blog/gone')
    expect(paths).not.toContain('/es/acerca')
    expect(paths).not.toContain('/es/blog/live')
    const home = entries.find((e) => e.path === '/')!
    expect(home.alternates).toEqual([
      { locale: 'en', path: '/' },
      { locale: 'es', path: '/es' },
    ])
    expect(home.updatedAt?.slice(0, 10)).toBe('2026-01-01')
  })

  it('leaves out lastmod for an entry without updatedAt', () => {
    const xml = renderSitemap([{ path: '/calc', alternates: [] }], 'https://example.com')
    expect(xml).toContain('<url><loc>https://example.com/calc</loc></url>')
    expect(xml).not.toContain('lastmod')
  })

  it('renders escaped XML', () => {
    const xml = renderSitemap(
      [
        {
          path: '/a&b',
          updatedAt: '2026-01-01T00:00:03.000Z',
          alternates: [{ locale: 'es', path: '/es/<x>' }],
        },
      ],
      baseUrl,
    )
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"')
    expect(xml).toContain('<loc>https://example.com/a%26b</loc>')
    expect(xml).toContain('<lastmod>2026-01-01</lastmod>')
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="es" href="https://example.com/es/%3Cx%3E"/>')
    expect(xml).not.toContain('<x>')
  })
})
