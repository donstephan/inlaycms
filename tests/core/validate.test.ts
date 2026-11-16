import { t } from '../../src/core/messages/index.js'
import {
  docLabels,
  documentRefs,
  documentSchema,
  normalizeContent,
} from '../../src/core/content/schema.js'
import { validateContent } from '../../src/core/content/validate.js'
import { buildRegistry } from '../../src/core/registry/registry.js'
import type { DocumentData } from '../../src/core/types.js'
import { site } from '../fixtures/site.js'

const registry = buildRegistry(site)
const uuid = (n: number) => `6f1c2b1e-8a3d-4b7e-9c2a-${String(n).padStart(12, '0')}`
const sha = 'a'.repeat(64)

function home(overrides: Partial<DocumentData['slots']> = {}): DocumentData {
  return {
    fields: { title: 'Home' },
    slots: {
      hero: { enabled: true, data: { headline: 'Welcome' } },
      features: { enabled: true, data: { cards: [{ title: 'Fast' }] } },
      quotes: { enabled: false, data: {} },
      ...overrides,
    },
  }
}

const post = (extra: Record<string, unknown> = {}): DocumentData => ({
  slug: 'hello',
  fields: { title: 'Hello', date: '2026-01-02', body: 'Text' },
  slots: {},
  ...extra,
})

function issuesOf(type: string, data: unknown, level: 'draft' | 'strict') {
  const result = validateContent(registry, type, data, level)
  return result.ok ? [] : result.issues
}

