import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import {
  agentLinks,
  agentRefsNeeded,
  contentFromAgent,
  fromAgent,
  parsePath,
  toAgent,
} from '../../src/core/agent/format.js'
import { agentTypeSchema } from '../../src/core/agent/schema.js'
import { applyPatch } from '../../src/core/content/patch.js'
import { f } from '../../src/core/fields/builtins.js'
import type { AgentRefs } from '../../src/core/fields/define.js'
import { t } from '../../src/core/messages/index.js'
import { defineCollection, defineSingleton, defineSite, defineTemplate } from '../../src/core/registry/define.js'
import { buildRegistry } from '../../src/core/registry/registry.js'
import { markdownToRichText } from '../../src/core/richtext/markdown.js'
import type { RichTextDoc } from '../../src/core/richtext/schema.js'
import type { DocumentData, MediaStatus } from '../../src/core/types.js'
import { site } from '../fixtures/site.js'
import { webSite } from '../fixtures/web.js'

const IMG = 'a'.repeat(64)
const GONE = 'b'.repeat(64)
const LOST = 'c'.repeat(64)
const QUOTE = '0b5c1a52-4a2f-4d3e-9c1b-6f1e2d3c4b5a'
const ABOUT = '1c6d2b63-5b3f-4e4f-8d2c-7f2e3d4c5b6a'
const GHOST = '2d7e3c74-6c4f-4f5f-9e3d-8f3e4d5c6b7a'

