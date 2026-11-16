import { z } from 'zod'
import { f } from '../../src/core/fields/builtins.js'
import { defineField } from '../../src/core/fields/define.js'
import { readData, readValue } from '../../src/core/content/reader.js'
import { buildRegistry } from '../../src/core/registry/registry.js'
import { BasicPage, site } from '../fixtures/site.js'
import { homeTitledSite, ratedSite, withType } from '../fixtures/evolve.js'

const registry = buildRegistry(site)
const titled = buildRegistry(homeTitledSite)

const features = { enabled: true, data: { cards: [{ title: 'Fast' }] } }

const home = {
  fields: { title: 'Home', legacy: 'kept' },
  slots: {
    hero: { enabled: true, data: { headline: 'Welcome', variant: 'dark', old: 1 } },
    features: { enabled: true, data: { cards: [{ title: 'Fast' }, 'junk', { body: 'no title' }] } },
    quotes: { enabled: false, data: {} },
    gone: { enabled: true, data: { anything: true } },
  },
}

describe('readData', () => {
  it('keeps values that fit and carries unknown keys at every object level', () => {
    const { data, gaps } = readData(registry, 'home', home)
    expect(data.fields).toEqual({ title: 'Home', legacy: 'kept' })
    expect(data.slots.hero!.data).toEqual({ headline: 'Welcome', variant: 'dark', old: 1 })
    expect(data.slots.gone).toEqual({ enabled: true, data: { anything: true } })
    expect(gaps).toEqual([['slots', 'features', 'data', 'cards', 1, 'title']])
  })

  it('drops a list item that is not an object and keeps one with a missing required field', () => {
    const { data } = readData(registry, 'home', home)
    expect(data.slots.features!.data.cards).toEqual([{ title: 'Fast' }, { body: 'no title' }])
  })

  it('strips unknown keys inside list items', () => {
    const { data } = readData(registry, 'home', {
      fields: { title: 'Home' },
      slots: { features: { enabled: true, data: { cards: [{ title: 'Fast', old: 1 }], more: 2 } } },
    })
    expect(data.slots.features!.data).toEqual({ cards: [{ title: 'Fast' }], more: 2 })
  })

  it('reads a renamed required field as missing, with a gap, and carries the old key', () => {
    const { data, gaps } = readData(titled, 'home', home)
    expect(data.slots.hero!.data.title).toBeUndefined()
    expect(data.slots.hero!.data.headline).toBe('Welcome')
    expect(gaps).toContainEqual(['slots', 'hero', 'data', 'title'])
  })

  it('fills the empty value only when asked', () => {
    expect(readData(titled, 'home', home, { fill: true }).data.slots.hero!.data.title).toBe('')
  })

  it('an optional field that does not fit becomes absent without a gap', () => {
    const { data, gaps } = readData(registry, 'home', {
      fields: { title: 'Home' },
      slots: { hero: { enabled: true, data: { headline: 'Hi', sub: 42 } }, features },
    })
    expect(data.slots.hero!.data.sub).toBeUndefined()
    expect(gaps).toEqual([])
  })

  it('a field with a developer default takes the default without a gap', () => {
    const { data, gaps } = readData(registry, 'home', {
      fields: { title: 'Home' },
      slots: { hero: { enabled: true, data: { headline: 'Hi' } }, features },
    })
    expect(data.slots.hero!.data.variant).toBe('light')
    expect(gaps).toEqual([])
  })

  it('a disabled optional slot is read and carried but reports no gaps', () => {
    const { data, gaps } = readData(registry, 'home', {
      fields: { title: 'Home' },
      slots: {
        hero: { enabled: true, data: { headline: 'Hi' } },
        features,
        quotes: { enabled: false, data: { extra: 1 } },
      },
    })
    expect(data.slots.quotes).toEqual({ enabled: false, data: { extra: 1 } })
    expect(gaps).toEqual([])
  })

  it('reads a slot whose stored value isn\'t an object', () => {
    const { data } = readData(registry, 'home', { fields: {}, slots: { hero: null, features: 'x', quotes: [] } })
    expect(data.slots.hero).toEqual({ enabled: true, data: { variant: 'light' } })
    expect(data.slots.features).toEqual({ enabled: true, data: {} })
    expect(data.slots.quotes).toEqual({ enabled: false, data: {} })
  })

  it('reads a revision that isn\'t a document', () => {
    for (const raw of [null, [], {}, 'text']) {
      const { data, gaps } = readData(registry, 'about', raw)
      expect(data).toEqual({ fields: {}, slots: {} })
      expect(gaps).toEqual([['fields', 'title'], ['fields', 'body']])
    }
  })

  it('a reintroduced field with a different type is unfit', () => {
    const { data, gaps } = readData(buildRegistry(ratedSite), 'testimonials', {
      fields: { quote: 'Great', author: 'Maria', rating: 'five stars' },
      slots: {},
    })
    expect(data.fields.rating).toBeUndefined()
    expect(gaps).toEqual([['fields', 'rating']])
    expect(readData(buildRegistry(ratedSite), 'testimonials', { fields: { quote: 'G', author: 'M', rating: 'x' }, slots: {} }, { fill: true }).data.fields.rating).toBe(0)
  })

  it('reads a required object that was never stored as if it were empty: defaults fill, required fields are gaps', () => {
    const { data, gaps } = readData(registry, 'home', { fields: { title: 'Home' }, slots: { hero: null } })
    expect(data.slots.hero!.data).toEqual({ variant: 'light' })
    expect(gaps).toContainEqual(['slots', 'hero', 'data', 'headline'])
    const filled = readData(registry, 'home', { fields: { title: 'Home' }, slots: { hero: null } }, { fill: true })
    expect(filled.data.slots.hero!.data).toEqual({ headline: '', variant: 'light' })
  })

  it('reads a missing required group through its schema and leaves a missing optional group absent', () => {
    const schema = z.object({
      g: f.group({ a: f.text({ label: 'A' }).default('x'), b: f.text({ label: 'B' }) }, { label: 'G' }),
      o: f.group({ a: f.text({ label: 'A' }).default('x') }, { label: 'O' }).optional(),
    })
    const gaps: Array<Array<string | number>> = []
    expect(readValue(schema, {}, { fill: false }, ['fields'], gaps)).toEqual({ g: { a: 'x' } })
    expect(gaps).toEqual([['fields', 'g', 'b']])
  })

  it('a stored null for a required field is a gap, not a crash', () => {
    const { data, gaps } = readData(registry, 'about', { fields: { title: null, body: 'b' }, slots: {} })
    expect(data.fields.title).toBeUndefined()
    expect(gaps).toEqual([['fields', 'title']])
  })
})

