import { t } from '../../src/core/messages/index.js'
import type { Core } from '../../src/core/core.js'
import { InlayError } from '../../src/core/errors.js'
import type { Ctx, DocumentView } from '../../src/core/types.js'
import { png } from '../fixtures/media.js'
import { makeCore } from '../helpers/core.js'

async function rejection(promise: Promise<unknown>): Promise<InlayError> {
  try {
    await promise
  } catch (e) {
    expect(e).toBeInstanceOf(InlayError)
    return e as InlayError
  }
  throw new Error('expected a rejection')
}

describe('patchDraft', () => {
  let core: Core
  let editor: Ctx
  let owner: Ctx
  let home: DocumentView

  beforeEach(async () => {
    ;({ core, editor, owner } = await makeCore({ media: true }))
    await core.applyShippedContent()
    home = (await core.getDocument((await core.findSingleton('home'))!.id))!
  })

  const patch = async (ops: Array<{ path: Array<string | number>; value?: unknown }>) => {
    const current = (await core.getDocument(home.id))!
    return core.patchDraft(home.id, { baseRevisionId: current.headRev, ops }, editor)
  }

  it('changes only the patched field', async () => {
    const result = await patch([{ path: ['slots', 'hero', 'data', 'headline'], value: 'New' }])
    expect(result.changed).toBe(true)
    const expected = structuredClone(home.data)
    expected.slots.hero!.data.headline = 'New'
    expect(result.document.data).toEqual(expected)
  })

  it('rejects an unknown field, naming the valid ones, and saves nothing', async () => {
    const e = await rejection(patch([{ path: ['slots', 'hero', 'data', 'headlin'], value: 'New' }]))
    expect(e.code).toBe('validation')
    const issues = e.details.issues!
    expect(issues).toHaveLength(1)
    expect(issues[0]!.code).toBe('unknown_field')
    expect(issues[0]!.message).toContain('headline')
    expect((await core.getDocument(home.id))!.headRev).toBe(home.headRev)
  })

  it('reports a problem in every op, and every unknown key in a value, not just the first', async () => {
    const e = await rejection(
      patch([
        { path: ['slots', 'hero', 'data', 'headlin'], value: 'New' },
        { path: ['slots', 'hero', 'data'], value: { headline: 'Hi', sub: 'S', a: 1, b: 2 } },
      ]),
    )
    expect(e.details.issues!.map((i) => i.path)).toEqual([
      ['slots', 'hero', 'data', 'headlin'],
      ['slots', 'hero', 'data', 'a'],
      ['slots', 'hero', 'data', 'b'],
    ])
  })

  it('reports problems with the paths and with the values together', async () => {
    const e = await rejection(
      patch([
        { path: ['fields', 'titel'], value: 'x' },
        { path: ['fields', 'title'], value: 5 },
      ]),
    )
    expect(e.details.issues!.map((i) => [i.path, i.message])).toEqual([
      [['fields', 'titel'], expect.stringContaining('has no field called "titel"')],
      [['fields', 'title'], t('issue.expectedText', { field: 'Title' })],
    ])
  })

  it('says a template has no parts when it has none', async () => {
    const about = (await core.findSingleton('about'))!
    const e = await rejection(core.patchDraft(about.id, { baseRevisionId: about.headRev, ops: [{ path: ['slots', 'nope'], value: {} }] }, editor))
    expect(e.details.issues![0]!.message).toBe(t('issue.noSlots', { name: 'nope' }))
  })

  it('names the valid parts of a template for an unknown slot', async () => {
    const e = await rejection(patch([{ path: ['slots', 'heroo', 'data', 'headline'], value: 'x' }]))
    expect(e.details.issues![0]!.message).toBe(
      t('issue.unknownSlot', { name: 'heroo', valid: 'hero (Hero), features (Features), quotes (Testimonials)' }),
    )
  })

  it('names the parent, not the unknown key, as the field', async () => {
    const e = await rejection(patch([{ path: ['slots', 'hero', 'data', 'headlin'], value: 'New' }]))
    const issue = e.details.issues![0]!
    expect(issue.path).toEqual(['slots', 'hero', 'data', 'headlin'])
    expect(issue.message).toMatch(/^Hero has no field called "headlin"/)
  })

  it('rejects unknown keys inside a list item value and saves nothing', async () => {
    const e = await rejection(patch([{ path: ['slots', 'features', 'data', 'cards', 0], value: { titel: 'Fast' } }]))
    const issues = e.details.issues!
    expect(issues).toHaveLength(1)
    expect(issues[0]!.code).toBe('unknown_field')
    expect(issues[0]!.path).toEqual(['slots', 'features', 'data', 'cards', 0, 'titel'])
    expect(issues[0]!.message).toContain('title (Title)')
    expect((await core.getDocument(home.id))!.headRev).toBe(home.headRev)
  })

  it('rejects unknown keys inside whole slot data', async () => {
    const e = await rejection(patch([{ path: ['slots', 'hero', 'data'], value: { headlin: 'Typo', sub: 'S' } }]))
    const issue = e.details.issues![0]!
    expect(issue.code).toBe('unknown_field')
    expect(issue.path).toEqual(['slots', 'hero', 'data', 'headlin'])
    expect(issue.message).toMatch(/^Hero has no field called "headlin"/)
  })

  it('rejects unknown keys nested in group and list values', async () => {
    const seo = await rejection(patch([{ path: ['fields', 'seo'], value: { titel: 'x' } }]))
    expect(seo.details.issues![0]!.path).toEqual(['fields', 'seo', 'titel'])
    const cards = await rejection(
      patch([{ path: ['slots', 'features', 'data', 'cards'], value: [{ title: 'A' }, { title: 'B', bdy: 'x' }] }]),
    )
    expect(cards.details.issues![0]!.path).toEqual(['slots', 'features', 'data', 'cards', 1, 'bdy'])
  })

  it('leaves leaf values such as images to validation', async () => {
    const { media } = await core.addMedia({ data: await png(10, 10), filename: 'photo.png' }, owner)
    const result = await patch([
      { path: ['slots', 'hero', 'data'], value: { headline: 'Hi', image: { media: media.id, alt: 'A' } } },
    ])
    expect(result.document.data.slots.hero!.data).toMatchObject({ headline: 'Hi', image: { media: media.id } })
  })

  it('rejects unknown top-level and slot keys', async () => {
    const a = await rejection(patch([{ path: ['bogus'], value: 1 }]))
    expect(a.details.issues![0]!.code).toBe('unknown_field')
    const b = await rejection(patch([{ path: ['slots', 'nope', 'data'], value: {} }]))
    expect(b.details.issues![0]!.code).toBe('unknown_field')
    expect(b.details.issues![0]!.message).toContain('hero')
    const c = await rejection(patch([{ path: ['slug'], value: 'x' }]))
    expect(c.details.issues![0]!.code).toBe('unknown_field')
  })

  it('appends to a list at index length and rejects a gap', async () => {
    const result = await patch([{ path: ['slots', 'features', 'data', 'cards', 1], value: { title: 'Second' } }])
    expect(result.document.data.slots.features!.data.cards).toHaveLength(2)
    const e = await rejection(patch([{ path: ['slots', 'features', 'data', 'cards', 3], value: { title: 'x' } }]))
    expect(e.details.issues![0]!.code).toBe('invalid')
  })

  it('switches an optional slot off, but not a required one', async () => {
    const on = await patch([{ path: ['slots', 'quotes', 'enabled'], value: true }])
    const quotes = await core.patchDraft(
      home.id,
      { baseRevisionId: on.document.headRev, ops: [{ path: ['slots', 'quotes', 'enabled'], value: false }] },
      editor,
    )
    expect(quotes.document.data.slots.quotes!.enabled).toBe(false)
    const e = await rejection(patch([{ path: ['slots', 'hero', 'enabled'], value: false }]))
    expect(e.details.issues![0]!.code).toBe('invalid')
  })

  it('removes an optional key when value is omitted', async () => {
    const set = await patch([{ path: ['slots', 'hero', 'data', 'sub'], value: 'Hi' }])
    expect(set.document.data.slots.hero!.data.sub).toBe('Hi')
    const removed = await core.patchDraft(
      home.id,
      { baseRevisionId: set.document.headRev, ops: [{ path: ['slots', 'hero', 'data', 'sub'] }] },
      editor,
    )
    expect('sub' in removed.document.data.slots.hero!.data).toBe(false)
  })

  it('creates missing optional groups on the way down', async () => {
    const result = await patch([{ path: ['fields', 'seo', 'title'], value: 'T' }])
    expect(result.document.data.fields.seo).toMatchObject({ title: 'T' })
  })

  it('sets a whole slot, checking its keys and its data keys', async () => {
    const on = await patch([{ path: ['slots', 'quotes'], value: { enabled: true, data: { heading: 'Kind words' } } }])
    expect(on.document.data.slots.quotes).toEqual({ enabled: true, data: { heading: 'Kind words' } })
    const key = await rejection(patch([{ path: ['slots', 'quotes'], value: { enabled: true, dat: {} } }]))
    expect(key.details.issues![0]).toMatchObject({ code: 'unknown_field', path: ['slots', 'quotes', 'dat'] })
    const nested = await rejection(patch([{ path: ['slots', 'quotes'], value: { enabled: true, data: { headng: 'x' } } }]))
    expect(nested.details.issues![0]).toMatchObject({ code: 'unknown_field', path: ['slots', 'quotes', 'data', 'headng'] })
    const off = await rejection(patch([{ path: ['slots', 'hero'], value: { enabled: false, data: { headline: 'x' } } }]))
    expect(off.details.issues![0]).toMatchObject({ code: 'invalid', path: ['slots', 'hero', 'enabled'] })
    const removed = await rejection(patch([{ path: ['slots', 'quotes'] }]))
    expect(removed.details.issues![0]).toMatchObject({ code: 'invalid', path: ['slots', 'quotes'] })
  })

  it('rejects removing whole slot data', async () => {
    const e = await rejection(patch([{ path: ['slots', 'hero', 'data'] }]))
    expect(e.details.issues![0]).toMatchObject({ code: 'invalid', path: ['slots', 'hero', 'data'] })
  })

  it('sets the whole fields object, checking its keys, but not removing it', async () => {
    const result = await patch([{ path: ['fields'], value: { title: 'Fresh' } }])
    expect(result.document.data.fields).toEqual({ title: 'Fresh' })
    const typo = await rejection(patch([{ path: ['fields'], value: { titel: 'x' } }]))
    expect(typo.details.issues![0]).toMatchObject({ code: 'unknown_field', path: ['fields', 'titel'] })
    const removed = await rejection(patch([{ path: ['fields'] }]))
    expect(removed.details.issues![0]).toMatchObject({ code: 'invalid', path: ['fields'] })
  })

  it('clears an optional field set to null', async () => {
    const set = await patch([{ path: ['slots', 'hero', 'data', 'sub'], value: 'Hi' }])
    const cleared = await core.patchDraft(
      home.id,
      { baseRevisionId: set.document.headRev, ops: [{ path: ['slots', 'hero', 'data', 'sub'], value: null }] },
      editor,
    )
    expect('sub' in cleared.document.data.slots.hero!.data).toBe(false)
  })

  it('checks permission before looking the document up', async () => {
    const viewer: Ctx = { ...editor, actor: { ...editor.actor, role: 'viewer' as never } }
    const e = await rejection(core.patchDraft('missing', { baseRevisionId: 1, ops: [] }, viewer))
    expect(e.code).toBe('forbidden')
  })

  it('applies ops in order and reports a stale base as a conflict', async () => {
    await patch([{ path: ['fields', 'title'], value: 'A' }])
    const e = await rejection(
      core.patchDraft(home.id, { baseRevisionId: home.headRev, ops: [{ path: ['fields', 'title'], value: 'B' }] }, editor),
    )
    expect(e.code).toBe('conflict')
  })
})
