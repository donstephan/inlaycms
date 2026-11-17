import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetVersion, publicAssets, type PublicAssets } from '../../src/adapters/site/assets.js'
import { renderPage, renderTemplateData } from '../../src/adapters/site/render.js'
import type { Core } from '../../src/core/core.js'
import { f } from '../../src/core/fields/builtins.js'
import { defineContent } from '../../src/core/registry/content.js'
import {
  defineSingleton,
  defineSite,
  defineTemplate,
  type SeoSettings,
  type SiteDefinition,
} from '../../src/core/registry/define.js'
import type { RenderContext } from '../../src/core/registry/render.js'
import type { Ctx, DocumentData, LiveDocument, LiveState } from '../../src/core/types.js'
import { escapeHtml } from '../../src/jsx/html.js'
import { z } from 'zod'
import { headSite } from '../fixtures/head-site.js'
import { png } from '../fixtures/media.js'
import { webSite } from '../fixtures/web.js'
import { makeApp } from '../helpers/app.js'
import { makeCore } from '../helpers/core.js'

const baseUrl = 'https://example.com'

async function world(site: SiteDefinition = headSite()) {
  const w = await makeCore({ site, media: true })
  const { media } = await w.core.addMedia({ data: await png(800, 400), filename: 'team.png' }, w.owner)
  await w.core.applyShippedContent()
  return { ...w, mediaId: media.id }
}

async function edit(
  core: Core,
  ctx: Ctx,
  type: string,
  locale: string,
  change: (d: DocumentData) => void,
  publish = true,
) {
  const summary = await core.findSingleton(type, locale)
  const view = await core.getDocument(summary!.id)
  const data = structuredClone(view!.data)
  change(data)
  await core.saveDraft(view!.id, { baseRevisionId: view!.headRev, data }, ctx)
  if (publish) await core.publish([view!.id], ctx)
}

const defaults = (core: Core, ctx: Ctx, value: Record<string, unknown>, publish = true) =>
  edit(core, ctx, 'settings', 'en', (d) => {
    d.fields.defaults = value
  }, publish)

async function render(
  core: Core,
  type: string,
  opts: { locale?: string; state?: LiveState; assets?: PublicAssets } = {},
) {
  const state = opts.state ?? 'published'
  const doc = await core.liveSingleton(type, opts.locale ?? 'en', { state })
  return renderPage(core, doc!, { state, page: 1, baseUrl, ...(opts.assets && { assets: opts.assets }) })
}

async function post(core: Core, owner: Ctx, title = 'Hello', slug = 'hello'): Promise<LiveDocument> {
  const view = await core.createEntry('posts', { slug, fields: { title } }, owner)
  await core.publish([view.id], owner)
  return (await core.liveDocuments([view.groupId], 'en')).get(view.groupId)!
}

const title = (s: string) => `<title>${escapeHtml(s)}</title>`
const withTemplate: SeoSettings = { titleTemplate: '%s | Site' }

async function publicDir(files: Record<string, Buffer>) {
  const dir = await mkdtemp(join(tmpdir(), 'inlay-head-public-'))
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, name), bytes)
  return dir
}

