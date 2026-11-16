import { createCore } from '../../src/core/core.js'
import type { SiteDefinition } from '../../src/core/registry/define.js'
import { makeCore } from '../helpers/core.js'
import { noTestimonialsSite, postSummarySite, ratedSite } from '../fixtures/evolve.js'
import { withoutLocale } from '../fixtures/site.js'

/** `ratedSite` without Spanish: Spanish content is hidden. */
const ratedEnglishSite: SiteDefinition = withoutLocale(ratedSite, 'es')

describe('gaps', () => {
  it('lists published documents whose required fields have no value, with labelled issues', async () => {
    const { core, db, editor, owner } = await makeCore()
    await core.applyShippedContent()
    const a = await core.createEntry('posts', { slug: 'a', fields: { title: 'A', date: '2026-01-01', body: 'x' } }, editor)
    await core.createEntry('posts', { slug: 'b', fields: { title: 'B', date: '2026-01-02', body: 'y' } }, editor)
    await core.publish([a.id], owner)
    const next = createCore({ site: postSummarySite, db })
    const gaps = await next.listGaps()
    expect(gaps.map((g) => g.document.id)).toEqual([a.id])
    expect(gaps[0]!.issues).toEqual([expect.objectContaining({ path: ['fields', 'summary'], labels: ['Summary'], code: 'required' })])
    expect(gaps[0]!.issues[0]!.message).toBe('Summary is required.')
    expect(await next.gapSummary()).toEqual([{ type: 'posts', label: 'Posts', documents: 1, locales: { en: 1 } }])
    expect((await next.listGaps({ type: 'home' })).length).toBe(0)
  })

  it('looks only at the documents and types asked for', async () => {
    const { core, db, editor, owner } = await makeCore()
    await core.applyShippedContent()
    const a = await core.createEntry('posts', { slug: 'a', fields: { title: 'A', date: '2026-01-01', body: 'x' } }, editor)
    const b = await core.createEntry('posts', { slug: 'b', fields: { title: 'B', date: '2026-01-02', body: 'y' } }, editor)
    await core.publish([a.id, b.id], owner)
    const next = createCore({ site: postSummarySite, db })
    const ids = async (opts: Parameters<typeof next.listGaps>[0]) => (await next.listGaps(opts)).map((g) => g.document.id)
    expect(await ids({ ids: [b.id] })).toEqual([b.id])
    expect(await ids({ ids: [b.id, a.id] })).toEqual([a.id, b.id])
    expect(await ids({ ids: [] })).toEqual([])
    expect(await ids({ types: ['home', 'posts'] })).toEqual([a.id, b.id])
    expect(await ids({ types: ['home', 'about'] })).toEqual([])
    expect(await ids({ types: [] })).toEqual([])
    expect(await ids({ types: ['posts'], ids: [a.id] })).toEqual([a.id])
  })

  it('ignores drafts, deleted entries and hidden types', async () => {
    const { core, db, editor, owner } = await makeCore()
    await core.applyShippedContent()
    const maria = (await core.listEntries('testimonials'))[0]!
    const extra = await core.createEntry('testimonials', { fields: { quote: 'Q', author: 'Zed' } }, editor)
    await core.publish([maria.id, extra.id], owner)
    await core.deleteEntry(extra.groupId, editor)
    const rated = createCore({ site: ratedSite, db })
    expect((await rated.listGaps()).map((g) => g.document.id)).toEqual([maria.id])
    const hidden = createCore({ site: noTestimonialsSite, db })
    expect(await hidden.listGaps()).toEqual([])
  })

  it('ignores a published document in a locale the site no longer has', async () => {
    const { core, db, editor, owner } = await makeCore()
    await core.applyShippedContent()
    const maria = (await core.listEntries('testimonials'))[0]!
    const es = await core.createTranslation(maria.groupId, 'es', editor)
    await core.publish([es.id], owner)
    const all = (await createCore({ site: ratedSite, db }).listGaps()).map((g) => g.document.id)
    expect(all).toContain(es.id)
    const english = (await createCore({ site: ratedEnglishSite, db }).listGaps()).map((g) => g.document.id)
    expect(english).toEqual(all.filter((id) => id !== es.id))
    expect(await createCore({ site: ratedEnglishSite, db }).gapSummary()).toEqual([
      { type: 'testimonials', label: 'Testimonials', documents: english.length, locales: { en: english.length } },
    ])
    expect((await createCore({ site: ratedSite, db }).gapSummary())[0]?.locales).toEqual({ en: all.length - 1, es: 1 })
  })

  it('a number field with no value is a gap', async () => {
    const { core, db, owner } = await makeCore()
    await core.applyShippedContent()
    const maria = (await core.listEntries('testimonials'))[0]!
    await core.publish([maria.id], owner)
    const rated = createCore({ site: ratedSite, db })
    expect((await rated.listGaps())[0]!.issues[0]!.path).toEqual(['fields', 'rating'])
  })

  it('an empty is never saved and never publishes', async () => {
    const { core, db, editor, owner } = await makeCore()
    await core.applyShippedContent()
    const maria = (await core.listEntries('testimonials'))[0]!
    await core.publish([maria.id], owner)
    const rated = createCore({ site: ratedSite, db })
    const doc = (await rated.getDocument(maria.id))!
    expect(doc.data.fields.rating).toBeUndefined()
    const saved = await rated.saveDraft(maria.id, { baseRevisionId: doc.headRev, data: { ...doc.data, fields: { ...doc.data.fields, quote: 'Changed' } } }, editor)
    const json = (await db.selectFrom('revisions').select('data').where('id', '=', saved.document.headRev).executeTakeFirstOrThrow()).data
    expect(JSON.parse(json).fields).not.toHaveProperty('rating')
    const err = await rated.publish([maria.id], owner, { dryRun: true }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toMatchObject({ code: 'validation', messageId: 'error.publishFailed' })
    expect(JSON.stringify((err as { details: unknown }).details)).toContain('Rating is required')
    const live = await rated.liveEntries('testimonials', 'en')
    expect(live[0]!.data.fields.rating).toBe(0)
  })
})
