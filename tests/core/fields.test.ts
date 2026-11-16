import { z } from 'zod'
import { f } from '../../src/core/fields/builtins.js'
import { fieldMeta } from '../../src/core/fields/define.js'
import { t } from '../../src/core/messages/index.js'

const uuid = '6f1c2b1e-8a3d-4b7e-9c2a-1d2e3f4a5b6c'
const uuid2 = '7f1c2b1e-8a3d-4b7e-9c2a-1d2e3f4a5b6d'
const sha = 'a'.repeat(64)
const ok = (s: z.ZodType, v: unknown) => s.safeParse(v).success

describe('fieldMeta', () => {
  it('unwraps optional/default/nullable', () => {
    expect(fieldMeta(f.text({ label: 'Headline' }).optional())?.label).toBe('Headline')
    expect(fieldMeta(f.text({ label: 'H' }).nullable().optional())?.kind).toBe('text')
    expect(fieldMeta(f.boolean({ label: 'B' }))?.kind).toBe('boolean')
    expect(fieldMeta(z.string())).toBeUndefined()
  })
})

describe('text / textarea', () => {
  it('rejects blank strictly but accepts in draft', () => {
    const s = f.text({ label: 'T', maxLength: 5 })
    expect(ok(s, 'hello')).toBe(true)
    expect(ok(s, '   ')).toBe(false)
    expect(ok(s, '')).toBe(false)
    expect(ok(s, 'toolong')).toBe(false)
    const draft = fieldMeta(s)!.draft!
    expect(ok(draft, '   ')).toBe(true)
    expect(ok(draft, 'toolong')).toBe(false)
  })
  it('textarea behaves the same', () => {
    const s = f.textarea({ label: 'T', help: 'h' })
    expect(ok(s, 'a\nb')).toBe(true)
    expect(ok(s, ' ')).toBe(false)
    expect(fieldMeta(s)?.help).toBe('h')
  })
})

describe('number', () => {
  it('enforces range and integer', () => {
    const s = f.number({ label: 'N', min: 1, max: 10, integer: true })
    expect(ok(s, 5)).toBe(true)
    expect(ok(s, 11)).toBe(false)
    expect(ok(s, 1.5)).toBe(false)
  })
})

describe('boolean', () => {
  it('defaults to false', () => {
    expect(f.boolean({ label: 'B' }).parse(undefined)).toBe(false)
    expect(ok(f.boolean({ label: 'B' }), 'x')).toBe(false)
  })
})

describe('select', () => {
  it('accepts only options', () => {
    const s = f.select(['a', 'b'], { label: 'S' })
    expect(ok(s, 'a')).toBe(true)
    expect(ok(s, 'c')).toBe(false)
    expect(fieldMeta(s)?.options).toEqual(['a', 'b'])
  })
})

describe('date / datetime', () => {
  it('validates real calendar dates', () => {
    const s = f.date({ label: 'D' })
    expect(ok(s, '2026-02-28')).toBe(true)
    expect(ok(s, '2026-02-30')).toBe(false)
    expect(ok(s, '2026-2-3')).toBe(false)
  })
  it('requires ISO with offset', () => {
    const s = f.datetime({ label: 'D' })
    expect(ok(s, '2026-10-28T12:00:00Z')).toBe(true)
    expect(ok(s, '2026-10-28T12:00:00+02:00')).toBe(true)
    expect(ok(s, '2026-10-28T12:00:00')).toBe(false)
    expect(ok(s, '2026-10-28')).toBe(false)
  })
})