describe('titles', () => {
  it('uses seo.title exactly, even with a title template', async () => {
    const { core, owner } = await world(headSite(withTemplate))
    await edit(core, owner, 'about', 'en', (d) => {
      d.fields.seo = { title: 'Own' }
    })
    const html = await render(core, 'about')
    expect(html).toContain('<title>Own</title>')
    expect(html).toContain('<meta property="og:title" content="Own">')
    expect(html).toContain('<meta name="twitter:title" content="Own">')
  })

  it('puts the fallback title through the template, but not on the home page or a locale root', async () => {
    const { core } = await world(headSite(withTemplate))
    const about = await render(core, 'about')
    expect(about).toContain('<title>About | Site</title>')
    expect(about).toContain('<meta property="og:title" content="About | Site">')
    expect(await render(core, 'home')).toContain('<title>Home</title>')
    expect(await render(core, 'home', { locale: 'es' })).toContain('<title>Home</title>')
    expect(await render(core, 'about', { locale: 'es' })).toContain('<title>About | Site</title>')
  })

  it("uses the global's template over the code's, and the code's when the global field is empty", async () => {
    const { core, owner } = await world(headSite(withTemplate))
    await defaults(core, owner, { titleTemplate: '%s — Global' })
    expect(await render(core, 'about')).toContain('<title>About — Global</title>')
    await defaults(core, owner, { titleTemplate: '' })
    expect(await render(core, 'about')).toContain('<title>About | Site</title>')
    await defaults(core, owner, {})
    expect(await render(core, 'about')).toContain('<title>About | Site</title>')
  })

  it("keeps $& and $' in titles as written", async () => {
    const { core, owner } = await world(headSite(withTemplate))
    const page = async (doc: LiveDocument) => renderPage(core, doc, { state: 'published', page: 1, baseUrl })
    expect(await page(await post(core, owner, "A $& B $' C", 'a'))).toContain(title("A $& B $' C | Site"))
    expect(await page(await post(core, owner, '50%s off $1 $` $$', 'b'))).toContain(title('50%s off $1 $` $$ | Site'))
    await edit(core, owner, 'about', 'en', (d) => {
      d.fields.seo = { title: "%s $& $' own" }
    })
    const html = await render(core, 'about')
    expect(html).toContain(title("%s $& $' own"))
    expect(html).toContain(`<meta property="og:title" content="${escapeHtml("%s $& $' own")}">`)
  })

  it('gives the 404 page the template too', async () => {
    const { core } = await world(headSite(withTemplate))
    expect(await render(core, 'notFound')).toContain('<title>Not found | Site</title>')
  })
})

describe('description', () => {
  it('takes the description from the page, then the defaults', async () => {
    const { core, owner } = await world(headSite({ description: 'Code desc' }))
    let html = await render(core, 'about')
    expect(html).toContain('<meta name="description" content="Code desc">')
    expect(html).toContain('<meta property="og:description" content="Code desc">')

    await defaults(core, owner, { description: 'Global desc' })
    expect(await render(core, 'about')).toContain('<meta name="description" content="Global desc">')

    await edit(core, owner, 'about', 'en', (d) => {
      d.fields.seo = { description: 'Page desc' }
    })
    html = await render(core, 'about')
    expect(html).toContain('<meta name="description" content="Page desc">')
    expect(html).not.toContain('Global desc')
  })
})

describe('share image', () => {
  it("takes the share image from the page, then the global, then the code's /public path, absolute and versioned", async () => {
    const og = await png(1200, 630)
    const assets = publicAssets(await publicDir({ 'og.png': og }))
    const { core, owner, mediaId } = await world(headSite({ image: '/public/og.png' }))
    const { media: other } = await core.addMedia({ data: await png(600, 300, '#cc3366'), filename: 'other.png' }, owner)
    const image = (url: string) => `<meta property="og:image" content="${url}">`

    await defaults(core, owner, { image: { media: other.id } })
    await edit(core, owner, 'about', 'en', (d) => {
      d.fields.seo = { image: { media: mediaId } }
    })
    expect(await render(core, 'about', { assets })).toContain(image(`${baseUrl}/media/${mediaId}/1280.jpeg`))

    await edit(core, owner, 'about', 'en', (d) => {
      d.fields.seo = {}
    })
    expect(await render(core, 'about', { assets })).toContain(image(`${baseUrl}/media/${other.id}/1280.jpeg`))

    await defaults(core, owner, {})
    expect(await render(core, 'about', { assets })).toContain(image(`${baseUrl}/public/og.png?v=${assetVersion(og)}`))
  })

  it('emits a missing /public default image unversioned and still renders', async () => {
    const assets = publicAssets(await publicDir({}))
    const { core } = await world(headSite({ image: '/public/missing.png' }))
    const html = await render(core, 'about', { assets })
    expect(html).toContain('<h1>About</h1>')
    expect(html).toContain('<meta property="og:image" content="https://example.com/public/missing.png">')
    expect(html).toContain('<meta name="twitter:image" content="https://example.com/public/missing.png">')
    expect(await render(core, 'about')).toContain('<meta property="og:image" content="https://example.com/public/missing.png">')
  })
})

