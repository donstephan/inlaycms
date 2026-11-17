import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { Core } from '../../src/core/core.js'
import type { Database } from '../../src/core/db/schema.js'
import { InlayError } from '../../src/core/errors.js'
import { f } from '../../src/core/fields/builtins.js'
import { defineField } from '../../src/core/fields/define.js'
import { defineCollection, defineSite, defineTemplate } from '../../src/core/registry/define.js'
import type { Ctx } from '../../src/core/types.js'
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

describe('publishing', () => {
  let core: Core
  let db: Kysely<Database>
  let owner: Ctx
  let editor: Ctx

  beforeEach(async () => {
    ;({ core, db, owner, editor } = await makeCore())
  })

  const valid = (title: string, extra: Record<string, unknown> = {}) =>
    core.createEntry('posts', { fields: { title, date: '2026-02-01', body: 'Hello', ...extra } }, editor)
  const events = () => db.selectFrom('publish_events').selectAll().execute()

  it('publishes a valid post', async () => {
    const doc = await valid('First')
    const result = await core.publish([doc.id], editor, { message: 'Go' })
    expect(result.eventId).not.toBeNull()
    expect(result.items).toEqual([{ documentId: doc.id, revisionId: doc.headRev, action: 'publish' }])
    const after = (await core.getDocument(doc.id))!
    expect(after.publishedRev).toBe(after.headRev)
    expect(await core.listPendingChanges()).toEqual([])
    const rows = await events()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.message).toBe('Go')
    expect(JSON.parse(rows[0]!.items)).toEqual(result.items)
    const row = await db.selectFrom('documents').selectAll().where('id', '=', doc.id).executeTakeFirstOrThrow()
    expect(row.published_slug).toBe(row.head_slug)
    expect(row.published_slug).toBe('first')
  })

  it('sets first_published_at on the first publish and keeps it through unpublish and republish', async () => {
    const doc = await valid('First')
    const column = async () =>
      (await db.selectFrom('documents').select('first_published_at').where('id', '=', doc.id).executeTakeFirstOrThrow()).first_published_at
    expect(await column()).toBeNull()
    await core.publish([doc.id], editor)
    const first = (await events())[0]!.at
    expect(await column()).toBe(first)
    await core.unpublish([doc.id], owner)
    expect(await column()).toBe(first)
    await core.publish([doc.id], editor)
    expect((await events())).toHaveLength(3)
    expect(await column()).toBe(first)
  })

  it('keeps a time per locale', async () => {
    const en = await valid('First')
    const es = await core.createTranslation(en.groupId, 'es', editor)
    await core.publish([en.id], editor)
    await core.publish([es.id], editor)
    const [first, second] = await events()
    const at = async (id: string) =>
      (await db.selectFrom('documents').select('first_published_at').where('id', '=', id).executeTakeFirstOrThrow()).first_published_at
    expect(first!.at).not.toBe(second!.at)
    expect(await at(en.id)).toBe(first!.at)
    expect(await at(es.id)).toBe(second!.at)
  })

  it('skips documents already published at head', async () => {
    const doc = await valid('First')
    await core.publish([doc.id], editor)
    const again = await core.publish([doc.id], editor)
    expect(again).toEqual({ eventId: null, items: [] })
    expect(await events()).toHaveLength(1)
  })

  it('publishes nothing when one document is invalid, listing every failure', async () => {
    const ok = await valid('Fine')
    const noDate = await core.createEntry('posts', { fields: { title: 'No date', body: 'x' } }, editor)
    const noBody = await core.createEntry('posts', { fields: { title: 'No body', date: '2026-02-01' } }, editor)
    const err = await rejection(core.publish([ok.id, noDate.id, noBody.id], editor))
    expect(err.code).toBe('validation')
    expect(err.messageId).toBe('error.publishFailed')
    expect(err.params).toEqual({ count: 2 })
    const docs = err.details.documents!
    expect(docs).toHaveLength(2)
    expect(docs.find((d) => d.documentId === noDate.id)).toMatchObject({ title: 'No date' })
    expect(docs.find((d) => d.documentId === noDate.id)!.issues.map((i) => i.labels)).toEqual([['Date']])
    expect(docs.find((d) => d.documentId === noBody.id)!.issues.map((i) => i.labels)).toEqual([['Body']])
    expect((await core.getDocument(ok.id))!.publishedRev).toBeNull()
    expect(await events()).toHaveLength(0)
  })

  it('treats a blank date as missing: saved as a draft, required at publish', async () => {
    const doc = await valid('Blank date', { date: '' })
    expect('date' in doc.data.fields).toBe(false)
    const err = await rejection(core.publish([doc.id], editor))
    const issues = err.details.documents![0]!.issues
    expect(issues.map((i) => [i.code, i.labels])).toEqual([['required', ['Date']]])
  })

  it('blocks references to deleted entries', async () => {
    const target = await valid('Gone')
    const doc = await valid('Refers', { related: [target.groupId] })
    await db.updateTable('documents').set({ deleted_at: '2026-03-01T00:00:00.000Z' }).where('id', '=', target.id).execute()
    const err = await rejection(core.publish([doc.id], editor))
    const issues = err.details.documents![0]!.issues
    expect(issues.map((i) => i.code)).toEqual(['deleted_reference'])
    expect(issues[0]!.labels[0]).toBe('Related posts')
    expect(issues[0]!.path.slice(0, 2)).toEqual(['fields', 'related'])
  })

  it('reports unknown documents', async () => {
    const err = await rejection(core.publish(['nope'], editor))
    expect(err.details.documents![0]!.issues[0]!.code).toBe('not_found')
  })

  it('requires the publish permission', async () => {
    const doc = await valid('First')
    const err = await rejection(core.publish([doc.id], { ...editor, actor: { ...editor.actor, role: 'viewer' as never } }))
    expect(err.code).toBe('forbidden')
  })

  it('unpublishes a post and lists it as pending again', async () => {
    const doc = await valid('First')
    await core.publish([doc.id], editor)
    const result = await core.unpublish([doc.id], owner)
    expect(result.items).toEqual([{ documentId: doc.id, revisionId: null, action: 'unpublish' }])
    const after = (await core.getDocument(doc.id))!
    expect(after.publishedRev).toBeNull()
    expect((await core.listPendingChanges()).map((d) => d.id)).toEqual([doc.id])
    const rows = await events()
    expect(rows).toHaveLength(2)
    expect(JSON.parse(rows[1]!.items)[0].action).toBe('unpublish')
    const row = await db.selectFrom('documents').selectAll().where('id', '=', doc.id).executeTakeFirstOrThrow()
    expect(row.published_slug).toBeNull()
    expect(await core.unpublish([doc.id], owner)).toEqual({ eventId: null, items: [] })
  })

  it('refuses to unpublish pages and site-wide content', async () => {
    const now = '2026-01-01T00:00:00.000Z'
    await db
      .insertInto('documents')
      .values({ id: 'home-id', kind: 'singleton', type: 'about', group_id: 'g', locale: 'en', head_rev: null, published_rev: null, head_slug: null, published_slug: null, head_path: '/about', published_path: '/about', deleted_at: null, created_at: now })
      .execute()
    const rev = await db
      .insertInto('revisions')
      .values({ document_id: 'home-id', data: '{"fields":{},"slots":{}}', author_id: null, author_name: 'x', source: 'release', message: null, created_at: now })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db.updateTable('documents').set({ head_rev: rev.id, published_rev: rev.id }).where('id', '=', 'home-id').execute()
    const err = await rejection(core.unpublish(['home-id'], owner))
    expect(err.code).toBe('invalid_operation')
  })

  it('lists pending changes newest head first, excluding deleted', async () => {
    const a = await valid('A')
    const b = await valid('B')
    const c = await valid('C')
    await core.publish([a.id], editor)
    await db.updateTable('documents').set({ deleted_at: '2026-03-01T00:00:00.000Z' }).where('id', '=', c.id).execute()
    const pending = await core.listPendingChanges()
    expect(pending.map((d) => d.id)).toEqual([b.id])
    expect(pending[0]!.title).toBe('B')
  })
})