describe('readValue fills each kind\'s empty value', () => {
  const cases: Array<[z.ZodType, unknown]> = [
    [f.text({ label: 'T' }), ''],
    [f.textarea({ label: 'T' }), ''],
    [f.date({ label: 'D' }), ''],
    [f.datetime({ label: 'D' }), ''],
    [f.richText({ label: 'R' }), { type: 'doc', content: [] }],
    [f.number({ label: 'N' }), 0],
    [f.select(['a', 'b'], { label: 'S' }), 'a'],
    [f.list(z.object({ t: f.text({ label: 't' }) }), { label: 'L', min: 1 }), []],
    [f.ref('posts', { label: 'R', many: true }), []],
    [f.ref('posts', { label: 'R' }), ''],
    [f.image({ label: 'I' }), { media: '' }],
    [f.file({ label: 'F' }), { media: '' }],
    [f.link({ label: 'L' }), { url: '' }],
  ]
  it.each(cases)('%#', (schema, empty) => {
    const gaps: Array<Array<string | number>> = []
    expect(readValue(schema, undefined, { fill: true }, ['x'], gaps)).toEqual(empty)
    expect(readValue(schema, undefined, { fill: false }, ['x'], [])).toBeUndefined()
  })

  it('a boolean takes its built-in default false, filled or not, without a gap', () => {
    const gaps: Array<Array<string | number>> = []
    expect(readValue(f.boolean({ label: 'B' }), undefined, { fill: true }, ['x'], gaps)).toBe(false)
    expect(readValue(f.boolean({ label: 'B' }), undefined, { fill: false }, ['x'], gaps)).toBe(false)
    expect(gaps).toEqual([])
  })

  it('a boolean that does not fit takes its default false without a gap', () => {
    for (const fill of [true, false]) {
      const gaps: Array<Array<string | number>> = []
      expect(readValue(f.boolean({ label: 'B' }), 'yes', { fill }, ['x'], gaps)).toBe(false)
      expect(gaps).toEqual([])
    }
  })

  it('a nullable field stored as null reads as null; an optional one reads as absent', () => {
    const gaps: Array<Array<string | number>> = []
    expect(readValue(f.text({ label: 'T' }).nullable(), null, { fill: false }, ['x'], gaps)).toBeNull()
    expect(readValue(f.text({ label: 'T' }).nullish(), null, { fill: false }, ['x'], gaps)).toBeNull()
    expect(readValue(f.text({ label: 'T' }).optional(), null, { fill: false }, ['x'], gaps)).toBeUndefined()
    expect(gaps).toEqual([])
  })

  it('a custom optional leaf that does not fit is absent without a gap', () => {
    const custom = defineField(z.string().optional(), { kind: 'custom', label: 'C', empty: '' })
    for (const fill of [true, false]) {
      const gaps: Array<Array<string | number>> = []
      expect(readValue(custom, 42, { fill }, ['x'], gaps)).toBeUndefined()
      expect(gaps).toEqual([])
    }
  })
})

