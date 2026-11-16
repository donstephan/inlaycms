import type { Kysely } from 'kysely'
import type { Core } from '../../src/core/core.js'
import type { Database } from '../../src/core/db/schema.js'
import { createCore } from '../../src/core/core.js'
import { InlayError } from '../../src/core/errors.js'
import type { Ctx, DocumentData, DocumentView } from '../../src/core/types.js'
import { f } from '../../src/core/fields/builtins.js'
import { homeTitledSite, ratedSite, withType } from '../fixtures/evolve.js'
import { HomePage, site, Testimonial } from '../fixtures/site.js'
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

describe('saveDraft', () => {
  let core: Core
  let db: Kysely<Database>
  let owner: Ctx
  let editor: Ctx
  let home: DocumentView
  let maria: string

  beforeEach(async () => {
    ;({ core, db, owner, editor } = await makeCore())
    await core.applyShippedContent()
    home = (await core.getDocument((await core.findSingleton('home'))!.id))!
    maria = (await core.listEntries('testimonials'))[0]!.groupId
  })

  const withHeadline = (data: DocumentData, headline: string): DocumentData => {
    const next = structuredClone(data)
    next.slots.hero!.data.headline = headline
    return next
  }

  const withQuotes = (data: DocumentData, items: string[]): DocumentData => {
    const next = structuredClone(data)
    next.slots.quotes = { enabled: true, data: { items } }
    return next
  }

  const revisionCount = async (documentId: string) =>
    (await db.selectFrom('revisions').select('id').where('document_id', '=', documentId).execute()).length

  it('saves a new head draft and leaves the published revision alone', async () => {
    const result = await core.saveDraft(
      home.id,
      { baseRevisionId: home.headRev, data: withHeadline(home.data, 'Hello there'), message: 'New headline' },
      editor,
    )
    expect(result.changed).toBe(true)
    expect(result.diff).toMatchObject([
      { labels: ['Hero', 'Headline'], change: 'changed', before: 'Welcome to Inlay', after: 'Hello there' },
    ])
    const doc = result.document
    expect(doc.headRev).toBeGreaterThan(home.headRev)
    expect(doc.headRev).toBe(doc.revision.id)
    expect(doc.publishedRev).toBe(home.publishedRev)
    expect(doc.revision).toMatchObject({ source: 'admin', message: 'New headline', authorName: 'Eddie Editor' })
    expect(doc.data.slots.hero!.data.headline).toBe('Hello there')
    expect((await core.getDocument(home.id, { state: 'published' }))!.data.slots.hero!.data.headline).toBe(
      'Welcome to Inlay',
    )
    expect((await core.listPendingChanges()).map((d) => d.id)).toEqual([home.id])
  })

  it('rejects a stale base revision with a conflict naming the document', async () => {
    await core.saveDraft(home.id, { baseRevisionId: home.headRev, data: withHeadline(home.data, 'One') }, editor)
    const e = await rejection(
      core.saveDraft(home.id, { baseRevisionId: home.headRev, data: withHeadline(home.data, 'Two') }, owner),
    )
    expect(e.code).toBe('conflict')
    expect(e.message).toContain('Home')
    expect((await core.getDocument(home.id))!.data.slots.hero!.data.headline).toBe('One')
  })

  it('lets exactly one of two concurrent saves with the same base win', async () => {
    const results = await Promise.allSettled([
      core.saveDraft(home.id, { baseRevisionId: home.headRev, data: withHeadline(home.data, 'Assistant') }, editor),
      core.saveDraft(home.id, { baseRevisionId: home.headRev, data: withHeadline(home.data, 'Admin') }, owner),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toBeInstanceOf(InlayError)
    expect((rejected[0]!.reason as InlayError).code).toBe('conflict')
    expect(await revisionCount(home.id)).toBe(2)
  })

  it('writes nothing when the data is unchanged', async () => {
    const before = await revisionCount(home.id)
    const result = await core.saveDraft(home.id, { baseRevisionId: home.headRev, data: home.data }, editor)
    expect(result.changed).toBe(false)
    expect(result.diff).toEqual([])
    expect(result.document.headRev).toBe(home.headRev)
    expect(await revisionCount(home.id)).toBe(before)
    expect(await core.listPendingChanges()).toEqual([])
  })

  it('checks document references', async () => {
    const post = await core.createEntry('posts', { fields: { title: 'A post' } }, editor)
    const notFound = (await core.findSingleton('notFound'))!

    let e = await rejection(
      core.saveDraft(home.id, { baseRevisionId: home.headRev, data: withQuotes(home.data, [crypto.randomUUID()]) }, editor),
    )
    expect(e.code).toBe('validation')
    expect(e.details.issues).toEqual([
      expect.objectContaining({
        code: 'not_found',
        labels: ['Testimonials', 'Testimonials'],
        path: ['slots', 'quotes', 'data', 'items', 0],
      }),
    ])

    e = await rejection(
      core.saveDraft(home.id, { baseRevisionId: home.headRev, data: withQuotes(home.data, [post.groupId]) }, editor),
    )
    expect(e.details.issues).toEqual([expect.objectContaining({ code: 'wrong_collection' })])

    const linked = structuredClone(home.data)
    linked.slots.hero!.data.cta = { document: notFound.groupId }
    e = await rejection(core.saveDraft(home.id, { baseRevisionId: home.headRev, data: linked }, editor))
    expect(e.details.issues).toEqual([
      expect.objectContaining({ code: 'not_routable', labels: ['Hero', 'Button'] }),
    ])
    expect(await revisionCount(home.id)).toBe(1)
  })

  it('validates at draft level', async () => {
    const e = await rejection(
      core.saveDraft(home.id, { baseRevisionId: home.headRev, data: withHeadline(home.data, 'x'.repeat(61)) }, editor),
    )
    expect(e.code).toBe('validation')
    expect(e.details.issues?.[0]).toMatchObject({ code: 'too_long', labels: ['Hero', 'Headline'] })
  })

  it('keeps the refs table in step with head and published revisions', async () => {
    const joe = await core.createEntry('testimonials', { fields: { quote: 'Great.', author: 'Joe' } }, editor)
    const refs = () =>
      db
        .selectFrom('refs')
        .select(['from_revision_id', 'to_id'])
        .where('from_document_id', '=', home.id)
        .orderBy('from_revision_id')
        .execute()

    const first = await core.saveDraft(
      home.id,
      { baseRevisionId: home.headRev, data: withQuotes(home.data, [maria]) },
      editor,
    )
    expect(await refs()).toEqual([{ from_revision_id: first.document.headRev, to_id: maria }])

    const second = await core.saveDraft(
      home.id,
      { baseRevisionId: first.document.headRev, data: withQuotes(home.data, [joe.groupId]) },
      editor,
    )
    expect(await refs()).toEqual([{ from_revision_id: second.document.headRev, to_id: joe.groupId }])

    await core.publish([home.id], owner)
    const third = await core.saveDraft(
      home.id,
      { baseRevisionId: second.document.headRev, data: withQuotes(home.data, [maria]) },
      editor,
    )
    expect(await refs()).toEqual([
      { from_revision_id: second.document.headRev, to_id: joe.groupId },
      { from_revision_id: third.document.headRev, to_id: maria },
    ])
  })

  it('keeps entry slugs unique and fills a missing slug from the head', async () => {
    const a = await core.createEntry('posts', { fields: { title: 'Alpha' } }, editor)
    const b = await core.createEntry('posts', { fields: { title: 'Beta' } }, editor)

    const clash = { ...structuredClone(b.data), slug: 'alpha' }
    const e = await rejection(core.saveDraft(b.id, { baseRevisionId: b.headRev, data: clash }, editor))
    expect(e.details.issues).toEqual([expect.objectContaining({ code: 'duplicate_slug', path: ['slug'] })])

    const own = await core.saveDraft(
      a.id,
      { baseRevisionId: a.headRev, data: { ...a.data, fields: { ...a.data.fields, title: 'Alpha 2' } } },
      editor,
    )
    expect(own.document.data.slug).toBe('alpha')

    const { slug: _omit, ...noSlug } = own.document.data
    const kept = await core.saveDraft(
      a.id,
      { baseRevisionId: own.document.headRev, data: { ...noSlug, fields: { ...noSlug.fields, title: 'Alpha 3' } } },
      editor,
    )
    expect(kept.document.data.slug).toBe('alpha')
    const row = await db.selectFrom('documents').select('head_slug').where('id', '=', a.id).executeTakeFirstOrThrow()
    expect(row.head_slug).toBe('alpha')
  })

  it('rejects unknown and deleted documents', async () => {
    expect(
      (await rejection(core.saveDraft(crypto.randomUUID(), { baseRevisionId: 1, data: home.data }, editor))).code,
    ).toBe('not_found')
    const post = await core.createEntry('posts', { fields: { title: 'Gone' } }, editor)
    await db.updateTable('documents').set({ deleted_at: '2026-02-01T00:00:00.000Z' }).where('id', '=', post.id).execute()
    expect((await rejection(core.saveDraft(post.id, { baseRevisionId: post.headRev, data: post.data }, editor))).code).toBe(
      'invalid_operation',
    )
  })
})


describe('schema changes', () => {
  const stored = async (db: Kysely<Database>, revId: number) =>
    JSON.parse((await db.selectFrom('revisions').select('data').where('id', '=', revId).executeTakeFirstOrThrow()).data)

  it('a save under a new schema carries the old field through', async () => {
    const { core, db, editor } = await makeCore()
    await core.applyShippedContent()
    const id = (await core.findSingleton('home'))!.id
    const titled = createCore({ site: homeTitledSite, db, now: () => new Date('2026-02-01T00:00:00Z') })
    const doc = (await titled.getDocument(id))!
    expect(doc.data.slots.hero!.data.headline).toBe('Welcome to Inlay')
    const next = structuredClone(doc.data)
    next.slots.hero!.data = { title: 'New title', variant: 'light' }
    const saved = await titled.saveDraft(id, { baseRevisionId: doc.headRev, data: next }, editor)
    expect(await stored(db, saved.document.headRev)).toMatchObject({
      slots: { hero: { data: { title: 'New title', headline: 'Welcome to Inlay' } } },
    })
    const back = (await core.getDocument(id))!
    expect(back.data.slots.hero!.data.headline).toBe('Welcome to Inlay')
  })

  it('a patch under a new schema carries the old field through', async () => {
    const { core, db, editor } = await makeCore()
    await core.applyShippedContent()
    const id = (await core.findSingleton('home'))!.id
    const titled = createCore({ site: homeTitledSite, db })
    const doc = (await titled.getDocument(id))!
    const saved = await titled.patchDraft(
      id,
      { baseRevisionId: doc.headRev, ops: [{ path: ['slots', 'hero', 'data', 'title'], value: 'Patched' }] },
      editor,
    )
    expect(await stored(db, saved.document.headRev)).toMatchObject({ slots: { hero: { data: { title: 'Patched', headline: 'Welcome to Inlay' } } } })
  })

  it('a stored value that no longer fits survives an unrelated save and reads again when it fits', async () => {
    const { core, db, editor } = await makeCore()
    await core.applyShippedContent()
    const textRated = withType(site, 'testimonials', {
      template: { ...Testimonial, fields: Testimonial.fields.extend({ rating: f.text({ label: 'Rating' }) }) },
    })
    const id = (await core.listEntries('testimonials'))[0]!.id
    const asText = createCore({ site: textRated, db })
    const first = (await asText.getDocument(id))!
    const rated = await asText.saveDraft(
      id,
      { baseRevisionId: first.headRev, data: { ...first.data, fields: { ...first.data.fields, rating: 'five stars' } } },
      editor,
    )
    const numbered = createCore({ site: ratedSite, db })
    const doc = (await numbered.getDocument(id))!
    expect(doc.data.fields.rating).toBeUndefined()
    expect((await numbered.saveDraft(id, { baseRevisionId: doc.headRev, data: doc.data }, editor)).changed).toBe(false)
    const saved = await numbered.saveDraft(
      id,
      { baseRevisionId: rated.document.headRev, data: { ...doc.data, fields: { ...doc.data.fields, quote: 'Changed' } } },
      editor,
    )
    expect(saved.changed).toBe(true)
    expect((await stored(db, saved.document.headRev)).fields).toMatchObject({ quote: 'Changed', rating: 'five stars' })
    expect((await asText.getDocument(id))!.data.fields.rating).toBe('five stars')
  })

  it('a removed slot survives a save and comes back when the slot returns', async () => {
    const { core, db, editor } = await makeCore()
    await core.applyShippedContent()
    const id = (await core.findSingleton('home'))!.id
    const maria = (await core.listEntries('testimonials'))[0]!.groupId
    const quotes = { enabled: true, data: { heading: 'Kind words', items: [maria] } }
    const first = (await core.getDocument(id))!
    const withQuotes = structuredClone(first.data)
    withQuotes.slots.quotes = quotes
    await core.saveDraft(id, { baseRevisionId: first.headRev, data: withQuotes }, editor)
    const { quotes: _quotes, ...slots } = HomePage.slots
    const noQuotes = createCore({ site: withType(site, 'home', { template: { ...HomePage, slots } }), db })
    const doc = (await noQuotes.getDocument(id))!
    const next = structuredClone(doc.data)
    delete next.slots.quotes
    next.fields.title = 'Edited without quotes'
    const saved = await noQuotes.saveDraft(id, { baseRevisionId: doc.headRev, data: next }, editor)
    expect((await stored(db, saved.document.headRev)).slots.quotes).toEqual(quotes)
    const back = (await core.getDocument(id))!
    expect(back.data.slots.quotes).toEqual(quotes)
    expect(back.data.fields.title).toBe('Edited without quotes')
  })

  it('a cleared optional field stays cleared', async () => {
    const { core, editor } = await makeCore()
    await core.applyShippedContent()
    const id = (await core.findSingleton('home'))!.id
    const doc = (await core.getDocument(id))!
    const withSub = structuredClone(doc.data)
    withSub.slots.hero!.data.sub = 'Subheading'
    const one = await core.saveDraft(id, { baseRevisionId: doc.headRev, data: withSub }, editor)
    const cleared = structuredClone(one.document.data)
    delete cleared.slots.hero!.data.sub
    const two = await core.saveDraft(id, { baseRevisionId: one.document.headRev, data: cleared }, editor)
    expect(two.document.data.slots.hero!.data.sub).toBeUndefined()
  })
})
