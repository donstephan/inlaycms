import { f } from '../../src/core/fields/builtins.js'
import type { Core } from '../../src/core/core.js'
import { t } from '../../src/core/messages/index.js'
import type { CollectionDef, SingletonDef, SiteDefinition, TemplateDef } from '../../src/core/registry/define.js'
import { markdownToRichText } from '../../src/core/richtext/markdown.js'
import type { Ctx } from '../../src/core/types.js'
import { Hero, Home, Testimonial, webSite } from '../fixtures/web.js'
import { makeCore } from '../helpers/core.js'
import { mcpClient, type McpTestClient } from '../helpers/mcp.js'

const GUIDE = 'Write in a warm, friendly voice. Never use exclamation marks.'
const HEADLINE_HELP = 'Keep it under ten words.'

/** `webSite` with a guide and some help text, so describe_site and describe_type have something to show. */
const HelpHero = {
  ...Hero,
  help: 'The big banner at the top of the page.',
  schema: Hero.schema.extend({ headline: f.text({ label: 'Headline', help: HEADLINE_HELP }) }),
}
const HelpHome = { ...Home, slots: { ...Home.slots, hero: { block: HelpHero } } } as unknown as TemplateDef
/** Testimonials with a multi-select. */
const TaggedTestimonial = {
  ...Testimonial,
  fields: Testimonial.fields.extend({
    tags: f.multiSelect(['hipaa', 'cmmc', 'soc2'], { label: 'Tags', min: 0, max: 3 }).optional(),
  }),
} as unknown as TemplateDef
const site: SiteDefinition = {
  ...webSite,
  guide: GUIDE,
  singletons: webSite.singletons.map(
    (s): SingletonDef => (s.name === 'home' ? { ...s, help: 'The front page of the site.', template: HelpHome } : s),
  ),
  collections: webSite.collections.map(
    (c): CollectionDef => (c.name === 'testimonials' ? { ...c, template: TaggedTestimonial } : c),
  ),
}

let core: Core
let owner: Ctx
let editor: Ctx
let mcp: McpTestClient

beforeEach(async () => {
  ;({ core, owner, editor } = await makeCore({ site }))
  await core.applyShippedContent()
  mcp = await mcpClient({ core, actor: editor.actor })
})

afterEach(async () => {
  await mcp.close()
})

describe('MCP server', () => {
  it('lists exactly the 24 tools of this phase, each with a description', async () => {
    const { tools } = await mcp.client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        'describe_site', 'describe_type', 'get_document', 'search_entries', 'update_document', 'create_entry',
        'create_translation', 'delete_entry', 'list_pending_changes', 'get_preview_link', 'list_revisions',
        'diff_revisions', 'restore_revision', 'publish', 'unpublish', 'list_media', 'set_media_alt', 'delete_media',
        'upload_media_from_url', 'request_media_upload', 'list_redirects', 'create_redirect', 'delete_redirect',
        'list_gaps',
      ].sort(),
    )
    const readOnly = [
      'describe_site', 'describe_type', 'get_document', 'search_entries', 'list_pending_changes', 'get_preview_link',
      'list_revisions', 'diff_revisions', 'list_media', 'request_media_upload', 'list_redirects', 'list_gaps',
    ]
    const destructive = ['delete_entry', 'unpublish', 'delete_media', 'delete_redirect']
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy()
      expect(tool.description, tool.name).toBeTruthy()
      expect(tool.annotations?.readOnlyHint === true, `${tool.name} readOnlyHint`).toBe(readOnly.includes(tool.name))
      expect(tool.annotations?.destructiveHint === true, `${tool.name} destructiveHint`).toBe(destructive.includes(tool.name))
    }
  })

  it('lists the read tools as read-only, with titles and descriptions', async () => {
    const { tools } = await mcp.client.listTools()
    const read = ['describe_site', 'describe_type', 'get_document', 'search_entries']
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(read))
    for (const tool of tools.filter((t) => read.includes(t.name))) {
      expect(tool.title).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.annotations?.readOnlyHint).toBe(true)
    }
  })

  it('serves legacy clients and clients that declare elicitation', async () => {
    for (const opts of [{ era: 'legacy' as const }, { elicitation: 'accept' as const }]) {
      const other = await mcpClient({ core, actor: editor.actor, ...opts })
      try {
        const { isError, json } = await other.call('describe_site')
        expect(isError).toBe(false)
        expect(json.defaultLocale).toBe('en')
      } finally {
        await other.close()
      }
    }
  })

  it('gives instructions with the site guide', async () => {
    const instructions = mcp.client.getInstructions() ?? ''
    expect(instructions).toContain(t('mcp.instructions'))
    expect(instructions).toContain(t('mcp.siteGuide'))
    expect(instructions).toContain(GUIDE)
  })
})

