import type { Kysely } from 'kysely'
import type { Core } from '../../src/core/core.js'
import type { Database } from '../../src/core/db/schema.js'
import { InlayError } from '../../src/core/errors.js'
import { diffData, formatDiff } from '../../src/core/content/diff.js'
import type { Ctx, DocumentData, DocumentView } from '../../src/core/types.js'
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

describe('history', () => {
  let core: Core
  let db: Kysely<Database>
  let owner: Ctx
  let editor: Ctx
  let home: DocumentView

  beforeEach(async () => {
    ;({ core, db, owner, editor } = await makeCore())
    await core.applyShippedContent()
    home = (await core.getDocument((await core.findSingleton('home'))!.id))!
  })

  const withHeadline = (data: DocumentData, headline: string): DocumentData => {
    const next = structuredClone(data)
    next.slots.hero!.data.headline = headline
    return next
  }
  const diff = (before: DocumentData | null, after: DocumentData) => diffData(core.registry, 'home', before, after)

  it('formats a headline edit', () => {
    const lines = formatDiff(diff(home.data, withHeadline(home.data, 'Hello there')))
    expect(lines).toEqual(['Hero → Headline: “Welcome to Inlay” → “Hello there”'])
  })

  it('reports an added card as one entry', () => {
    const next = structuredClone(home.data)
    ;(next.slots.features!.data.cards as unknown[]).push({ title: 'Simple' })
    const entries = diff(home.data, next)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      change: 'added',
      labels: ['Features', 'Cards', 'Item 2'],
      path: ['slots', 'features', 'data', 'cards', 1],
    })
    expect(formatDiff(entries)).toHaveLength(1)
  })

  it('reports a slot toggle', () => {
    const next = structuredClone(home.data)
    next.slots.quotes = { enabled: true, data: {} }
    const entries = diff(home.data, next)
    expect(entries).toEqual([
      { path: ['slots', 'quotes', 'enabled'], labels: ['Testimonials', 'Shown'], change: 'changed', before: false, after: true },
    ])
    expect(formatDiff(entries)).toEqual(['Testimonials → Shown: “no” → “yes”'])
  })

  it('reports data edits of a switched-off slot', async () => {
    const result = await core.patchDraft(
      home.id,
      { baseRevisionId: home.headRev, ops: [{ path: ['slots', 'quotes', 'data', 'heading'], value: 'Kind words' }] },
      editor,
    )
    expect(result.changed).toBe(true)
    expect(result.diff).toHaveLength(1)
    expect(result.diff[0]).toMatchObject({ labels: ['Testimonials', 'Heading'], change: 'added', after: 'Kind words' })
  })

  it('cuts long values to 80 characters', () => {
    const [line] = formatDiff(diff(home.data, withHeadline(home.data, 'x'.repeat(200))))
    const shown = line!.split('→ “').at(-1)!.replace(/”$/, '')
    expect(shown).toHaveLength(80)
    expect(shown.endsWith('…')).toBe(true)
  })

  it('treats a link as one leaf', () => {
    const before = structuredClone(home.data)
    before.slots.hero!.data.cta = { url: 'https://a.example', text: 'Go' }
    const after = structuredClone(before)
    after.slots.hero!.data.cta = { url: 'https://b.example', text: 'Go' }
    const entries = diff(before, after)
    expect(entries.map((e) => e.labels)).toEqual([['Hero', 'Button']])
    expect(entries[0]!.change).toBe('changed')
  })

  it('fills the diff of a save', async () => {
    const result = await core.saveDraft(
      home.id,
      { baseRevisionId: home.headRev, data: withHeadline(home.data, 'Hello there') },
      editor,
    )
    expect(result.diff).toHaveLength(1)
    expect(result.diff).toEqual(await core.diffRevisions(home.headRev, result.document.headRev))
    const noop = await core.saveDraft(home.id, { baseRevisionId: result.document.headRev, data: result.document.data }, editor)
    expect(noop.diff).toEqual([])
  })

  it('lists revisions newest first and gets one', async () => {
    const saved = await core.saveDraft(
      home.id,
      { baseRevisionId: home.headRev, data: withHeadline(home.data, 'Two'), message: 'Two' },
      editor,
    )
    const list = await core.listRevisions(home.id)
    expect(list.map((r) => r.id)).toEqual([saved.document.headRev, home.headRev])
    const rev = await core.getRevision(home.headRev)
    expect(rev).toMatchObject({ documentId: home.id, data: home.data })
    expect(await core.getRevision(99999)).toBeNull()
    expect((await rejection(core.listRevisions('nope'))).code).toBe('not_found')
  })

  it('restores an old revision as a new draft', async () => {
    const one = await core.saveDraft(home.id, { baseRevisionId: home.headRev, data: withHeadline(home.data, 'One') }, editor)
    await core.saveDraft(home.id, { baseRevisionId: one.document.headRev, data: withHeadline(home.data, 'Two') }, editor)
    const count = async () => (await db.selectFrom('revisions').select('id').where('document_id', '=', home.id).execute()).length
    const before = await count()
    const result = await core.restoreRevision(home.id, home.headRev, owner)
    expect(result.changed).toBe(true)
    expect(result.document.data).toEqual(home.data)
    expect(result.document.revision).toMatchObject({
      source: 'restore',
      message: `Restored from revision ${home.headRev}`,
    })
    expect(result.document.publishedRev).toBe(home.publishedRev)
    expect(result.diff).toHaveLength(1)
    expect(await count()).toBe(before + 1)
  })

  it('refuses to restore a revision of another document or without permission', async () => {
    const about = (await core.findSingleton('about'))!
    expect((await rejection(core.restoreRevision(home.id, about.headRev, owner))).code).toBe('invalid_operation')
  })

  it('rejects diffs across two documents', async () => {
    const about = (await core.findSingleton('about'))!
    const e = await rejection(core.diffRevisions(home.headRev, about.headRev))
    expect(e.code).toBe('invalid_operation')
    expect(await core.diffRevisions(null, home.headRev)).not.toHaveLength(0)
  })
})