describe('validateContent', () => {
  it('accepts valid content and fills defaults', () => {
    const result = validateContent(registry, 'home', home(), 'strict')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.slots.hero?.data.variant).toBe('light')
  })

  it('names a missing field by its labels', () => {
    const data = home({ hero: { enabled: true, data: {} } })
    expect(issuesOf('home', data, 'strict')).toEqual([
      {
        path: ['slots', 'hero', 'data', 'headline'],
        labels: ['Hero', 'Headline'],
        code: 'required',
        message: 'Hero → Headline is required.',
      },
    ])
    expect(validateContent(registry, 'home', data, 'draft').ok).toBe(true)
  })

  it('treats a blank text as missing', () => {
    const [issue] = issuesOf('home', home({ hero: { enabled: true, data: { headline: '   ' } } }), 'strict')
    expect(issue).toMatchObject({ code: 'required', labels: ['Hero', 'Headline'] })
  })

  it('reports a required field set to null as required at strict level only', () => {
    const data = home({ hero: { enabled: true, data: { headline: null } } })
    expect(issuesOf('home', data, 'strict')).toMatchObject([
      { path: ['slots', 'hero', 'data', 'headline'], code: 'required', message: 'Hero → Headline is required.' },
    ])
    const draft = validateContent(registry, 'home', data, 'draft')
    expect(draft.ok && draft.data.slots.hero!.data).toEqual({ variant: 'light' })
  })

  it('treats null and empty-string values as absent at every depth', () => {
    const result = validateContent(
      registry,
      'posts',
      post({
        fields: {
          title: 'T',
          date: '2026-01-02',
          body: 'b',
          related: null,
          cta: { url: '/x', text: '' },
          seo: { title: '', description: null },
        },
      }),
      'strict',
    )
    expect(result.ok && result.data.fields).toEqual({ title: 'T', date: '2026-01-02', body: 'b', cta: { url: '/x' }, seo: {} })
    const hero = validateContent(registry, 'home', home({ hero: { enabled: true, data: { headline: 'H', variant: '' } } }), 'strict')
    expect(hero.ok && hero.data.slots.hero!.data).toEqual({ headline: 'H', variant: 'light' })
    const cards = validateContent(
      registry,
      'home',
      home({ features: { enabled: true, data: { cards: [{ title: 'A', body: null }] } } }),
      'strict',
    )
    expect(cards.ok && cards.data.slots.features!.data).toEqual({ cards: [{ title: 'A' }] })
  })

  it('keeps a null list element an error', () => {
    const issues = issuesOf('home', home({ features: { enabled: true, data: { cards: [null] } } }), 'draft')
    expect(issues).toMatchObject([{ path: ['slots', 'features', 'data', 'cards', 0], code: 'invalid' }])
  })

  it('checks a disabled optional slot at draft level only', () => {
    const tooMany = Array.from({ length: 7 }, (_, i) => uuid(i))
    const over = issuesOf('home', home({ quotes: { enabled: false, data: { items: tooMany } } }), 'strict')
    expect(over).toHaveLength(1)
    expect(over[0]).toMatchObject({
      code: 'too_many',
      path: ['slots', 'quotes', 'data', 'items'],
      labels: ['Testimonials', 'Testimonials'],
    })
    expect(validateContent(registry, 'home', home({ quotes: { enabled: false, data: {} } }), 'strict').ok).toBe(true)
    const enabled = issuesOf('home', home({ quotes: { enabled: true, data: {} } }), 'strict')
    expect(enabled).toMatchObject([{ code: 'required', labels: ['Testimonials', 'Testimonials'] }])
  })

  it('rejects switching off a required slot', () => {
    const issues = issuesOf('home', home({ hero: { enabled: false, data: {} } }), 'draft')
    expect(issues).toMatchObject([{ path: ['slots', 'hero', 'enabled'], labels: ['Hero', 'Shown'] }])
  })

  it('fills missing slots and checks them', () => {
    const issues = issuesOf('home', { fields: { title: 'Home' } }, 'strict')
    expect(issues.map((i) => i.message).sort()).toEqual([
      'Features → Cards is required.',
      'Hero → Headline is required.',
    ])
    const draft = validateContent(registry, 'home', { fields: {} }, 'draft')
    expect(draft.ok && draft.data.slots).toEqual({
      hero: { enabled: true, data: { variant: 'light' } },
      features: { enabled: true, data: {} },
      quotes: { enabled: false, data: {} },
    })
  })

  it('requires a slug for routed collections at strict level', () => {
    const { slug: _, ...noSlug } = post()
    expect(issuesOf('posts', noSlug, 'strict')).toMatchObject([
      { path: ['slug'], labels: ['URL slug'], code: 'required', message: 'URL slug is required.' },
    ])
    expect(validateContent(registry, 'posts', noSlug, 'draft').ok).toBe(true)
  })

  it('rejects a malformed slug even in drafts', () => {
    expect(issuesOf('posts', post({ slug: 'Hello World' }), 'draft')).toMatchObject([
      { path: ['slug'], code: 'invalid', labels: ['URL slug'] },
    ])
  })

  it('strips slug and path where they do not apply', () => {
    const result = validateContent(
      registry,
      'testimonials',
      { slug: 'maria', path: '/maria', fields: { quote: 'Q', author: 'Maria' } },
      'strict',
    )
    expect(result.ok && result.data).toEqual({ fields: { quote: 'Q', author: 'Maria' }, slots: {} })
  })

  it('keeps unknown fields and slots, strips unknown top-level keys, instead of failing', () => {
    const result = validateContent(
      registry,
      'posts',
      post({ extra: 1, fields: { title: 'Hello', date: '2026-01-02', body: 'Text', removed: 'x' } }),
      'strict',
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).not.toHaveProperty('extra')
      expect(result.data.fields).toHaveProperty('removed', 'x')
    }
    const slots = validateContent(registry, 'home', home({ gone: { enabled: true, data: {} } }), 'strict')
    expect(slots.ok && Object.keys(slots.data.slots)).toEqual(['hero', 'features', 'quotes', 'gone'])
  })

  it('strips unknown keys inside list items but keeps them beside the list', () => {
    const result = validateContent(registry, 'home', home({ features: { enabled: true, data: { cards: [{ title: 'Fast', old: 1 }], more: 2 } } }), 'strict')
    expect(result.ok && result.data.slots.features!.data).toEqual({ cards: [{ title: 'Fast' }], more: 2 })
  })

  it('maps length, count and format problems', () => {
    const long = issuesOf('posts', post({ fields: { title: 'x'.repeat(121), date: '2026-01-02', body: 'b' } }), 'draft')
    expect(long).toMatchObject([
      { code: 'too_long', labels: ['Title'], message: 'Title is too long (at most 120 characters).' },
    ])
    const few = issuesOf('home', home({ features: { enabled: true, data: { cards: [] } } }), 'strict')
    expect(few).toMatchObject([{ code: 'too_few', labels: ['Features', 'Cards'] }])
    const date = issuesOf('posts', post({ fields: { title: 'T', date: '2026-02-30', body: 'b' } }), 'strict')
    expect(date).toMatchObject([{ code: 'invalid', labels: ['Date'], message: t('issue.date', { field: 'Date' }) }])
    const link = issuesOf(
      'posts',
      post({ fields: { title: 'T', date: '2026-01-02', body: 'b', cta: { url: 'javascript:alert(1)' } } }),
      'strict',
    )
    expect(link).toMatchObject([{ code: 'invalid', labels: ['Call to action'] }])
    const nested = issuesOf(
      'home',
      home({ features: { enabled: true, data: { cards: [{ title: 'A' }, { title: '' }] } } }),
      'strict',
    )
    expect(nested).toMatchObject([
      { path: ['slots', 'features', 'data', 'cards', 1, 'title'], labels: ['Features', 'Cards', 'Item 2', 'Title'], code: 'required' },
    ])
  })

  it('caches document schemas per type and level', () => {
    expect(documentSchema(registry, 'home', 'strict')).toBe(documentSchema(registry, 'home', 'strict'))
    expect(documentSchema(registry, 'home', 'strict')).not.toBe(documentSchema(registry, 'home', 'draft'))
  })
})

