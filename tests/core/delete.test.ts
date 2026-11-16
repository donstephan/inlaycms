import type { Kysely } from 'kysely'
import type { Core } from '../../src/core/core.js'
import type { Database } from '../../src/core/db/schema.js'
import { InlayError } from '../../src/core/errors.js'
import type { Ctx, DocumentView } from '../../src/core/types.js'
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

describe('deleting and restoring entries', () => {
  let core: Core
  let db: Kysely<Database>
  let owner: Ctx
  let editor: Ctx

  beforeEach(async () => {
    ;({ core, db, owner, editor } = await makeCore())
    await core.applyShippedContent()
  })

  const post = (title: string, extra: Record<string, unknown> = {}) =>
    core.createEntry('posts', { fields: { title, date: '2026-02-01', body: 'Hello', ...extra } }, editor)

  it('refuses to delete an entry that a draft uses, and allows it once the reference is gone', async () => {
    const maria = (await core.listEntries('testimonials'))[0]!
    const home = (await core.getDocument((await core.findSingleton('home'))!.id))!
    const patched = await core.patchDraft(
      home.id,
      {
        baseRevisionId: home.headRev,
        ops: [
          { path: ['slots', 'quotes', 'enabled'], value: true },
          { path: ['slots', 'quotes', 'data', 'items'], value: [maria.groupId] },
        ],
      },
      editor,
    )
    expect(await core.findUsages({ kind: 'document', id: maria.groupId })).toMatchObject([
      { documentId: home.id, title: 'Home', in: 'draft' },
    ])
    const err = await rejection(core.deleteEntry(maria.groupId, owner))
    expect(err.code).toBe('in_use')
    expect(err.details.usages).toHaveLength(1)
    expect(err.details.usages![0]).toMatchObject({ title: 'Home', in: 'draft' })

    await core.patchDraft(
      home.id,
      {
        baseRevisionId: patched.document.headRev,
        ops: [
          { path: ['slots', 'quotes', 'data', 'items'], value: [] },
          { path: ['slots', 'quotes', 'enabled'], value: false },
        ],
      },
      editor,
    )
    await core.deleteEntry(maria.groupId, owner)
    expect(await core.listEntries('testimonials')).toEqual([])
  })

  it('ignores references from other locales of the same entry', async () => {
    const en = await post('Self aware')
    const es = await core.createTranslation(en.groupId, 'es', editor)
    await core.patchDraft(
      es.id,
      { baseRevisionId: es.headRev, ops: [{ path: ['fields', 'related'], value: [en.groupId] }] },
      editor,
    )
    expect(await core.findUsages({ kind: 'document', id: en.groupId })).toEqual([])
    await core.deleteEntry(en.groupId, owner)
    const gone = (await core.getDocument(es.id))!
    expect(gone.deletedAt).not.toBeNull()
    expect(await db.selectFrom('refs').select('to_id').execute()).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ to_id: en.groupId })]),
    )
  })

  it('reports published use as published', async () => {
    const target = await post('Target')
    const user = await post('User', { related: [target.groupId] })
    await core.publish([user.id], editor)
    const [usage] = await core.findUsages({ kind: 'document', id: target.groupId })
    expect(usage).toMatchObject({ documentId: user.id, in: 'draft-and-published' })
  })

  it('unpublishes every locale when deleting, with one event', async () => {
    const en = await post('Published post')
    const es = await core.createTranslation(en.groupId, 'es', editor)
    await core.publish([en.id, es.id], editor)
    await core.deleteEntry(en.groupId, owner)
    for (const id of [en.id, es.id]) {
      const doc = (await core.getDocument(id))!
      expect(doc.deletedAt).not.toBeNull()
      expect(doc.publishedRev).toBeNull()
    }
    const events = await db.selectFrom('publish_events').selectAll().execute()
    const unpublish = events.filter((e) => JSON.parse(e.items)[0].action === 'unpublish')
    expect(unpublish).toHaveLength(1)
    expect(JSON.parse(unpublish[0]!.items)).toHaveLength(2)
    expect((await core.listPendingChanges()).map((d) => d.id)).not.toContain(en.id)
    expect((await core.listEntries('posts', { includeDeleted: true })).map((d) => d.id)).toContain(en.id)
  })

  it('lets only the owner restore, as unpublished drafts', async () => {
    const en = await post('Come back')
    await core.publish([en.id], editor)
    await core.deleteEntry(en.groupId, owner)
    expect((await rejection(core.restoreEntry(en.groupId, editor))).code).toBe('forbidden')
    const restored: DocumentView[] = await core.restoreEntry(en.groupId, owner)
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ id: en.id, deletedAt: null, publishedRev: null })
    expect((await core.listEntries('posts')).map((d) => d.id)).toContain(en.id)
  })

  it('gives a restored entry a new slug when another entry took it', async () => {
    const first = await post('Same title')
    await core.deleteEntry(first.groupId, owner)
    const second = await post('Same title')
    expect(second.data.slug).toBe('same-title')
    const [restored] = await core.restoreEntry(first.groupId, owner)
    expect(restored!.data.slug).toBe('same-title-2')
    expect(restored!.revision.source).toBe('restore')
    expect(restored!.headRev).toBeGreaterThan(first.headRev)
  })

  it('refuses to delete something that is not an entry', async () => {
    const home = await core.findSingleton('home')
    expect((await rejection(core.deleteEntry(home!.groupId, owner))).code).toBe('invalid_operation')
  })
})
