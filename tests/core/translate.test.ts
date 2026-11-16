import type { Kysely } from 'kysely'
import type { Core } from '../../src/core/core.js'
import type { Database } from '../../src/core/db/schema.js'
import { InlayError } from '../../src/core/errors.js'
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

describe('createTranslation', () => {
  let core: Core
  let db: Kysely<Database>
  let owner: Ctx
  let editor: Ctx

  beforeEach(async () => {
    ;({ core, db, owner, editor } = await makeCore())
    await core.applyShippedContent()
  })

  const newPost = (title: string) => core.createEntry('posts', { fields: { title } }, editor)

  it('a translation inherits the group key and has no edition', async () => {
    const about = (await core.findSingleton('about'))!
    await db.updateTable('documents').set({ key: 'about', edition: 3 }).where('id', '=', about.id).execute()
    const es = await core.createTranslation(about.groupId, 'es', editor)
    const row = await db.selectFrom('documents').select(['key', 'edition']).where('id', '=', es.id).executeTakeFirstOrThrow()
    expect(row).toEqual({ key: 'about', edition: null })
  })

  it('copies a post into es as an unpublished draft in the same group', async () => {
    const post = await newPost('Hello')
    const es = await core.createTranslation(post.groupId, 'es', editor)
    expect(es.groupId).toBe(post.groupId)
    expect(es.id).not.toBe(post.id)
    expect(es.locale).toBe('es')
    expect(es.type).toBe('posts')
    expect(es.kind).toBe('entry')
    expect(es.data).toEqual(post.data)
    expect(es.publishedRev).toBeNull()
    expect(es.revision.source).toBe('admin')
    expect(es.revision.authorName).toBe('Eddie Editor')
    expect((await core.findTranslation(post.groupId, 'es'))!.id).toBe(es.id)
  })

  it('makes the copied slug unique within the new locale', async () => {
    const third = await newPost('Third')
    await db.insertInto('documents').values({
      id: crypto.randomUUID(), kind: 'entry', type: 'posts', group_id: crypto.randomUUID(), locale: 'es',
      head_rev: null, published_rev: null, head_slug: 'third', published_slug: null, head_path: null,
      published_path: null, deleted_at: null, created_at: '2026-01-01T00:00:00.000Z',
    }).execute()
    const es3 = await core.createTranslation(third.groupId, 'es', editor)
    expect(es3.data.slug).toBe('third-2')
  })

  it('writes refs for the new document', async () => {
    const a = await newPost('A')
    const b = await core.createEntry('posts', { fields: { title: 'B', related: [a.groupId] } }, editor)
    const es = await core.createTranslation(b.groupId, 'es', editor)
    const refs = await db.selectFrom('refs').selectAll().where('from_document_id', '=', es.id).execute()
    expect(refs).toHaveLength(1)
    expect(refs[0]!.to_id).toBe(a.groupId)
  })

  it('translates a singleton', async () => {
    const about = (await core.findSingleton('about'))!
    const es = await core.createTranslation(about.groupId, 'es', owner)
    expect(es.kind).toBe('singleton')
    expect(es.locale).toBe('es')
    expect(es.publishedRev).toBeNull()
    expect((await core.getDocument(about.id))!.data).toEqual(es.data)
  })

  it('rejects repeats, unknown locales, the default locale, unknown and deleted groups', async () => {
    const post = await newPost('Hello')
    await core.createTranslation(post.groupId, 'es', editor)
    expect((await rejection(core.createTranslation(post.groupId, 'es', editor))).code).toBe('invalid_operation')
    expect((await rejection(core.createTranslation(post.groupId, 'fr', editor))).code).toBe('invalid_operation')
    expect((await rejection(core.createTranslation(post.groupId, 'en', editor))).code).toBe('invalid_operation')
    expect((await rejection(core.createTranslation(crypto.randomUUID(), 'es', editor))).code).toBe('not_found')

    const other = await newPost('Gone')
    await db.updateTable('documents').set({ deleted_at: '2026-01-02T00:00:00.000Z' }).where('id', '=', other.id).execute()
    expect((await rejection(core.createTranslation(other.groupId, 'es', editor))).code).toBe('invalid_operation')
  })

  it('keeps the locales\' revision streams independent', async () => {
    const post = await newPost('Hello')
    const es = await core.createTranslation(post.groupId, 'es', editor)
    const data = structuredClone(es.data)
    data.fields.title = 'Hola'
    await core.saveDraft(es.id, { baseRevisionId: es.headRev, data }, editor)
    const en = (await core.getDocument(post.id))!
    expect(en.headRev).toBe(post.headRev)
    expect(en.data.fields.title).toBe('Hello')
  })
})