describe('describe_site', () => {
  it('lists singletons with their URLs and documents, and collections with how they are routed', async () => {
    const { isError, json } = await mcp.call('describe_site')
    expect(isError).toBe(false)
    expect(json.guide).toBe(GUIDE)
    expect(json.locales).toEqual(['en', 'es'])
    expect(json.defaultLocale).toBe('en')
    const home = json.singletons.find((s: { type: string }) => s.type === 'home')
    expect(home.label).toBe('Home')
    expect(home.help).toBe('The front page of the site.')
    expect(home.urls.en).toBe('https://example.com/')
    expect(home.urls.es).toBe('https://example.com/es')
    const homeDoc = await core.findSingleton('home', 'en')
    expect(home.documents.en).toMatchObject({ id: homeDoc!.id, groupId: homeDoc!.groupId, title: 'Home' })
    const homeEs = await core.findSingleton('home', 'es')
    expect(home.documents.es).toEqual({ id: homeEs!.id, groupId: homeDoc!.groupId, title: 'Home', published: homeEs!.publishedRev !== null })
    const testimonials = json.collections.find((c: { type: string }) => c.type === 'testimonials')
    expect(testimonials).toMatchObject({ label: 'Testimonials', routed: false, route: null, customPaths: false })
    const posts = json.collections.find((c: { type: string }) => c.type === 'posts')
    expect(posts).toMatchObject({ routed: true, route: '/blog/:slug', customPaths: true, entryCount: { en: 0, es: 0 } })
    expect(json.globals.map((g: { type: string }) => g.type)).toEqual(['nav'])
  })
})

describe('describe_type', () => {
  it('shows labels, help and the JSON Schema of a type', async () => {
    const { isError, json, text } = await mcp.call('describe_type', { type: 'home' })
    expect(isError).toBe(false)
    expect(json).toMatchObject({ type: 'home', kind: 'singleton', label: 'Home', help: 'The front page of the site.' })
    expect(json.slots).toEqual([
      { key: 'hero', label: 'Hero', help: 'The big banner at the top of the page.', optional: false },
      { key: 'quotes', label: 'Testimonials', help: null, optional: true },
    ])
    expect(json.schema.type).toBe('object')
    expect(text).toContain('Headline')
    expect(text).toContain(HEADLINE_HELP)
  })

  it('reports both the suggested and the maximum length of SEO fields', async () => {
    const { json } = await mcp.call('describe_type', { type: 'home' })
    const description = json.schema.properties.fields.properties.seo.properties.description
    expect(description.maxLength).toBe(500)
    expect(description['x-suggestedLength']).toBe(160)
  })

  it('names the title field of a collection', async () => {
    const { json } = await mcp.call('describe_type', { type: 'testimonials' })
    expect(json).toMatchObject({ kind: 'collection', titleField: 'author' })
  })

  it('refuses an unknown type with a plain sentence', async () => {
    const { isError, text } = await mcp.call('describe_type', { type: 'nope' })
    expect(isError).toBe(true)
    expect(text).toContain(t('error.typeNotFound', { name: 'nope' }))
  })
})