describe('validation messages', () => {
  it('says how to write a date', () => {
    const [issue] = issuesOf('posts', post({ fields: { title: 'Hello', date: 'October 15, 2026', body: 'Text' } }), 'draft')
    expect(issue?.message).toBe(t('issue.date', { field: 'Date' }))
  })

  it('says what kind of value a field takes', () => {
    const [issue] = issuesOf('posts', post({ fields: { title: 5, date: '2026-01-02', body: 'Text' } }), 'draft')
    expect(issue?.message).toBe(t('issue.expectedText', { field: 'Title' }))
  })

  it('lists the choices of a select field', () => {
    const issues = issuesOf('home', home({ hero: { enabled: true, data: { headline: 'Hi', variant: 'pink' } } }), 'draft')
    expect(issues.map((i) => i.message)).toContain(t('issue.choice', { field: 'Hero → Style', options: 'light, dark' }))
  })
})

describe('custom paths', () => {
  const custom = buildRegistry({
    ...site,
    collections: site.collections.map((c) => (c.name === 'posts' ? { ...c, customPaths: true } : c)),
  })

  it('accepts a well-formed path and rejects bad ones', () => {
    const ok = (path: string) => validateContent(custom, 'posts', post({ path }), 'draft').ok
    expect(ok('/old/blog/hello')).toBe(true)
    expect(ok('old')).toBe(false)
    expect(ok('/old//hello')).toBe(false)
    expect(ok('/old/')).toBe(false)
    expect(docLabels(custom, 'posts', ['path'])).toEqual(['Custom path'])
    expect(docLabels(registry, 'posts', ['path'])).toBeNull()
  })
})

describe('normalizeContent', () => {
  it('turns content input into the stored shape', () => {
    expect(normalizeContent(registry, 'home', { slots: { quotes: false } })).toEqual({
      fields: {},
      slots: {
        hero: { enabled: true, data: {} },
        features: { enabled: true, data: {} },
        quotes: { enabled: false, data: {} },
      },
    })
    expect(
      normalizeContent(registry, 'home', { fields: { title: 'Home' }, slots: { quotes: { heading: 'Hi' } } })
        .slots.quotes,
    ).toEqual({ enabled: true, data: { heading: 'Hi' } })
    expect(normalizeContent(registry, 'posts', { slug: 'a', fields: { title: 'A' } })).toEqual({
      slug: 'a',
      fields: { title: 'A' },
      slots: {},
    })
  })

  it('produces valid strict content from the fixture shipped content', () => {
    expect(registry.content.size).toBeGreaterThan(0)
    for (const [type, docs] of registry.content) {
      for (const input of docs.flatMap((d) => Object.values(d.content))) {
        const result = validateContent(registry, type, normalizeContent(registry, type, input), 'strict')
        expect(result.ok ? [] : result.issues).toEqual([])
      }
    }
  })
})

describe('docLabels', () => {
  it('labels fields, slots, slug and path', () => {
    expect(docLabels(registry, 'home', ['slots', 'features', 'data', 'cards', 0, 'title'])).toEqual([
      'Features',
      'Cards',
      'Item 1',
      'Title',
    ])
    expect(docLabels(registry, 'home', ['slots', 'quotes', 'enabled'])).toEqual(['Testimonials', 'Shown'])
    expect(docLabels(registry, 'home', ['fields', 'seo', 'title'])).toEqual(['Search and sharing', 'Title'])
    expect(docLabels(registry, 'posts', ['slug'])).toEqual(['URL slug'])
    expect(docLabels(registry, 'posts', ['fields', 'related'])).toEqual(['Related posts'])
  })

  it('returns null for paths that do not exist', () => {
    expect(docLabels(registry, 'home', ['slug'])).toBeNull()
    expect(docLabels(registry, 'home', ['slots', 'nope', 'data'])).toBeNull()
    expect(docLabels(registry, 'home', ['slots', 'hero', 'data', 'headlin'])).toBeNull()
    expect(docLabels(registry, 'home', ['fields', 'nope'])).toBeNull()
    expect(docLabels(registry, 'home', ['other'])).toBeNull()
  })
})

describe('documentRefs', () => {
  it('collects refs from fields and every slot, including switched-off ones', () => {
    const data = home({
      hero: { enabled: true, data: { headline: 'Hi', image: { media: sha }, cta: { document: uuid(1) } } },
      quotes: { enabled: false, data: { items: [uuid(2), uuid(1)] } },
    })
    data.fields.seo = { image: { media: sha } }
    expect(documentRefs(registry, 'home', data)).toEqual([
      { kind: 'media', id: sha },
      { kind: 'document', id: uuid(1) },
      { kind: 'document', id: uuid(2) },
    ])
  })
})