describe('readValue checks a list\'s own limits', () => {
  const item = z.object({ t: f.text({ label: 't' }) })

  it('a list under its minimum is a gap', () => {
    const list = f.list(item, { label: 'L', min: 1 })
    const gaps: Array<Array<string | number>> = []
    expect(readValue(list, [], { fill: false }, ['x'], gaps)).toBeUndefined()
    expect(gaps).toEqual([['x']])
    expect(readValue(list, [], { fill: true }, ['x'], [])).toEqual([])
  })

  it('a list over its maximum is a gap', () => {
    const list = f.list(item, { label: 'L', max: 1 })
    const gaps: Array<Array<string | number>> = []
    expect(readValue(list, [{ t: 'a' }, { t: 'b' }], { fill: false }, ['x'], gaps)).toBeUndefined()
    expect(gaps).toEqual([['x']])
    expect(readValue(list, [{ t: 'a' }, { t: 'b' }], { fill: true }, ['x'], [])).toEqual([])
  })

  it('a list within its limits keeps items with gaps inside them', () => {
    const list = f.list(item, { label: 'L', min: 1, max: 2 })
    const gaps: Array<Array<string | number>> = []
    expect(readValue(list, [{}], { fill: false }, ['x'], gaps)).toEqual([{}])
    expect(gaps).toEqual([['x', 0, 't']])
  })

  it('drops an item of a leaf field that does not fit, without a gap', () => {
    const list = f.list(f.image({ label: 'I' }), { label: 'L' })
    for (const fill of [true, false]) {
      const gaps: Array<Array<string | number>> = []
      const media = 'a'.repeat(64)
      expect(readValue(list, [{ nope: 1 }, { media }], { fill }, ['x'], gaps)).toEqual([{ media }])
      expect(gaps).toEqual([])
    }
  })
})

describe('readData with a developer default that does not fit', () => {
  it('does not throw and reports the group\'s fields', () => {
    const fields = BasicPage.fields.extend({
      g: f.group({ a: f.text({ label: 'A' }) }, { label: 'G' }).prefault({} as { a: string }),
    })
    const prefaulted = buildRegistry(withType(site, 'about', { template: { ...BasicPage, name: 'prefaultedPage', fields } }))
    const raw = { fields: { title: 'T', body: 'B' }, slots: {} }
    expect(() => readData(prefaulted, 'about', raw)).not.toThrow()
    expect(readData(prefaulted, 'about', raw).gaps).toEqual([['fields', 'g', 'a']])
  })
})
