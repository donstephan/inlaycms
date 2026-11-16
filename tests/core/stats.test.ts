import { jpeg, pdf, png } from '../fixtures/media.js'
import { makeCore } from '../helpers/core.js'

describe('counts and checks', () => {
  const post = (core: Awaited<ReturnType<typeof makeCore>>['core'], ctx: Awaited<ReturnType<typeof makeCore>>['editor'], title: string, extra: Record<string, unknown> = {}) =>
    core.createEntry('posts', { fields: { title, date: '2026-02-01', body: 'Hello', ...extra } }, ctx)

  it('counts entries per collection in the default language', async () => {
    const { core, editor, owner } = await makeCore()
    const a = await post(core, editor, 'A')
    await post(core, editor, 'B')
    const c = await post(core, editor, 'C')
    await core.createTranslation(a.groupId, 'es', editor)
    await core.deleteEntry(c.groupId, owner)
    expect(await core.countEntries()).toEqual({
      posts: { total: 2, changed: 0 },
      testimonials: { total: 0, changed: 0 },
    })
  })

  it('counts entries changed since a time', async () => {
    const { core, editor } = await makeCore()
    await post(core, editor, 'A')
    const b = await post(core, editor, 'B')
    const later = new Date(new Date(b.updatedAt).getTime() + 1).toISOString()
    await post(core, editor, 'C')
    expect((await core.countEntries({ changedSince: later })).posts).toEqual({ total: 3, changed: 1 })
  })

  it('sums media and counts images without a description', async () => {
    const { core, owner } = await makeCore({ media: true })
    const one = await core.addMedia({ data: await png(10, 10), filename: 'a.png' }, owner)
    const two = await core.addMedia({ data: await jpeg(12, 12), filename: 'b.jpg' }, owner)
    const doc = await core.addMedia({ data: pdf(), filename: 'c.pdf' }, owner)
    await core.setMediaAlt(one.media.id, 'A square', owner)
    expect(await core.mediaStats()).toEqual({
      count: 3,
      totalBytes: one.media.size + two.media.size + doc.media.size,
      imagesWithoutAlt: 1,
    })
  })

  it('finds content that links to deleted content', async () => {
    const { core, editor, owner } = await makeCore()
    const a = await post(core, editor, 'A')
    const b = await post(core, editor, 'B')
    await core.deleteEntry(a.groupId, owner)
    await core.saveDraft(b.id, { baseRevisionId: b.headRev, data: { ...b.data, fields: { ...b.data.fields, related: [a.groupId] } } }, editor)
    expect((await core.brokenReferences()).map((d) => d.id)).toEqual([b.id])
  })

  it('ignores links to content that still exists and links from deleted content', async () => {
    const { core, editor, owner } = await makeCore()
    const a = await post(core, editor, 'A')
    await post(core, editor, 'B', { related: [a.groupId] })
    expect(await core.brokenReferences()).toEqual([])

    const target = await post(core, editor, 'Target')
    const c = await post(core, editor, 'C', { related: [target.groupId] })
    await core.deleteEntry(c.groupId, owner)
    await core.deleteEntry(target.groupId, owner)
    expect(await core.brokenReferences()).toEqual([])
  })
})