describe('twitter tags', () => {
  it('makes twitter:card summary without an image and summary_large_image with one', async () => {
    const { core, owner, mediaId } = await world()
    let html = await render(core, 'about')
    expect(html).toContain('<meta name="twitter:card" content="summary">')
    expect(html).not.toContain('twitter:image')
    await edit(core, owner, 'about', 'en', (d) => {
      d.fields.seo = { image: { media: mediaId } }
    })
    html = await render(core, 'about')
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">')
  })

  it('mirrors og:title, og:description and og:image into Twitter tags', async () => {
    const { core, owner, mediaId } = await world()
    await edit(core, owner, 'about', 'en', (d) => {
      d.fields.seo = { title: 'T', description: 'D', image: { media: mediaId } }
    })
    const img = `${baseUrl}/media/${mediaId}/1280.jpeg`
    expect(await render(core, 'about')).toContain(
      '<meta property="og:type" content="website">' +
        '<meta property="og:title" content="T">' +
        '<meta property="og:description" content="D">' +
        '<meta property="og:url" content="https://example.com/about">' +
        `<meta property="og:image" content="${img}">` +
        '<meta name="twitter:card" content="summary_large_image">' +
        '<meta name="twitter:title" content="T">' +
        '<meta name="twitter:description" content="D">' +
        `<meta name="twitter:image" content="${img}">` +
        '</head>',
    )
  })

  it('puts the Twitter tags before robots', async () => {
    const { core } = await world()
    expect(await render(core, 'notFound')).toContain(
      '<meta name="twitter:card" content="summary"><meta name="twitter:title" content="Not found">' +
        '<meta name="robots" content="noindex"></head>',
    )
  })
})

describe('og:type', () => {
  it('gives an article template og:type article and its modified time', async () => {
    const { core, owner } = await world()
    const doc = await post(core, owner)
    const html = await renderPage(core, doc, { state: 'published', page: 1, baseUrl })
    expect(html).toContain('<meta property="og:type" content="article">')
    expect(html).toContain(`<meta property="article:modified_time" content="${doc.updatedAt}">`)
    expect(html).toContain(
      `<meta property="og:url" content="https://example.com/blog/hello"><meta property="article:published_time" content="${doc.publishedAt}"><meta property="article:modified_time" content="${doc.updatedAt}"><meta name="twitter:card"`,
    )
  })

  it('keeps og:type website and no article times by default', async () => {
    const { core } = await world()
    const html = await render(core, 'about')
    expect(html).toContain('<meta property="og:type" content="website">')
    expect(html).not.toContain('article:')
  })
})

describe('defaults global', () => {
  it('uses the draft defaults only in preview', async () => {
    const { core, owner } = await world(headSite(withTemplate))
    await defaults(core, owner, { titleTemplate: '%s ~ Published' })
    await defaults(core, owner, { titleTemplate: '%s ~ Draft' }, false)
    expect(await render(core, 'about')).toContain('<title>About ~ Published</title>')
    expect(await render(core, 'about', { state: 'preview' })).toContain('<title>About ~ Draft</title>')
  })

  it('clears cached pages when the defaults global is published', async () => {
    const { app, core, owner } = await makeApp({ site: headSite(withTemplate), cache: {} })
    try {
      const first = await app.inject('/about')
      expect(first.body).toContain('<title>About | Site</title>')
      expect((await app.inject('/about')).headers['x-inlay-cache']).toBe('hit')
      await defaults(core, owner, { titleTemplate: '%s / New' })
      expect((await app.inject('/about')).body).toContain('<title>About / New</title>')
    } finally {
      await app.close()
    }
  })
})

describe('compatibility', () => {
  it('renders the same head as before plus the Twitter tags, for a site with no new options', async () => {
    const w = await makeCore({ site: webSite })
    await w.core.applyShippedContent()
    const html = await render(w.core, 'home')
    expect(html).toContain(
      '<title>Home</title><link rel="canonical" href="https://example.com/"><link rel="alternate" hreflang="en" href="https://example.com/"><link rel="alternate" hreflang="es" href="https://example.com/es"><link rel="alternate" hreflang="x-default" href="https://example.com/"><meta property="og:type" content="website"><meta property="og:title" content="Home"><meta property="og:url" content="https://example.com/"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="Home"></head>',
    )
  })
})

