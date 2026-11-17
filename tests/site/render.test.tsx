import { renderPage, renderTemplateData } from '../../src/adapters/site/render.js'
import type { Core } from '../../src/core/core.js'
import { InlayError } from '../../src/core/errors.js'
import { defineSingleton, defineSite, defineTemplate } from '../../src/core/registry/define.js'
import type { Ctx, DocumentData, LiveDocument, LiveState } from '../../src/core/types.js'
import { png } from '../fixtures/media.js'
import { markdownToInlineText } from '../../src/core/richtext/inline.js'
import type { RenderContext } from '../../src/core/registry/render.js'
import type { RichTextDoc } from '../../src/core/richtext/schema.js'
import { plainText } from '../../src/site.js'
import type { Renderable } from '../../src/jsx/html.js'
import { Page, webSite } from '../fixtures/web.js'
import { makeCore } from '../helpers/core.js'

const baseUrl = 'https://example.com'

const rt = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

async function world(site = webSite) {
  const w = await makeCore({ site, media: true })
  const { media } = await w.core.addMedia({ data: await png(800, 400), filename: 'team.png' }, w.owner)
  await w.core.setMediaAlt(media.id, 'Team', w.owner)
  await w.core.applyShippedContent()
  return { ...w, mediaId: media.id }
}

async function edit(
  core: Core,
  ctx: Ctx,
  type: string,
  locale: string,
  change: (data: DocumentData) => void,
  publish = true,
) {
  const summary = await core.findSingleton(type, locale)
  const view = await core.getDocument(summary!.id)
  const data = structuredClone(view!.data)
  change(data)
  await core.saveDraft(view!.id, { baseRevisionId: view!.headRev, data }, ctx)
  if (publish) await core.publish([view!.id], ctx)
}

async function render(core: Core, type: string, locale = 'en', opts: { state?: LiveState; page?: number } = {}) {
  const state = opts.state ?? 'published'
  const doc = await core.liveSingleton(type, locale, { state })
  if (!doc) throw new Error(`no live ${type} in ${locale}`)
  return renderPage(core, doc, { state, page: opts.page ?? 1, baseUrl })
}

const hero = (data: DocumentData) => data.slots.hero!.data

async function entry(core: Core, ctx: Ctx, type: string, input: Parameters<Core['createEntry']>[1], publish = true) {
  const view = await core.createEntry(type, input, ctx)
  if (publish) await core.publish([view.id], ctx)
  return view
}