describe('get_document', () => {
  it('finds a singleton by type', async () => {
    const home = (await core.findSingleton('home'))!
    const { isError, json } = await mcp.call('get_document', { type: 'home' })
    expect(isError).toBe(false)
    expect(json).toMatchObject({
      id: home.id,
      groupId: home.groupId,
      type: 'home',
      kind: 'singleton',
      locale: 'en',
      title: 'Home',
      revisionId: home.headRev,
      url: 'https://example.com/',
    })
    expect(json.previewUrl).toMatch(/^https:\/\/example\.com\/_inlay\/preview\?token=/)
    expect(json.content.slots.hero).toEqual({ enabled: true, data: { headline: 'Welcome to Inlay' } })
    expect(json.content.slots.quotes.enabled).toBe(false)
  })

  it('returns rich text as Markdown and resolves inlay: links', async () => {
    const blog = (await core.findSingleton('blog'))!
    const about = (await core.findSingleton('about'))!
    const parsed = markdownToRichText(`We build **websites**. Read [our blog](inlay:document/${blog.groupId}).`)
    if (!parsed.ok) throw new Error('bad markdown')
    await core.patchDraft(about.id, { baseRevisionId: about.headRev, ops: [{ path: ['fields', 'body'], value: parsed.doc }] }, owner)

    const { json } = await mcp.call('get_document', { id: about.id })
    expect(json.content.fields.body).toContain('**websites**')
    expect(json.content.fields.body).toContain(`[our blog](inlay:document/${blog.groupId})`)
    expect(json.links).toEqual([{ uri: `inlay:document/${blog.groupId}`, title: 'Blog', url: 'https://example.com/blog' }])
    expect(json.hasUnpublishedChanges).toBe(true)
  })

  it('finds an entry by type and slug', async () => {
    const created = await core.createEntry(
      'posts',
      { slug: 'hello', fields: { title: 'Hello', date: '2026-01-02', body: markdownDoc('Hi there.') } },
      owner,
    )
    const { isError, json } = await mcp.call('get_document', { type: 'posts', slug: 'hello' })
    expect(isError).toBe(false)
    expect(json).toMatchObject({ id: created.id, kind: 'entry', title: 'Hello', publishedRevisionId: null })
    expect(json.content.slug).toBe('hello')
    expect(json.url).toBeNull()
    expect(json.previewUrl).toMatch(/&path=%2Fblog%2Fhello$/)
  })

  it('gives the address visitors see now, not the draft one', async () => {
    const created = await core.createEntry(
      'posts',
      { slug: 'hello', fields: { title: 'Hello', date: '2026-01-02', body: markdownDoc('Hi there.') } },
      owner,
    )
    await core.publish([created.id], owner)
    const current = (await core.getDocument(created.id))!
    await core.patchDraft(created.id, { baseRevisionId: current.headRev, ops: [{ path: ['slug'], value: 'renamed' }] }, owner)
    const { json } = await mcp.call('get_document', { id: created.id })
    expect(json.url).toBe('https://example.com/blog/hello')
    expect(json.previewUrl).toMatch(/&path=%2Fblog%2Frenamed$/)
  })

  it('reads the version in the language asked for, given the id of another', async () => {
    const home = (await core.findSingleton('home'))!
    const es = (await core.findSingleton('home', 'es'))!
    const { isError, json } = await mcp.call('get_document', { id: home.id, locale: 'es' })
    expect(isError).toBe(false)
    expect(json).toMatchObject({ id: es.id, locale: 'es', groupId: home.groupId })
  })

  it('says so when the id has no version in the language asked for', async () => {
    const about = (await core.findSingleton('about'))!
    const { isError, text } = await mcp.call('get_document', { id: about.id, locale: 'es' })
    expect(isError).toBe(true)
    expect(text.split('\n')[0]).toBe(t('mcp.notTranslated', { locale: 'es' }))
  })

  it('points at ids for a collection without slugs', async () => {
    const { isError, text } = await mcp.call('get_document', { type: 'testimonials', slug: 'alex' })
    expect(isError).toBe(true)
    expect(text.split('\n')[0]).toBe(t('mcp.noSlugs', { type: 'testimonials' }))
  })

  it('says nothing is published when asked for the published version of a draft', async () => {
    await core.createEntry('posts', { slug: 'hello', fields: { title: 'Hello', date: '2026-01-02', body: markdownDoc('Hi.') } }, owner)
    const { isError, json } = await mcp.call('get_document', { type: 'posts', slug: 'hello', state: 'published' })
    expect(isError).toBe(true)
    expect(json.error.code).toBe('not_found')
  })

  it('points at create_translation when a locale has no translation', async () => {
    const { isError, text } = await mcp.call('get_document', { type: 'about', locale: 'es' })
    expect(isError).toBe(true)
    expect(text).toContain('create_translation')
  })

  it('answers an unknown id with a plain sentence', async () => {
    const { isError, text, json } = await mcp.call('get_document', { id: 'nope' })
    expect(isError).toBe(true)
    expect(text.split('\n')[0]).toBe(t('mcp.documentNotFound', { id: 'nope' }))
    expect(text).not.toMatch(/\n\s+at /)
    expect(json.error).toMatchObject({ code: 'not_found', message: t('mcp.documentNotFound', { id: 'nope' }) })
  })
})