/** A two-locale site whose `home` (`/`) and `hidden` (no path) pages call `calls(ctx)` while rendering. */
function siteWith(calls: (ctx: RenderContext) => void): SiteDefinition {
  const Home = defineTemplate({
    name: 'home',
    label: 'Home',
    fields: z.object({ title: f.text({ label: 'Title' }), seo: f.seo().optional() }),
    render: ({ fields }, ctx) => {
      calls(ctx)
      return (
        <html>
          <head>
            <meta charset="utf-8" />
          </head>
          <body>
            <h1>{fields.title}</h1>
          </body>
        </html>
      )
    },
  })
  const both = (title: string) => ({ edition: 1, content: { en: { fields: { title } }, es: { fields: { title } } } })
  return defineSite({
    locales: ['en', 'es'],
    defaultLocale: 'en',
    singletons: [
      defineSingleton({ name: 'home', label: 'Home', template: Home, path: '/' }),
      defineSingleton({ name: 'hidden', label: 'Hidden', template: Home, path: null }),
    ],
    content: [defineContent('home', both('Home')), defineContent('hidden', both('Hidden'))],
  })
}

async function renderWith(calls: (ctx: RenderContext) => void, opts: { type?: string; state?: LiveState } = {}) {
  const { core } = await world(siteWith(calls))
  return render(core, opts.type ?? 'home', opts.state ? { state: opts.state } : {})
}

const JSON_LD = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g
const scripts = (html: string) => [...html.matchAll(JSON_LD)].map((m) => m[1]!)
const head = (html: string) => html.slice(0, html.indexOf('</head>'))
const count = (html: string, s: string) => html.split(s).length - 1

describe('ctx.head JSON-LD', () => {
  it('keeps </script> in a JSON-LD string inside its script', async () => {
    const value = { name: '</script><script>alert(1)</script>' }
    const html = await renderWith((ctx) => ctx.head.jsonLd(value))
    expect(count(html, '<script')).toBe(1)
    const [body] = scripts(html)
    expect(body).toBeDefined()
    expect(body).not.toContain('<')
    expect(JSON.parse(body!)).toEqual(value)
    expect(head(html)).toContain('<script type="application/ld+json">')
  })

  it('escapes U+2028, U+2029, <!-- and & in JSON-LD', async () => {
    const value = { text: 'a\u2028b\u2029c <!-- d --> & e', list: ['<', '>', '&'] }
    const html = await renderWith((ctx) => ctx.head.jsonLd(value))
    const [body] = scripts(html)
    for (const c of ['<', '>', '&', '\u2028', '\u2029']) expect(body).not.toContain(c)
    expect(body).toContain('\\u003c!--')
    expect(body).toContain('\\u2028')
    expect(body).toContain('\\u2029')
    expect(body).toContain('\\u0026')
    expect(body).toContain('\\u003e')
    expect(JSON.parse(body!)).toEqual(value)
  })

  it("throws during render for a value JSON can't write", async () => {
    await expect(renderWith((ctx) => ctx.head.jsonLd(undefined))).rejects.toMatchObject({
      code: 'config',
      messageId: 'config.headJsonLd',
    })
    await expect(renderWith((ctx) => ctx.head.jsonLd(() => 1))).rejects.toMatchObject({
      code: 'config',
      messageId: 'config.headJsonLd',
    })
    await expect(renderWith((ctx) => ctx.head.jsonLd(1n))).rejects.toThrow()
  })

  it('never de-duplicates JSON-LD', async () => {
    const html = await renderWith((ctx) => {
      ctx.head.jsonLd({ n: 1 })
      ctx.head.jsonLd({ n: 2 })
      ctx.head.jsonLd({ n: 1 })
    })
    expect(scripts(html).map((b) => JSON.parse(b))).toEqual([{ n: 1 }, { n: 2 }, { n: 1 }])
  })

  it('puts JSON-LD from a section render in the head', async () => {
    const { core, owner } = await world()
    await edit(core, owner, 'about', 'en', (d) => {
      d.slots.faq = { enabled: true, data: { question: 'Why?', answer: 'Because.' } }
    })
    const html = await render(core, 'about')
    expect(html).toContain('<section class="faq">')
    const [body] = scripts(head(html))
    expect(JSON.parse(body!)).toMatchObject({
      '@type': 'FAQPage',
      mainEntity: [{ name: 'Why?', acceptedAnswer: { text: 'Because.' } }],
    })
    expect(html.indexOf('<script type="application/ld+json">')).toBeLessThan(html.indexOf('</head>'))
    expect(await render(core, 'home')).not.toContain('application/ld+json')
  })
})

