import type { ReleaseManifest } from '../../src/core/release/manifest.js'
import { t } from '../../src/core/messages/index.js'
import { formatDiff, structuralDiff } from '../../src/host/diff.js'

type Json = Record<string, unknown>

const text = (title: string): Json => ({ type: 'string', title })
const object = (properties: Record<string, Json>, required: string[] = []): Json => ({
  type: 'object',
  properties,
  ...(required.length > 0 && { required }),
  additionalProperties: false,
})

/** A stored-type JSON Schema shaped like `storedTypeSchema`'s: fields, and slots that are always on or optional. */
function typeSchema(
  fields: Record<string, Json>,
  required: string[] = [],
  slots: Record<string, { data: Json; optional?: boolean }> = {},
): Json {
  const slotProps: Record<string, Json> = {}
  for (const [name, { data, optional }] of Object.entries(slots)) {
    const on = { type: 'object', properties: { enabled: { type: 'boolean', const: true }, data }, required: ['enabled'] }
    const off = { type: 'object', properties: { enabled: { type: 'boolean', const: false }, data: { ...data, required: [] } } }
    slotProps[name] = optional ? { default: {}, oneOf: [on, off], title: name } : { default: {}, ...on, title: name }
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      fields: { default: {}, ...object(fields, required) },
      slots: { default: {}, type: 'object', properties: slotProps, additionalProperties: false },
    },
  }
}

function manifest(over: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    format: 1,
    name: 'r',
    createdAt: '2026-11-05T00:00:00.000Z',
    inlay: { version: '0.1.0', range: '^0.1.0' },
    secrets: [],
    files: {},
    content: [],
    schema: { home: typeSchema({ title: text('Title') }, ['title']) },
    shipped: [],
    migrations: [],
    routes: [],
    locales: ['en'],
    types: { home: { kind: 'singleton', slots: [] } },
    ...over,
  }
}

const HASH = (c: string) => c.repeat(64)