describe('references from custom fields', () => {
  const featured = defineField(z.uuid(), {
    kind: 'featured',
    label: 'Featured',
    refs: (v) => (typeof v === 'string' ? [{ kind: 'document', id: v }] : []),
  })
  const Article = defineTemplate({
    name: 'article',
    label: 'Article',
    fields: z.object({ title: f.text({ label: 'Title' }), featured: featured.optional() }),
  })
  const custom = defineSite({
    locales: ['en'],
    defaultLocale: 'en',
    collections: [defineCollection({ name: 'articles', label: 'Articles', template: Article, route: '/a/:slug' })],
  })

  let core: Core
  let db: Kysely<Database>
  let editor: Ctx

  beforeEach(async () => {
    ;({ core, db, editor } = await makeCore({ site: custom }))
  })

  it('rejects a custom ref to content that does not exist', async () => {
    const err = await rejection(
      core.createEntry('articles', { fields: { title: 'A', featured: crypto.randomUUID() } }, editor),
    )
    expect(err.details.issues).toEqual([
      expect.objectContaining({ code: 'not_found', labels: ['Featured'], path: ['fields', 'featured'] }),
    ])
  })

  it('blocks publishing a custom ref to a deleted entry', async () => {
    const target = await core.createEntry('articles', { fields: { title: 'Target' } }, editor)
    const doc = await core.createEntry('articles', { fields: { title: 'Source', featured: target.groupId } }, editor)
    await db.updateTable('documents').set({ deleted_at: '2026-03-01T00:00:00.000Z' }).where('id', '=', target.id).execute()
    const err = await rejection(core.publish([doc.id], editor))
    const issues = err.details.documents![0]!.issues
    expect(issues.map((i) => i.code)).toEqual(['deleted_reference'])
    expect(issues[0]!.path).toEqual(['fields', 'featured'])
  })
})