describe('ctx.head meta', () => {
  it("lets meta({ property: 'og:type' }) replace Inlay's", async () => {
    const html = await renderWith((ctx) => {
      ctx.head.meta({ name: 'author', content: 'Ana' })
      ctx.head.meta({ property: 'og:type', content: 'profile' })
    })
    expect(count(html, 'og:type')).toBe(1)
    expect(html).toContain(
      '<meta name="twitter:title" content="Home"><meta name="author" content="Ana"><meta property="og:type" content="profile"></head>',
    )
  })

  it("keeps the last of the template's own metas", async () => {
    const html = await renderWith((ctx) => {
      ctx.head.meta({ name: 'author', content: 'Ana' })
      ctx.head.meta({ name: 'theme-color', content: '#fff' })
      ctx.head.meta({ name: 'author', content: 'Bo' })
    })
    expect(count(html, '"author"')).toBe(1)
    expect(html).toContain('<meta name="author" content="Bo"><meta name="theme-color" content="#fff"></head>')
  })

  it('keeps noindex in preview despite a template robots meta', async () => {
    const html = await renderWith((ctx) => ctx.head.meta({ name: 'robots', content: 'index, follow' }), {
      state: 'preview',
    })
    expect(html).toContain('<meta name="robots" content="noindex">')
    expect(html).not.toContain('index, follow')
    expect(count(html, '"robots"')).toBe(1)
  })

  it("lets a template robots meta replace Inlay's on a published page", async () => {
    const html = await renderWith((ctx) => ctx.head.meta({ name: 'robots', content: 'noindex, nofollow' }), {
      type: 'hidden',
    })
    expect(count(html, '"robots"')).toBe(1)
    expect(html).toContain('<meta name="robots" content="noindex, nofollow"></head>')
  })

  it('mirrors a template og:image into twitter:image and makes the card summary_large_image', async () => {
    const img = 'https://cdn.example.com/a.png'
    const html = await renderWith((ctx) => ctx.head.meta({ property: 'og:image', content: img }))
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">')
    expect(html).toContain(`<meta name="twitter:image" content="${img}">`)
    expect(count(html, 'og:image')).toBe(1)
  })

  it('lets a template twitter:* tag win over the mirror', async () => {
    const html = await renderWith((ctx) => {
      ctx.head.meta({ name: 'twitter:title', content: 'Tweet' })
      ctx.head.meta({ name: 'twitter:card', content: 'player' })
    })
    expect(count(html, 'twitter:title')).toBe(1)
    expect(count(html, 'twitter:card')).toBe(1)
    expect(html).toContain('<meta name="twitter:title" content="Tweet"><meta name="twitter:card" content="player"></head>')
  })

  it("keeps Inlay's <title> when a template sets og:title", async () => {
    const html = await renderWith((ctx) => ctx.head.meta({ property: 'og:title', content: 'Social' }))
    expect(html).toContain('<title>Home</title>')
    expect(count(html, 'og:title')).toBe(1)
    expect(html).toContain('<meta property="og:title" content="Social">')
    expect(html).toContain('<meta name="twitter:title" content="Social">')
  })

  it('escapes meta values', async () => {
    const html = await renderWith((ctx) => ctx.head.meta({ name: 'x"><script>', content: '"></head><script>' }))
    expect(html).not.toContain('<script>')
    expect(count(html, '</head>')).toBe(1)
  })
})