const refs: AgentRefs = {
  document(groupId) {
    if (groupId === QUOTE) return { title: 'María López', url: null }
    if (groupId === ABOUT) return { title: 'About us', url: '/about' }
    return null
  },
  media(id): MediaStatus {
    if (id === IMG) {
      return {
        status: 'present',
        media: {
          id,
          filename: 'hero.jpg',
          mime: 'image/jpeg',
          size: 10,
          width: 4,
          height: 3,
          defaultAlt: null,
          createdBy: 'user-owner',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }
    }
    if (id === GONE) return { status: 'deleted', filename: 'old.png', deletedAt: '2026-02-03T00:00:00.000Z' }
    return { status: 'unknown' }
  },
  mediaUrl: (id) => `https://example.com/media/${id}`,
}

const doc = (markdown: string): RichTextDoc => {
  const result = markdownToRichText(markdown)
  if (!result.ok) throw new Error(JSON.stringify(result.problems))
  return result.doc
}

const Spotlight = defineTemplate({
  name: 'spotlight',
  label: 'Spotlight',
  fields: z.object({
    featured: f.ref('testimonials', { label: 'Featured quote', help: 'The one to show first.' }).optional(),
    intro: f.richText({ label: 'Intro', features: ['link', 'bold', 'heading'], headings: [2, 3], help: 'Two sentences at most.' }).optional(),
    note: f.richText({ label: 'Note', features: [] }).optional(),
  }),
})

const localSite = defineSite({
  locales: ['en'],
  defaultLocale: 'en',
  singletons: [
    defineSingleton({ name: 'spotlight', label: 'Spotlight', template: Spotlight, path: '/spotlight' }),
  ],
  collections: [
    defineCollection({
      name: 'testimonials',
      label: 'Client quotes',
      template: defineTemplate({ name: 'quote', fields: z.object({ title: f.text({ label: 'Title' }) }) }),
    }),
  ],
})

const registry = buildRegistry(site)
const web = buildRegistry(webSite)
const local = buildRegistry(localSite)

const home: DocumentData = {
  fields: { title: 'Home', seo: { title: 'Welcome', image: { media: GONE } } },
  slots: {
    hero: {
      enabled: true,
      data: {
        headline: 'Welcome',
        image: { media: IMG, alt: 'A view' },
        cta: { document: ABOUT, text: 'About' },
        variant: 'dark',
      },
    },
    features: { enabled: true, data: { cards: [{ title: 'Fast', body: 'Quick.' }, { title: 'Safe' }] } },
    quotes: { enabled: true, data: { heading: 'Kind words', items: [QUOTE] } },
  },
}

const about: DocumentData = {
  fields: {
    title: 'About us',
    body: doc(`## Hello\n\nSee [us](inlay:document/${ABOUT}), [a ghost](inlay:document/${GHOST}) and ![pic](inlay:media/${IMG}).\n\n![gone](inlay:media/${GONE})`),
  },
  slots: {},
}

const nav: DocumentData = {
  fields: { links: [{ link: { url: '/blog', text: 'Blog' } }, { link: { document: ABOUT } }] },
  slots: {},
}

const post: DocumentData = {
  slug: 'hello',
  path: '/hello-world',
  fields: { title: 'Hello', date: '2026-01-02', body: doc('Just **text**.') },
  slots: {},
}

describe('toAgent', () => {
  const agent = toAgent(registry, 'home', home, refs)

  it('reads an image with its filename and url', () => {
    expect(agent.slots.hero!.data.image).toEqual({
      id: IMG,
      filename: 'hero.jpg',
      alt: 'A view',
      url: `https://example.com/media/${IMG}`,
    })
  })

  it('reads refs as ids with titles', () => {
    expect(agent.slots.quotes!.data.items).toEqual([{ id: QUOTE, title: 'María López' }])
    expect(agent.slots.quotes!.enabled).toBe(true)
  })

  it('reads a document link with its title and url', () => {
    expect(agent.slots.hero!.data.cta).toEqual({
      document: { id: ABOUT, title: 'About us', url: '/about' },
      text: 'About',
    })
  })

  it('marks a deleted image as missing, naming its file', () => {
    const image = (agent.fields.seo as { image: { id: string; missing: string } }).image
    expect(image.id).toBe(GONE)
    expect(image.missing).toContain('old.png')
  })

  it('marks an unknown image and a missing entry as missing', () => {
    const lost = toAgent(registry, 'testimonials', { fields: { quote: 'q', author: 'a', photo: { media: LOST } }, slots: {} }, refs)
    expect((lost.fields.photo as { missing?: string }).missing).toEqual(expect.any(String))
    const spot = toAgent(local, 'spotlight', { fields: { featured: GHOST }, slots: {} }, refs)
    expect(spot.fields.featured).toEqual({ id: GHOST, missing: expect.any(String) })
  })

  it('reads rich text as Markdown', () => {
    const page = toAgent(web, 'about', about, refs)
    expect(typeof page.fields.body).toBe('string')
    expect(page.fields.body).toContain('## Hello')
    expect(page.fields.body).toContain(`inlay:document/${ABOUT}`)
  })

  it('keeps slug and path', () => {
    const page = toAgent(web, 'posts', post, refs)
    expect(page.slug).toBe('hello')
    expect(page.path).toBe('/hello-world')
  })
})

describe('round trip', () => {
  const cases: Array<[string, typeof registry, string, DocumentData]> = [
    ['home', registry, 'home', home],
    ['about', web, 'about', about],
    ['nav', web, 'nav', nav],
    ['post', web, 'posts', post],
  ]

  for (const [name, reg, type, data] of cases) {
    it(`gives back the stored data for ${name}`, () => {
      const agent = toAgent(reg, type, data, refs)
      const ops = []
      const parts: Array<[string, unknown]> = [['fields', agent.fields]]
      for (const [key, slot] of Object.entries(agent.slots)) parts.push([`slots.${key}`, slot])
      if (agent.slug !== undefined) parts.push(['slug', agent.slug])
      if (agent.path !== undefined) parts.push(['path', agent.path])
      for (const [path, value] of parts) {
        const segments = parsePath(path)!
        const result = fromAgent(reg, type, segments, value)
        if (!result.ok) throw new Error(JSON.stringify(result.issues))
        ops.push({ path: segments, value: result.value })
      }
      const patched = applyPatch(reg, type, data, ops)
      if (!patched.ok) throw new Error(JSON.stringify(patched.issues))
      expect(isDeepStrictEqual(patched.data, data)).toBe(true)
    })
  }

  it('gives back the stored data through contentFromAgent', () => {
    const result = contentFromAgent(registry, 'home', toAgent(registry, 'home', home, refs))
    if (!result.ok) throw new Error(JSON.stringify(result.issues))
    expect(result.content.fields).toEqual(home.fields)
    expect(result.content.slots!.hero).toEqual(home.slots.hero!.data)
    expect(result.content.slots!.quotes).toEqual(home.slots.quotes!.data)
  })
})

describe('fromAgent', () => {
  it('reports Markdown problems with line numbers and the field', () => {
    const result = fromAgent(web, 'about', ['fields', 'body'], '# Title\n\n---')
    expect(result.ok).toBe(false)
    if (result.ok) return
    const messages = result.issues.map((i) => i.message)
    expect(messages.some((m) => m.includes('Line 1'))).toBe(true)
    expect(messages.some((m) => m.includes('Line 3'))).toBe(true)
    for (const issue of result.issues) {
      expect(issue.path).toEqual(['fields', 'body'])
      expect(issue.labels).toEqual(['Body'])
      expect(issue.code).toBe('invalid')
      expect(issue.message).toMatch(/^Body: /)
    }
  })

  it('reports Markdown problems deep in a value, with the full path', () => {
    const result = fromAgent(web, 'about', ['fields'], { title: 'x', body: '---' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]!.path).toEqual(['fields', 'body'])
  })

  it('turns Markdown into rich text', () => {
    const result = fromAgent(web, 'about', ['fields', 'body'], '## Hi\n\nThere.')
    expect(result).toEqual({ ok: true, value: doc('## Hi\n\nThere.') })
  })

  it('accepts refs as ids, { id } and what it read', () => {
    const result = fromAgent(registry, 'home', ['slots', 'quotes', 'data', 'items'], [
      QUOTE,
      { id: QUOTE },
      { id: QUOTE, title: 'María López' },
    ])
    expect(result).toEqual({ ok: true, value: [QUOTE, QUOTE, QUOTE] })
    expect(fromAgent(registry, 'home', ['slots', 'quotes', 'data', 'items', 0], { id: QUOTE })).toEqual({
      ok: true,
      value: QUOTE,
    })
    expect(fromAgent(local, 'spotlight', ['fields', 'featured'], QUOTE)).toEqual({ ok: true, value: QUOTE })
    expect(fromAgent(local, 'spotlight', ['fields', 'featured'], { id: QUOTE })).toEqual({ ok: true, value: QUOTE })
  })

  it('accepts images as { id, alt } or the stored form', () => {
    const at = ['slots', 'hero', 'data', 'image']
    expect(fromAgent(registry, 'home', at, { id: IMG, alt: 'x' })).toEqual({ ok: true, value: { media: IMG, alt: 'x' } })
    expect(fromAgent(registry, 'home', at, { id: IMG })).toEqual({ ok: true, value: { media: IMG } })
    expect(fromAgent(registry, 'home', at, { media: IMG, alt: 'y' })).toEqual({ ok: true, value: { media: IMG, alt: 'y' } })
  })

  it('accepts a link to a document by id or { id }', () => {
    const at = ['slots', 'hero', 'data', 'cta']
    expect(fromAgent(registry, 'home', at, { document: ABOUT, text: 'Go' })).toEqual({
      ok: true,
      value: { document: ABOUT, text: 'Go' },
    })
    expect(fromAgent(registry, 'home', at, { document: { id: ABOUT } })).toEqual({ ok: true, value: { document: ABOUT } })
    expect(fromAgent(registry, 'home', at, { url: '/x' })).toEqual({ ok: true, value: { url: '/x' } })
  })

  it('leaves values at unknown paths unchanged', () => {
    expect(fromAgent(registry, 'home', ['slots', 'hero', 'data', 'headlin'], { id: 1 })).toEqual({
      ok: true,
      value: { id: 1 },
    })
  })
})

describe('parsePath', () => {
  it('splits on dots and reads indexes as numbers', () => {
    expect(parsePath('fields.faq.0.question')).toEqual(['fields', 'faq', 0, 'question'])
    expect(parsePath('slots.hero.data.headline')).toEqual(['slots', 'hero', 'data', 'headline'])
  })

  it('rejects empty segments', () => {
    expect(parsePath('fields..x')).toBeNull()
    expect(parsePath('')).toBeNull()
    expect(parsePath('fields.')).toBeNull()
  })
})

describe('agentRefsNeeded and agentLinks', () => {
  it('lists the documents and media to look up', () => {
    const needed = agentRefsNeeded(registry, 'home', home)
    expect(needed.documents.sort()).toEqual([QUOTE, ABOUT].sort())
    expect(needed.media.sort()).toEqual([IMG, GONE].sort())
  })

  it('lists every inlay: URI in rich text with what it points to', () => {
    const links = agentLinks(web, 'about', about, refs)
    expect(links).toHaveLength(4)
    expect(links).toContainEqual({ uri: `inlay:document/${ABOUT}`, title: 'About us', url: '/about' })
    expect(links).toContainEqual({ uri: `inlay:document/${GHOST}`, missing: expect.any(String) })
    expect(links).toContainEqual({
      uri: `inlay:media/${IMG}`,
      filename: 'hero.jpg',
      url: `https://example.com/media/${IMG}`,
    })
    expect(links).toContainEqual({ uri: `inlay:media/${GONE}`, filename: 'old.png', missing: expect.stringContaining('old.png') })
  })
})

describe('agentTypeSchema', () => {
  const schema = agentTypeSchema(registry, 'home') as any
  const slots = schema.properties.slots.properties
  const hero = slots.hero.properties.data.properties

  it('is draft 2020-12', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
  })

  it('labels fields with their help', () => {
    expect(hero.headline.title).toBe('Headline')
    expect(hero.headline.description).toBe('Keep it under 8 words.')
    expect(schema.properties.fields.properties.title.title).toBe('Title')
  })

  it('reports a suggested length apart from maxLength', () => {
    const title = schema.properties.fields.properties.seo.properties.title
    expect(title.maxLength).toBe(300)
    expect(title['x-suggestedLength']).toBe(70)
    expect(title.description).toContain(t('agent.suggestedLength', { n: 70 }))
  })

  it('marks settings', () => {
    expect(hero.variant.enum).toEqual(['light', 'dark'])
    expect(hero.variant['x-setting']).toBe(true)
    expect(hero.variant.description).toContain(t('agent.setting'))
    expect(hero.headline['x-setting']).toBeUndefined()
  })

  it('uses the codec schema for images', () => {
    expect(hero.image.properties.id).toBeDefined()
    expect(hero.image.required ?? []).not.toContain('media')
    expect(hero.image.title).toBe('Image')
  })

  it('says which collection a ref points into', () => {
    const items = slots.quotes.properties.data.properties.items
    expect(items.title).toBe('Testimonials')
    expect(items.description).toContain(t('agent.refTarget', { label: 'Testimonials' }))
    expect(items.type).toBe('array')
    const featured = (agentTypeSchema(local, 'spotlight') as any).properties.fields.properties.featured
    expect(featured.description).toContain('Client quotes')
    expect(featured.description).toContain('The one to show first.')
  })

  it('gives date and datetime fields their JSON Schema format', () => {
    const Event = defineTemplate({
      name: 'event',
      label: 'Event',
      fields: z.object({ day: f.date({ label: 'Day' }), starts: f.datetime({ label: 'Starts' }) }),
    })
    const local = buildRegistry(
      defineSite({
        locales: ['en'],
        defaultLocale: 'en',
        singletons: [defineSingleton({ name: 'event', label: 'Event', template: Event, path: '/event' })],
      }),
    )
    const props = (agentTypeSchema(local, 'event') as any).properties.fields.properties
    expect(props.day).toMatchObject({ type: 'string', format: 'date', title: 'Day' })
    expect(props.day.description).toContain('YYYY-MM-DD')
    expect(props.starts).toMatchObject({ type: 'string', format: 'date-time', title: 'Starts' })
  })

  it('describes rich text as Markdown, with what each field allows, then its help', () => {
    const body = (agentTypeSchema(web, 'about') as any).properties.fields.properties.body
    expect(body.type).toBe('string')
    expect(body.title).toBe('Body')
    expect(body.description).toContain(t('richtext.feature.orderedList'))

    const fields = (agentTypeSchema(local, 'spotlight') as any).properties.fields.properties
    const allowed = [
      t('agent.richTextHeadings', { levels: '2, 3' }),
      t('richtext.feature.bold'),
      t('richtext.feature.link'),
    ].join(', ')
    expect(fields.intro.description).toBe(`${t('agent.richText', { features: allowed })} Two sentences at most.`)
    expect(fields.intro.description).not.toContain(t('richtext.feature.image'))
    expect(fields.note.description).toBe(t('agent.richTextNone'))
  })

  it('gives slots their label and help, with enabled only for optional slots', () => {
    expect(slots.hero.title).toBe('Hero')
    expect(slots.hero.description).toBe('The large banner at the top of the page.')
    expect(slots.hero.properties.enabled).toBeUndefined()
    expect(slots.quotes.properties.enabled).toBeDefined()
    expect(slots.quotes.title).toBe('Testimonials')
  })

  it('applies a label once per property', () => {
    const text = JSON.stringify(hero.headline)
    expect(text.split('"Headline"').length - 1).toBe(1)
  })

  it('offers slug and path only where the type has them', () => {
    expect(schema.properties.slug).toBeUndefined()
    const posts = agentTypeSchema(web, 'posts') as any
    expect(posts.properties.slug).toBeDefined()
    expect(posts.properties.path).toBeDefined()
  })
})

describe('contentFromAgent', () => {
  it('turns a switched-off slot into false', () => {
    const result = contentFromAgent(registry, 'home', { slots: { quotes: { enabled: false } } })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.content.slots!.quotes).toBe(false)
  })

  it('reports problems with document paths', () => {
    const result = contentFromAgent(web, 'about', { fields: { title: 'x', body: '# Big' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]!.path).toEqual(['fields', 'body'])
  })
})