describe('structuralDiff', () => {
  it('reports nothing between a manifest and itself', () => {
    const m = manifest()
    expect(structuralDiff(m, m)).toEqual({
      types: { added: [], removed: [], changed: [] },
      slots: { added: [], removed: [], optional: [], required: [] },
      locales: { added: [], removed: [] },
      fields: [],
      routes: { added: [], removed: [], sitemap: { added: [], removed: [] } },
      redirects: { added: [], removed: [], changed: [] },
      integrations: { added: [], removed: [], changed: [] },
      csp: { added: [], removed: [] },
      secrets: [],
      migrations: [],
      shipped: { stale: [] },
    })
  })

  it('types added and removed, without listing their fields or slots', () => {
    const current = manifest({
      schema: { home: typeSchema({ title: text('Title') }), team: typeSchema({ name: text('Name') }) },
      types: { home: { kind: 'singleton', slots: [] }, team: { kind: 'collection', slots: ['intro'] } },
    })
    const staged = manifest({
      schema: { home: typeSchema({ title: text('Title') }), posts: typeSchema({ title: text('Title') }) },
      types: { home: { kind: 'singleton', slots: [] }, posts: { kind: 'collection', slots: ['hero'] } },
    })
    const diff = structuralDiff(current, staged)
    expect(diff.types).toEqual({ added: ['posts'], removed: ['team'], changed: [] })
    expect(diff.slots).toEqual({ added: [], removed: [], optional: [], required: [] })
    expect(diff.fields).toEqual([])
  })

  it('slots added and removed', () => {
    const data = object({ headline: text('Headline') })
    const current = manifest({
      schema: { home: typeSchema({}, [], { hero: { data }, cta: { data } }) },
      types: { home: { kind: 'singleton', slots: ['hero', 'cta'] } },
    })
    const staged = manifest({
      schema: { home: typeSchema({}, [], { hero: { data }, quote: { data, optional: true } }) },
      types: { home: { kind: 'singleton', slots: ['hero', 'quote'] } },
    })
    const diff = structuralDiff(current, staged)
    expect(diff.slots).toEqual({
      added: [{ type: 'home', slot: 'quote' }],
      removed: [{ type: 'home', slot: 'cta' }],
      optional: [],
      required: [],
    })
    expect(diff.fields).toEqual([])
  })

  it('locales added and removed', () => {
    const diff = structuralDiff(manifest({ locales: ['en', 'fr'] }), manifest({ locales: ['en', 'de'] }))
    expect(diff.locales).toEqual({ added: ['de'], removed: ['fr'] })
  })

  it('fields added and removed, at the top, in groups, in list items and in slots', () => {
    const current = manifest({
      schema: {
        home: typeSchema(
          {
            title: text('Title'),
            seo: object({ title: text('SEO title') }),
            items: { type: 'array', items: object({ label: text('Label') }) },
          },
          [],
          { hero: { data: object({ headline: text('Headline') }), optional: true } },
        ),
      },
      types: { home: { kind: 'singleton', slots: ['hero'] } },
    })
    const staged = manifest({
      schema: {
        home: typeSchema(
          {
            title: text('Title'),
            intro: text('Intro'),
            seo: object({ title: text('SEO title'), description: text('Description') }),
            items: { type: 'array', items: object({ url: text('URL') }) },
          },
          [],
          { hero: { data: object({ headline: text('Headline'), image: object({ media: { type: 'string' } }) }), optional: true } },
        ),
      },
      types: { home: { kind: 'singleton', slots: ['hero'] } },
    })
    expect(structuralDiff(current, staged).fields).toEqual([
      { type: 'home', path: 'fields.intro', change: 'added' },
      { type: 'home', path: 'fields.seo.description', change: 'added' },
      { type: 'home', path: 'fields.items[].url', change: 'added' },
      { type: 'home', path: 'fields.items[].label', change: 'removed' },
      { type: 'home', path: 'slots.hero.image', change: 'added' },
    ])
  })

  it('required-ness and renames', () => {
    const current = manifest({
      schema: { home: typeSchema({ headline: text('Headline'), intro: text('Intro'), tag: text('Tag') }, ['headline', 'tag']) },
    })
    const staged = manifest({
      schema: { home: typeSchema({ title: text('Headline'), intro: text('Introduction'), tag: text('Tag') }, ['title', 'intro']) },
    })
    expect(structuralDiff(current, staged).fields).toEqual([
      { type: 'home', path: 'fields.title', change: 'added' },
      { type: 'home', path: 'fields.intro', change: 'required' },
      { type: 'home', path: 'fields.tag', change: 'optional' },
      { type: 'home', path: 'fields.headline', change: 'removed' },
    ])
  })

  it('a field whose type changed', () => {
    const current = manifest({
      schema: {
        home: typeSchema({
          count: { type: 'string', title: 'Count' },
          kind: { type: 'string', enum: ['a', 'b'] },
          seo: object({ title: text('Title') }),
          note: { type: 'string', maxLength: 70, title: 'Note' },
        }),
      },
    })
    const staged = manifest({
      schema: {
        home: typeSchema({
          count: { type: 'number', title: 'Count' },
          kind: { type: 'string', enum: ['a', 'c'] },
          seo: text('SEO'),
          note: { type: 'string', maxLength: 160, title: 'A note', description: 'Help' },
        }),
      },
    })
    expect(structuralDiff(current, staged).fields).toEqual([
      { type: 'home', path: 'fields.count', change: 'type' },
      { type: 'home', path: 'fields.kind', change: 'type' },
      { type: 'home', path: 'fields.seo', change: 'type' },
    ])
  })

  it('compares the schemas inside patternProperties, dependentSchemas, if/then/else, contains, propertyNames and $defs by shape', () => {
    const field = (title: string): Json => ({
      type: 'object',
      patternProperties: { '^x-': { type: 'string', title } },
      dependentSchemas: { a: { title, required: ['b'] } },
      if: { title, properties: { a: { const: 1 } } },
      then: { title, required: ['a'] },
      else: { title },
      propertyNames: { title, pattern: '^[a-z]+$' },
      title,
    })
    const list = (title: string): Json => ({ type: 'array', contains: { type: 'string', title }, title })
    const defs = (defType: string): Json => ({ $ref: '#/$defs/v', $defs: { v: { type: defType, title: 'V' } } })
    const current = manifest({ schema: { home: typeSchema({ map: field('Old'), tags: list('Old'), ref: defs('string') }) } })
    const staged = manifest({ schema: { home: typeSchema({ map: field('New'), tags: list('New'), ref: defs('number') }) } })
    expect(structuralDiff(current, staged).fields).toEqual([{ type: 'home', path: 'fields.ref', change: 'type' }])

    const retyped = manifest({
      schema: { home: typeSchema({ map: { ...field('Old'), patternProperties: { '^x-': { type: 'number' } } }, tags: list('Old'), ref: defs('string') }) },
    })
    expect(structuralDiff(current, retyped).fields).toEqual([{ type: 'home', path: 'fields.map', change: 'type' }])
  })

  it("a field whose kind of field changed, by Inlay's own keywords, but not by where the admin shows it", () => {
    const rich = (features: string[]): Json => ({ type: 'object', properties: { doc: { type: 'object' } }, richText: { features } })
    const current = manifest({
      schema: {
        home: typeSchema({
          body: rich(['bold']),
          note: { type: 'string', title: 'Note' },
          extra: { type: 'object', additionalProperties: false },
          aside: { type: 'string', title: 'Aside' },
        }),
      },
    })
    const staged = manifest({
      schema: {
        home: typeSchema({
          body: rich(['bold', 'link']),
          note: { type: 'string', title: 'Note', richText: { features: [] } },
          extra: { type: 'object', additionalProperties: true },
          aside: { type: 'string', title: 'Aside', 'x-setting': true },
        }),
      },
    })
    expect(structuralDiff(current, staged).fields).toEqual([
      { type: 'home', path: 'fields.body', change: 'type' },
      { type: 'home', path: 'fields.note', change: 'type' },
      { type: 'home', path: 'fields.extra', change: 'type' },
    ])
  })

  it('slots that can now be switched off or are now always on, and types whose kind changed', () => {
    const data = object({ headline: text('Headline') })
    const current = manifest({
      schema: { home: typeSchema({}, [], { hero: { data }, quote: { data, optional: true } }) },
      types: { home: { kind: 'singleton', slots: ['hero', 'quote'] }, team: { kind: 'collection', slots: [] } },
    })
    const staged = manifest({
      schema: { home: typeSchema({}, [], { hero: { data, optional: true }, quote: { data } }) },
      types: { home: { kind: 'singleton', slots: ['hero', 'quote'] }, team: { kind: 'global', slots: [] } },
    })
    const diff = structuralDiff(current, staged)
    expect(diff.slots).toEqual({ added: [], removed: [], optional: [{ type: 'home', slot: 'hero' }], required: [{ type: 'home', slot: 'quote' }] })
    expect(diff.types.changed).toEqual([{ type: 'team', from: 'collection', to: 'global' }])
    expect(diff.fields).toEqual([])
    expect(formatDiff({ structural: diff, content: null })).toEqual([
      t('diff.release.typeKind', { type: 'team', from: 'collection', to: 'global' }),
      t('diff.release.slotOptional', { type: 'home', slot: 'hero' }),
      t('diff.release.slotRequired', { type: 'home', slot: 'quote' }),
    ])
  })

  it('reports routes newly listed in, or dropped from, the sitemap', () => {
    const plain = manifest({ routes: [{ method: 'GET', path: '/calc' }] })
    const listed = manifest({
      routes: [{ method: 'GET', path: '/calc', sitemap: true }, { method: 'GET', path: '/tool', sitemap: true }],
    })
    const on = structuralDiff(plain, listed)
    expect(on.routes.sitemap).toEqual({
      added: [{ method: 'GET', path: '/calc', sitemap: true }, { method: 'GET', path: '/tool', sitemap: true }],
      removed: [],
    })
    expect(formatDiff({ structural: on, content: null })).toContain(t('diff.release.routeSitemapAdded', { path: '/calc' }))
    const off = structuralDiff(listed, plain)
    expect(off.routes.sitemap).toEqual({ added: [], removed: [{ method: 'GET', path: '/calc' }] })
    expect(formatDiff({ structural: off, content: null })).toContain(t('diff.release.routeSitemapRemoved', { path: '/calc' }))
  })

  it('routes added and removed, and the secrets and migrations of the staged release', () => {
    const current = manifest({
      routes: [{ method: 'GET', path: '/ping' }, { method: 'POST', path: '/contact' }],
      secrets: ['OLD'],
      migrations: ['earlier'],
    })
    const staged = manifest({
      routes: [{ method: 'GET', path: '/ping' }, { method: 'GET', path: '/contact' }],
      secrets: ['HOOK', 'OLD'],
      migrations: ['team-to-people'],
    })
    const diff = structuralDiff(current, staged)
    expect(diff.routes).toEqual({ added: [{ method: 'GET', path: '/contact' }], removed: [{ method: 'POST', path: '/contact' }],
      sitemap: { added: [], removed: [] },
    })
    expect(diff.secrets).toEqual(['HOOK', 'OLD'])
    expect(diff.migrations).toEqual(['team-to-people'])
  })

  it('code redirects added, removed and changed, by from', () => {
    const current = manifest({
      redirects: [
        { from: '/a', to: '/b', status: 301 },
        { from: '/c', to: '/d', status: 301 },
      ],
    })
    const staged = manifest({
      redirects: [
        { from: '/a', to: '/b', status: 302 },
        { from: '/e', to: 'https://x.com/', status: 301 },
      ],
    })
    const diff = structuralDiff(current, staged)
    expect(diff.redirects).toEqual({
      added: [{ from: '/e', to: 'https://x.com/', status: 301 }],
      removed: [{ from: '/c', to: '/d', status: 301 }],
      changed: [{ before: { from: '/a', to: '/b', status: 301 }, after: { from: '/a', to: '/b', status: 302 } }],
    })
    expect(structuralDiff(manifest(), staged).redirects?.added).toHaveLength(2)
    expect(formatDiff({ structural: diff, content: null })).toEqual([
      t('diff.release.redirectAdded', { from: '/e', to: 'https://x.com/', status: 301 }),
      t('diff.release.redirectRemoved', { from: '/c', to: '/d' }),
      t('diff.release.redirectChanged', { from: '/a', to: '/b', status: 302 }),
    ])
  })

  it('an added and a removed integration', () => {
    const current = manifest({ integrations: [{ name: 'gtm', label: 'Tag Manager' }] })
    const staged = manifest({ integrations: [{ name: 'chat', label: 'Chat' }] })
    expect(structuralDiff(current, staged).integrations).toEqual({ added: ['chat'], removed: ['gtm'], changed: [] })
  })

  it('a changed label, consent category or csp marks the integration changed', () => {
    const base = { name: 'gtm', label: 'Tag Manager', consent: 'analytics' as const, csp: { 'script-src': ['https://t.example'] } }
    const current = manifest({ integrations: [base, { name: 'a', label: 'A' }, { name: 'b', label: 'B' }, { name: 'c', label: 'C' }] })
    const staged = manifest({
      integrations: [
        { ...base, consent: 'marketing' },
        { name: 'a', label: 'A', csp: { 'img-src': ['https://x.example'] } },
        { name: 'b', label: 'B2' },
        { name: 'c', label: 'C' },
      ],
    })
    expect(structuralDiff(current, staged).integrations).toEqual({ added: [], removed: [], changed: ['gtm', 'a', 'b'] })
  })

  it('csp lists what the site may newly load and what it no longer may', () => {
    const current = manifest({ csp: { 'img-src': ['https://old.example', 'https://keep.example'] } })
    const staged = manifest({
      csp: { 'img-src': ['https://keep.example'] },
      integrations: [{ name: 'gtm', label: 'Tag Manager', csp: { 'script-src': ['https://t.example'] } }],
    })
    expect(structuralDiff(current, staged).csp).toEqual({
      added: ['script-src https://t.example'],
      removed: ['img-src https://old.example'],
    })
  })

  it('a source that moves from one integration to the site is neither added nor removed', () => {
    const current = manifest({ integrations: [{ name: 'gtm', label: 'T', csp: { 'script-src': ['https://t.example'] } }] })
    const staged = manifest({ csp: { 'script-src': ['https://t.example'] } })
    expect(structuralDiff(current, staged).csp).toEqual({ added: [], removed: [] })
  })

  it('a current manifest without the keys diffs as empty lists', () => {
    const diff = structuralDiff(manifest(), manifest())
    expect(diff.integrations).toEqual({ added: [], removed: [], changed: [] })
    expect(diff.csp).toEqual({ added: [], removed: [] })
  })

  it('formatDiff prints one line per integration and per source', () => {
    const current = manifest({ integrations: [{ name: 'gtm', label: 'T' }], csp: { 'img-src': ['https://old.example'] } })
    const staged = manifest({
      integrations: [{ name: 'chat', label: 'Chat', csp: { 'script-src': ['https://t.example'] } }],
    })
    const lines = formatDiff({ structural: structuralDiff(current, staged), content: null })
    expect(lines).toEqual([
      t('diff.release.integrationAdded', { name: 'chat' }),
      t('diff.release.integrationRemoved', { name: 'gtm' }),
      t('diff.release.cspAdded', { source: 'script-src https://t.example' }),
      t('diff.release.cspRemoved', { source: 'img-src https://old.example' }),
    ])
    expect(lines[0]).toContain('chat')
    expect(lines[1]).toContain('gtm')
    expect(lines[2]).toContain('script-src https://t.example')
  })

  it('formatDiff accepts a diff without the new fields', () => {
    const { integrations: _i, csp: _c, ...old } = structuralDiff(manifest(), manifest())
    expect(formatDiff({ structural: old, content: null })).toEqual([t('diff.release.nothing')])
  })

  it('a shipped document whose content changed but whose edition did not', () => {
    const current = manifest({
      shipped: [
        { type: 'home', key: 'home', edition: 2, locales: { en: HASH('a'), fr: HASH('b') } },
        { type: 'posts', key: 'hello', edition: 1, locales: { en: HASH('c') } },
        { type: 'posts', key: 'bumped', edition: 1, locales: { en: HASH('d') } },
      ],
    })
    const staged = manifest({
      shipped: [
        { type: 'home', key: 'home', edition: 2, locales: { en: HASH('a'), fr: HASH('e') } },
        { type: 'posts', key: 'hello', edition: 1, locales: { en: HASH('c'), de: HASH('f') } },
        { type: 'posts', key: 'bumped', edition: 2, locales: { en: HASH('9') } },
        { type: 'posts', key: 'new', edition: 1, locales: { en: HASH('0') } },
      ],
    })
    expect(structuralDiff(current, staged).shipped.stale).toEqual([
      { type: 'home', key: 'home', locale: 'fr', edition: 2 },
      { type: 'posts', key: 'hello', locale: 'de', edition: 1 },
    ])
  })

  it('the first release adds everything and removes nothing', () => {
    const staged = manifest({
      schema: { home: typeSchema({ title: text('Title') }, [], { hero: { data: object({ headline: text('Headline') }) } }) },
      types: { home: { kind: 'singleton', slots: ['hero'] } },
      locales: ['en', 'fr'],
      routes: [{ method: 'GET', path: '/ping' }],
      redirects: [{ from: '/x', to: '/y', status: 301 }],
      secrets: ['HOOK'],
      migrations: ['first'],
      shipped: [{ type: 'home', key: 'home', edition: 1, locales: { en: HASH('a') } }],
    })
    expect(structuralDiff(null, staged)).toEqual({
      types: { added: ['home'], removed: [], changed: [] },
      slots: { added: [], removed: [], optional: [], required: [] },
      locales: { added: ['en', 'fr'], removed: [] },
      fields: [],
      routes: { added: [{ method: 'GET', path: '/ping' }], removed: [], sitemap: { added: [], removed: [] } },
      redirects: { added: [{ from: '/x', to: '/y', status: 301 }], removed: [], changed: [] },
      integrations: { added: [], removed: [], changed: [] },
      csp: { added: [], removed: [] },
      secrets: ['HOOK'],
      migrations: ['first'],
      shipped: { stale: [] },
    })
  })
})