describe('ctx.head links', () => {
  it('throws on an unsafe link href', async () => {
    await expect(
      renderWith((ctx) => ctx.head.link({ rel: 'icon', href: 'javascript:alert(1)' })),
    ).rejects.toMatchObject({ code: 'config', messageId: 'config.headHref' })
  })

  it("leaves Inlay's hreflang alternates and x-default with an RSS alternate link", async () => {
    const html = await renderWith((ctx) => ctx.head.link({ rel: 'alternate', type: 'application/rss+xml', href: '/feed.xml' }))
    expect(html).toContain('<link rel="alternate" hreflang="en" href="https://example.com/">')
    expect(html).toContain('<link rel="alternate" hreflang="es" href="https://example.com/es">')
    expect(html).toContain('<link rel="alternate" hreflang="x-default" href="https://example.com/">')
    expect(html).toContain('<link rel="alternate" type="application/rss+xml" href="/feed.xml"></head>')
  })

  it("lets a template canonical replace Inlay's", async () => {
    const html = await renderWith((ctx) => {
      ctx.head.link({ rel: 'canonical', href: 'https://other.example.com/a' })
      ctx.head.link({ rel: 'Canonical', href: 'https://other.example.com/b' })
    })
    expect(html.match(/canonical/gi)).toHaveLength(1)
    expect(html).toContain('<link rel="Canonical" href="https://other.example.com/b"></head>')
  })

  it('keeps other template links in call order, once each when identical', async () => {
    const html = await renderWith((ctx) => {
      ctx.head.link({ rel: 'preload', href: '/public/font.woff2', as: 'font', type: 'font/woff2', crossorigin: 'anonymous' })
      ctx.head.link({ rel: 'icon', href: '/public/icon.svg' })
      ctx.head.link({ rel: 'preload', href: '/public/font.woff2', as: 'font', type: 'font/woff2', crossorigin: 'anonymous' })
      ctx.head.link({ rel: 'icon', href: '/public/icon.png', sizes: '32x32' })
    })
    expect(html).toContain(
      '<link rel="preload" type="font/woff2" as="font" crossorigin="anonymous" href="/public/font.woff2">' +
        '<link rel="icon" href="/public/icon.svg">' +
        '<link rel="icon" sizes="32x32" href="/public/icon.png"></head>',
    )
  })

  it('escapes link attributes', async () => {
    const html = await renderWith((ctx) => ctx.head.link({ rel: 'x"><script>', href: '/a"><script>' }))
    expect(html).not.toContain('<script>')
    expect(count(html, '</head>')).toBe(1)
  })
})

describe('ctx.head order', () => {
  it("orders Inlay's tags, then template meta and links, then JSON-LD", async () => {
    const html = await renderWith((ctx) => {
      ctx.head.jsonLd({ a: 1 })
      ctx.head.link({ rel: 'icon', href: '/public/icon.svg' })
      ctx.head.meta({ name: 'author', content: 'Ana' })
    })
    const at = (s: string) => {
      const i = html.indexOf(s)
      expect(i).toBeGreaterThanOrEqual(0)
      return i
    }
    expect(at('<title>')).toBeLessThan(at('rel="canonical"'))
    expect(at('rel="canonical"')).toBeLessThan(at('og:type'))
    expect(at('og:type')).toBeLessThan(at('twitter:card'))
    expect(at('twitter:title')).toBeLessThan(at('name="author"'))
    expect(at('name="author"')).toBeLessThan(at('rel="icon"'))
    expect(at('rel="icon"')).toBeLessThan(at('application/ld+json'))
    expect(at('application/ld+json')).toBeLessThan(at('</head>'))
  })

  it('collects ctx.head in a route render', async () => {
    const template = defineTemplate({
      name: 'feed',
      label: 'Feed',
      fields: z.object({ title: f.text({ label: 'Title' }) }),
      render: ({ fields }, ctx) => {
        ctx.head.jsonLd({ a: 1 })
        return (
          <html>
            <head></head>
            <body>{fields.title}</body>
          </html>
        )
      },
    })
    const { core } = await world()
    const html = await renderTemplateData(core, template, { fields: { title: 'Feed' }, slots: {} }, {
      locale: 'en',
      path: '/feed',
      baseUrl,
    })
    expect(head(html)).toContain('<script type="application/ld+json">{"a":1}</script>')
  })
})