describe('a multi-select', () => {
  it('reads and lists a multi-select', async () => {
    const created = await core.createEntry(
      'testimonials',
      { fields: { quote: 'Great.', author: 'Maria', tags: ['soc2', 'hipaa'] } },
      owner,
    )
    const { isError, json } = await mcp.call('get_document', { id: created.id })
    expect(isError).toBe(false)
    expect(json.content.fields.tags).toEqual(['hipaa', 'soc2'])

    const described = await mcp.call('describe_type', { type: 'testimonials' })
    expect(described.json.schema.properties.fields.properties.tags).toEqual({
      type: 'array',
      items: { enum: ['hipaa', 'cmmc', 'soc2'] },
      uniqueItems: true,
      minItems: 0,
      maxItems: 3,
      title: 'Tags',
    })
  })
})

describe('search_entries', () => {
  it('finds entries ignoring accents', async () => {
    const maria = await core.createEntry('testimonials', { fields: { author: 'María López', quote: 'Great work' } }, owner)
    await core.createEntry('testimonials', { fields: { author: 'Sam Smith', quote: 'Lovely' } }, owner)
    const { isError, json } = await mcp.call('search_entries', { collection: 'testimonials', query: 'maria' })
    expect(isError).toBe(false)
    expect(json.entries).toEqual([
      {
        id: maria.id,
        groupId: maria.groupId,
        title: 'María López',
        locale: 'en',
        slug: null,
        published: false,
        hasUnpublishedChanges: true,
        snippet: expect.any(String),
      },
    ])
  })

  it('lists every entry without a query', async () => {
    await core.createEntry('testimonials', { fields: { author: 'María López', quote: 'Great work' } }, owner)
    await core.createEntry('testimonials', { fields: { author: 'Sam Smith', quote: 'Lovely' } }, owner)
    const { json } = await mcp.call('search_entries', { collection: 'testimonials' })
    expect(json.entries.map((e: { title: string }) => e.title).sort()).toEqual(['María López', 'Sam Smith'])
  })

  it('refuses a type that is not a collection', async () => {
    const { isError } = await mcp.call('search_entries', { collection: 'home' })
    expect(isError).toBe(true)
  })
})

function markdownDoc(markdown: string) {
  const parsed = markdownToRichText(markdown)
  if (!parsed.ok) throw new Error('bad markdown')
  return parsed.doc
}