describe('renderPage: home', () => {
  it('renders a full document with the hero', async () => {
    const { core } = await world()
    const html = await render(core, 'home')
    expect(html.startsWith('<!doctype html><html lang="en"><head><meta charset="utf-8">')).toBe(true)
    expect(html).toContain('</head><body><nav>')
    expect(html).toContain('<h1>Welcome to Inlay</h1>')
    expect(html).not.toContain('class="quotes"')
  })

  it('escapes content written into text, link text and alt text', async () => {
    const { core, owner, mediaId } = await world()
    await edit(core, owner, 'home', 'en', (d) => {
      hero(d).headline = '<script>alert(1)</script>'
      hero(d).cta = { url: '/x', text: '"><b>x' }
      hero(d).image = { media: mediaId, alt: 'Say "cheese"' }
    })
    const html = await render(core, 'home')
    expect(html).toContain('<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('<a class="button" href="/x">&quot;&gt;&lt;b&gt;x</a>')
    expect(html).toContain('alt="Say &quot;cheese&quot;"')
  })

  it("resolves an image with the media's default alt and its variants", async () => {
    const { core, owner, mediaId } = await world()
    await edit(core, owner, 'home', 'en', (d) => {
      hero(d).image = { media: mediaId }
    })
    const html = await render(core, 'home')
    const img = /<img [^>]*>/.exec(html)?.[0] ?? ''
    expect(img).toContain('alt="Team"')
    expect(img).toContain(`srcset="/media/${mediaId}/320.webp 320w, /media/${mediaId}/640.webp 640w"`)
    expect(img).toContain(`src="/media/${mediaId}/`)
    expect(img).toContain('width="800" height="400"')
  })

  it('links to documents in the requested locale, and leaves out links that are not live', async () => {
    const { core, owner } = await world()
    const about = await core.findSingleton('about')
    for (const locale of ['en', 'es']) {
      await edit(core, owner, 'home', locale, (d) => {
        hero(d).cta = { document: about!.groupId, text: 'About' }
      })
    }
    expect(await render(core, 'home', 'en')).toContain('<a class="button" href="/about">About</a>')
    expect(await render(core, 'home', 'es')).toContain('<a class="button" href="/es/acerca">About</a>')

    const draft = await entry(core, owner, 'posts', { slug: 'draft', fields: { title: 'Draft', date: '2026-01-01', body: rt('x') } }, false)
    await edit(core, owner, 'home', 'en', (d) => {
      hero(d).cta = { document: draft.groupId }
    })
    expect(await render(core, 'home')).not.toContain('class="button"')
    expect(await render(core, 'home', 'en', { state: 'preview' })).toContain('<a class="button" href="/blog/draft">Draft</a>')
  })

  it('renders only live referenced entries, and drafts too in preview', async () => {
    const { core, db, owner } = await world()
    const live = await entry(core, owner, 'testimonials', { fields: { quote: 'Great', author: 'Ana' } })
    const draft = await entry(core, owner, 'testimonials', { fields: { quote: 'Good', author: 'Ben' } }, false)
    const gone = await entry(core, owner, 'testimonials', { fields: { quote: 'Fine', author: 'Cy' } })
    const incomplete = await entry(core, owner, 'testimonials', { fields: { quote: 'Meh' } }, false)
    await edit(core, owner, 'home', 'en', (d) => {
      d.slots.quotes = { enabled: true, data: { items: [draft.groupId, live.groupId, gone.groupId, incomplete.groupId] } }
    })
    await db
      .updateTable('documents')
      .set({ deleted_at: '2026-06-01T00:00:00.000Z', published_rev: null })
      .where('group_id', '=', gone.groupId)
      .execute()

    const published = await render(core, 'home')
    expect(published).toContain('<section class="quotes"><blockquote>Great<cite>Ana</cite></blockquote></section>')

    const preview = await render(core, 'home', 'en', { state: 'preview' })
    expect(preview).toContain(
      '<section class="quotes"><blockquote>Good<cite>Ben</cite></blockquote><blockquote>Great<cite>Ana</cite></blockquote></section>',
    )
    expect(preview).not.toContain('Fine')
    expect(preview).not.toContain('Meh')
  })

  it('shows the published nav in preview while its draft is incomplete', async () => {
    const { core, owner } = await world()
    await edit(
      core,
      owner,
      'nav',
      'en',
      (d) => {
        d.fields.links = [{ link: { url: '/new', text: 'New' } }, {}]
      },
      false,
    )
    const preview = await render(core, 'home', 'en', { state: 'preview' })
    expect(preview).toContain('<nav><a href="/blog">Blog</a></nav>')
    expect(preview).not.toContain('New')
  })

  it('takes the nav from the default-locale global when a translation is missing', async () => {
    const { core } = await world()
    const html = await render(core, 'home', 'es')
    expect(html).toContain('<html lang="es">')
    expect(html).toContain('<h1>Bienvenido a Inlay</h1>')
    expect(html).toContain('<nav><a href="/blog">Blog</a></nav>')
  })
})

describe('renderPage: other templates', () => {
  it('renders rich text', async () => {
    const { core } = await world()
    expect(await render(core, 'about')).toContain('<article><h1>About us</h1><p>We build <strong>websites</strong>.</p></article>')
  })

  it('paginates a query', async () => {
    const { core, owner } = await world()
    for (const [slug, date] of [['jan', '2026-01-01'], ['mar', '2026-03-01'], ['feb', '2026-02-01']] as const) {
      await entry(core, owner, 'posts', { slug, fields: { title: `Post ${slug}`, date, body: rt(slug) } })
    }
    const first = await render(core, 'blog', 'en', { page: 1 })
    expect(first).toContain(
      '<ul class="posts"><li><a href="/blog/mar">Post mar</a></li><li><a href="/blog/feb">Post feb</a></li></ul><p class="pages">Page 1 of 2</p>',
    )
    const second = await render(core, 'blog', 'en', { page: 2 })
    expect(second).toContain('<ul class="posts"><li><a href="/blog/jan">Post jan</a></li></ul><p class="pages">Page 2 of 2</p>')
  })

  it('throws a config error for a template without render', async () => {
    const { core, owner } = await world()
    const t = await entry(core, owner, 'testimonials', { fields: { quote: 'Great', author: 'Ana' } })
    const docs = await core.liveDocuments([t.groupId], 'en')
    const doc = docs.get(t.groupId) as LiveDocument
    const err = await renderPage(core, doc, { state: 'published', page: 1, baseUrl }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InlayError)
    expect(err).toMatchObject({ code: 'config', messageId: 'config.renderMissing', params: { name: 'testimonial' } })
  })

  it('passes on errors thrown by a template', async () => {
    const Broken = defineTemplate({
      ...Page,
      render: () => {
        throw new Error('boom')
      },
    })
    const site = defineSite({
      ...webSite,
      singletons: webSite.singletons.map((s) => (s.name === 'about' ? defineSingleton({ ...s, template: Broken }) : s)),
    })
    const { core } = await world(site)
    await expect(render(core, 'about')).rejects.toThrow('boom')
  })
})

describe('inline text', () => {
  const inlineDoc = (markdown: string): RichTextDoc => {
    const r = markdownToInlineText(markdown)
    if (!r.ok) throw new Error('bad markdown')
    return r.doc
  }
  const twoParagraphs: RichTextDoc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
    ],
  }

  async function renderWith(
    body: (ctx: RenderContext) => Renderable,
    prepare?: (w: Awaited<ReturnType<typeof world>>) => Promise<void>,
  ) {
    const T = defineTemplate({ ...Page, render: (_props, ctx) => body(ctx) })
    const site = defineSite({
      ...webSite,
      singletons: webSite.singletons.map((s) => (s.name === 'about' ? defineSingleton({ ...s, template: T }) : s)),
    })
    const w = await world(site)
    await prepare?.(w)
    return render(w.core, 'about')
  }

  it('renders inline text without a <p>', async () => {
    const html = await renderWith((ctx) => <h1>{ctx.inline(inlineDoc('**Big** news'))}</h1>)
    expect(html).toContain('<h1><strong>Big</strong> news</h1>')
  })

  it('resolves an internal link and escapes a plain string', async () => {
    let target: string | undefined
    const linked: RichTextDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Blog', marks: [{ type: 'link', attrs: { document: '' } }] }],
        },
      ],
    }
    const html = await renderWith(
      (ctx) => (
        <p>
          {ctx.inline(linked)}|{ctx.inline('<b>')}|{ctx.inline(null)}|{ctx.inline(undefined)}
        </p>
      ),
      async ({ core, owner }) => {
        target = (await core.findSingleton('blog'))!.groupId
        const mark = (linked.content[0] as { content: Array<{ marks: Array<{ attrs: unknown }> }> }).content[0]!.marks[0]!
        mark.attrs = { document: target }
        await edit(core, owner, 'about', 'en', (d) => {
          const body = structuredClone(linked)
          ;(d.fields as Record<string, unknown>).body = body
        })
      },
    )
    expect(target).toBeDefined()
    expect(html).toContain('<p><a href="/blog">Blog</a>|&lt;b&gt;||</p>')
  })

  it('renders only the first paragraph of a doc that holds more', async () => {
    const html = await renderWith((ctx) => <h1>{ctx.inline(twoParagraphs)}</h1>)
    expect(html).toContain('<h1>first</h1>')
    expect(html).not.toContain('second')
  })

  it('renders inline text with its <p> through ctx.richText', async () => {
    const html = await renderWith((ctx) => <div>{ctx.richText(inlineDoc('**Big** news'))}</div>)
    expect(html).toContain('<div><p><strong>Big</strong> news</p></div>')
  })

  it('gives the plain text through plainText', () => {
    expect(plainText(inlineDoc('**Big** news'))).toBe('Big news')
    expect(plainText(null)).toBe('')
  })
})

describe('publishedAt', () => {
  const Dated = defineTemplate({ ...Page, render: ({ page }) => <p>[{String(page.publishedAt)}]</p> })
  const datedSite = defineSite({
    ...webSite,
    singletons: webSite.singletons.map((s) => (s.name === 'about' ? defineSingleton({ ...s, template: Dated }) : s)),
  })

  it('gives the page its publishedAt', async () => {
    const { core, db } = await world(datedSite)
    const about = await core.findSingleton('about')
    const row = await db.selectFrom('documents').select('first_published_at').where('id', '=', about!.id).executeTakeFirstOrThrow()
    expect(row.first_published_at).not.toBeNull()
    expect(await render(core, 'about')).toContain(`<p>[${row.first_published_at}]</p>`)
  })

  it("gives a route's template data page publishedAt null", async () => {
    const { core } = await world()
    const html = await renderTemplateData(core, Dated, { fields: { title: 'Feed' }, slots: {} }, {
      locale: 'en',
      path: '/feed',
      baseUrl,
    })
    expect(html).toContain('<p>[null]</p>')
  })
})