describe('link', () => {
  const s = f.link({ label: 'L' })
  it('accepts paths, urls and documents', () => {
    expect(ok(s, { url: '/contact' })).toBe(true)
    expect(ok(s, { url: 'https://example.com' })).toBe(true)
    expect(ok(s, { url: 'mailto:a@b.co' })).toBe(true)
    expect(ok(s, { document: uuid, text: 'Read' })).toBe(true)
  })
  it('rejects unsafe or malformed', () => {
    expect(ok(s, { url: 'javascript:alert(1)' })).toBe(false)
    expect(ok(s, { document: 'nope' })).toBe(false)
    expect(ok(s, {})).toBe(false)
  })
  it('extracts refs', () => {
    const refs = fieldMeta(s)!.refs!
    expect(refs({ document: uuid })).toEqual([{ kind: 'document', id: uuid }])
    expect(refs({ url: '/x' })).toEqual([])
    expect(refs(null)).toEqual([])
  })
})

describe('ref', () => {
  it('single', () => {
    const s = f.ref('posts', { label: 'R' })
    expect(ok(s, uuid)).toBe(true)
    expect(ok(s, 'x')).toBe(false)
    expect(fieldMeta(s)!.refs!(uuid)).toEqual([{ kind: 'document', id: uuid }])
    expect(fieldMeta(s)!.refs!(42)).toEqual([])
  })
  it('many', () => {
    const s = f.ref('posts', { label: 'Related', many: true, max: 2 })
    const m = fieldMeta(s)!
    expect(m.target).toBe('posts')
    expect(m.many).toBe(true)
    expect(ok(s, [uuid, uuid2])).toBe(true)
    expect(ok(s, [uuid, uuid2, uuid])).toBe(false)
    expect(m.refs!([uuid, uuid2])).toEqual([
      { kind: 'document', id: uuid },
      { kind: 'document', id: uuid2 },
    ])
    expect(m.refs!('bad')).toEqual([])
  })
})

describe('image / file', () => {
  it('image', () => {
    const s = f.image({ label: 'I' })
    expect(ok(s, { media: sha, alt: 'x' })).toBe(true)
    expect(ok(s, { media: 'abc' })).toBe(false)
    expect(fieldMeta(s)!.refs!({ media: sha })).toEqual([{ kind: 'media', id: sha }])
    expect(fieldMeta(s)!.refs!(undefined)).toEqual([])
  })
  it('file', () => {
    const s = f.file({ label: 'F' })
    expect(ok(s, { media: sha })).toBe(true)
    expect(ok(s, { media: sha.toUpperCase() })).toBe(false)
    expect(fieldMeta(s)!.refs!({ media: sha })).toEqual([{ kind: 'media', id: sha }])
  })
})

describe('list', () => {
  it('enforces min and item shape', () => {
    const s = f.list(z.object({ q: f.text({ label: 'Q' }) }), { label: 'L', min: 1, itemLabel: 'Question' })
    expect(ok(s, [{ q: 'a' }])).toBe(true)
    expect(ok(s, [])).toBe(false)
    expect(ok(s, [{ q: ' ' }])).toBe(false)
    expect(fieldMeta(s)?.itemLabel).toBe('Question')
  })
})

describe('group', () => {
  it('parses nested shape', () => {
    const s = f.group({ a: f.text({ label: 'A' }) }, { label: 'G' })
    expect(ok(s, { a: 'x' })).toBe(true)
    expect(ok(s, {})).toBe(false)
    expect(fieldMeta(s)?.kind).toBe('group')
  })
})

describe('seo', () => {
  it('uses catalog labels', () => {
    const s = f.seo()
    expect(fieldMeta(s)?.label).toBe(t('label.seo'))
    const shape = s._zod.def.shape
    expect(fieldMeta(shape.title as z.ZodType)?.label).toBe(t('label.seo.title'))
    expect(fieldMeta(shape.description as z.ZodType)?.label).toBe(t('label.seo.description'))
    expect(fieldMeta(shape.image as z.ZodType)?.label).toBe(t('label.seo.image'))
    expect(ok(s, {})).toBe(true)
    expect(ok(s, { title: 'x'.repeat(71) })).toBe(false)
    expect(f.seo({ label: 'Custom' }) && fieldMeta(f.seo({ label: 'Custom' }))?.label).toBe('Custom')
  })
})
