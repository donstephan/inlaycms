import { z } from 'zod'
import { f } from '../../src/core/fields/builtins.js'
import { fieldMeta } from '../../src/core/fields/define.js'
import { extractRefs, findRefs, labelsAt, toDraftSchema } from '../../src/core/fields/walk.js'
import { t } from '../../src/core/messages/index.js'

const uuid = '6f1c2b1e-8a3d-4b7e-9c2a-1d2e3f4a5b6c'
const uuid2 = '7f1c2b1e-8a3d-4b7e-9c2a-1d2e3f4a5b6d'
const sha = 'a'.repeat(64)
const ok = (s: z.ZodType, v: unknown) => s.safeParse(v).success

const schema = z.object({
  title: f.text({ label: 'Title', maxLength: 10 }),
  subtitle: f.text({ label: 'Subtitle' }).default('x'),
  cards: f.list(z.object({ title: f.text({ label: 'Card title' }) }), { label: 'Cards', min: 1 }),
  hero: f.group({ img: f.image({ label: 'Image' }) }, { label: 'Hero' }),
  links: f.list(z.object({ link: f.link({ label: 'Link' }) }), {
    label: 'Links',
    itemLabel: 'Link',
  }),
  related: f.ref('posts', { label: 'Related', many: true }).optional(),
})

describe('toDraftSchema', () => {
  const draft = toDraftSchema(schema)

  it('makes keys optional and drops list min', () => {
    expect(ok(schema, {})).toBe(false)
    expect(ok(draft, {})).toBe(true)
    expect(ok(draft, { cards: [] })).toBe(true)
    expect(ok(draft, { hero: {} })).toBe(true)
    expect(ok(draft, { cards: [{}] })).toBe(true)
  })

  it('uses meta.draft for leaves', () => {
    expect(ok(draft, { title: '   ' })).toBe(true)
    expect(ok(draft, { cards: [{ title: '' }] })).toBe(true)
  })

  it('keeps per-value checks', () => {
    expect(ok(draft, { title: 42 })).toBe(false)
    expect(ok(draft, { title: 'much too long title' })).toBe(false)
    expect(ok(draft, { hero: { img: { media: 'nope' } } })).toBe(false)
    expect(ok(draft, { links: [{ link: { url: 'javascript:alert(1)' } }] })).toBe(false)
    expect(ok(draft, { related: ['not-a-uuid'] })).toBe(false)
  })

  it('keeps defaults', () => {
    expect(draft.parse({})).toEqual({ subtitle: 'x' })
    expect(toDraftSchema(z.object({ on: f.boolean({ label: 'On' }) })).parse({})).toEqual({
      on: false,
    })
  })

  it('strips unknown keys', () => {
    expect(draft.parse({ title: 'Hi', extra: 1 })).toEqual({ title: 'Hi', subtitle: 'x' })
  })

  it('re-attaches field metadata', () => {
    const shape = (draft._zod.def as unknown as { shape: Record<string, z.ZodType> }).shape
    expect(fieldMeta(shape.hero!)?.label).toBe('Hero')
    expect(fieldMeta(shape.cards!)?.label).toBe('Cards')
  })
})

describe('extractRefs', () => {
  it('finds nested media and document refs, deduplicated', () => {
    const refs = extractRefs(schema, {
      hero: { img: { media: sha } },
      links: [
        { link: { document: uuid, text: 'A' } },
        { link: { url: '/contact' } },
        { link: { document: uuid2 } },
        { link: { document: uuid } },
      ],
      related: [uuid2],
    })
    expect(refs).toEqual([
      { kind: 'media', id: sha },
      { kind: 'document', id: uuid },
      { kind: 'document', id: uuid2 },
    ])
  })

  it('returns [] for empty or malformed data', () => {
    expect(extractRefs(schema, {})).toEqual([])
    expect(extractRefs(schema, null)).toEqual([])
    expect(extractRefs(schema, { hero: 'x', links: 'y' })).toEqual([])
  })
})

describe('findRefs', () => {
  it('reports every ref with its path and field', () => {
    const found = findRefs(schema, {
      hero: { img: { media: sha } },
      links: [{ link: { url: '/x' } }, { link: { document: uuid } }],
      related: [uuid2, uuid],
    })
    expect(found.map(({ path, meta, ref }) => [path, meta.label, ref.id])).toEqual([
      [['hero', 'img'], 'Image', sha],
      [['links', 1, 'link'], 'Link', uuid],
      [['related', 0], 'Related', uuid2],
      [['related', 1], 'Related', uuid],
    ])
  })
})

describe('labelsAt', () => {
  it('returns one label per field segment', () => {
    expect(labelsAt(schema, ['cards', 1, 'title'])).toEqual(['Cards', 'Item 2', 'Card title'])
    expect(labelsAt(schema, ['cards', 0])).toEqual(['Cards', t('label.item', { n: 1 })])
    expect(labelsAt(schema, ['hero', 'img'])).toEqual(['Hero', 'Image'])
    expect(labelsAt(schema, [])).toEqual([])
  })

  it('uses itemLabel when set', () => {
    expect(labelsAt(schema, ['links', 2, 'link'])).toEqual(['Links', 'Link 3', 'Link'])
  })

  it('stops labeling inside a leaf field', () => {
    expect(labelsAt(schema, ['hero', 'img', 'media'])).toEqual(['Hero', 'Image'])
    expect(labelsAt(schema, ['links', 0, 'link', 'url'])).toEqual(['Links', 'Link 1', 'Link'])
  })

  it('returns null for paths not in the schema', () => {
    expect(labelsAt(schema, ['nope'])).toBeNull()
    expect(labelsAt(schema, ['cards', 'x'])).toBeNull()
    expect(labelsAt(schema, ['cards', 0, 'nope'])).toBeNull()
    expect(labelsAt(schema, ['title', 'x'])).toBeNull()
  })
})
