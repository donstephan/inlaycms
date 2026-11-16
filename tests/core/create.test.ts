import type { Kysely } from 'kysely'
import { slugify } from '../../src/core/content/slug.js'
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

describe('slugify', () => {
  it('makes readable ASCII slugs', () => {
    expect(slugify('¿Qué es Inlay?')).toBe('que-es-inlay')
    expect(slugify('Café & Co.')).toBe('cafe-co')
    expect(slugify('Straße')).toBe('strasse')
    expect(slugify('🎉🎉')).toBe('entry')
    expect(slugify('')).toBe('entry')
  })

  it('cuts long slugs to 80 characters at a word boundary', () => {
    const slug = slugify(`${'word '.repeat(30)}end`)
    expect(slug.length).toBeLessThanOrEqual(80)
    expect(slug).toMatch(/^word(-word)*$/)
    expect(slugify('x'.repeat(100))).toBe('x'.repeat(80))
  })
})

describe('createEntry', () => {
  let core: Core
  let db: Kysely<Database>
  let editor: Ctx

  beforeEach(async () => {
    ;({ core, db, editor } = await makeCore())
  })

  const post = (title: string, extra: Record<string, unknown> = {}) => ({ fields: { title, ...extra } })

  it('creates a draft post with a slug from its title', async () => {
    const doc = await core.createEntry('posts', post('¿Qué es Inlay?'), editor)
    expect(doc.data.slug).toBe('que-es-inlay')
    expect(doc.kind).toBe('entry')
    expect(doc.locale).toBe('en')
    expect(doc.title).toBe('¿Qué es Inlay?')
    expect(doc.headRev).toBe(doc.revision.id)
    expect(doc.publishedRev).toBeNull()
    expect(doc.state).toBe('head')
    expect(doc.revision.source).toBe('admin')
    expect(doc.revision.authorName).toBe('Eddie Editor')
    expect(doc.revision.authorId).toBe('user-editor')
    expect(doc.updatedAt).toBe(doc.revision.createdAt)

    const row = await db.selectFrom('documents').selectAll().where('id', '=', doc.id).executeTakeFirstOrThrow()
    expect(row.head_slug).toBe('que-es-inlay')
    expect(row.published_slug).toBeNull()
    expect(row.group_id).toBe(doc.groupId)
  })

  it('makes generated slugs unique and never empty', async () => {
    await core.createEntry('posts', post('¿Qué es Inlay?'), editor)
    const second = await core.createEntry('posts', post('¿Qué es Inlay?'), editor)
    expect(second.data.slug).toBe('que-es-inlay-2')
    const third = await core.createEntry('posts', post('Que es inlay'), editor)
    expect(third.data.slug).toBe('que-es-inlay-3')
    expect((await core.createEntry('posts', post('🎉🎉🎉'), editor)).data.slug).toBe('entry')
    expect((await core.createEntry('posts', post('🚀'), editor)).data.slug).toBe('entry-2')
    expect((await core.createEntry('posts', post('Café & Co.'), editor)).data.slug).toBe('cafe-co')
  })

  it('rejects an explicit slug that is already used', async () => {
    await core.createEntry('posts', post('Hello'), editor)
    const e = await rejection(core.createEntry('posts', { slug: 'hello', ...post('Other') }, editor))
    expect(e.code).toBe('validation')
    expect(e.details.issues).toEqual([
      expect.objectContaining({ code: 'duplicate_slug', path: ['slug'], labels: ['URL slug'] }),
    ])
  })

  it('keeps an explicit unique slug', async () => {
    const doc = await core.createEntry('posts', { slug: 'my-post', ...post('Hello') }, editor)
    expect(doc.data.slug).toBe('my-post')
  })

  it('creates entries of unrouted collections without a slug', async () => {
    const doc = await core.createEntry('testimonials', { fields: { quote: 'Great', author: 'Ana' } }, editor)
    expect(doc.data.slug).toBeUndefined()
    expect(doc.title).toBe('Ana')
  })

  it('only creates collection entries in the default locale', async () => {
    expect((await rejection(core.createEntry('home', post('x'), editor))).code).toBe('invalid_operation')
    expect((await rejection(core.createEntry('nope', post('x'), editor))).code).toBe('not_found')
    expect((await rejection(core.createEntry('posts', { ...post('x'), locale: 'es' }, editor))).code).toBe(
      'invalid_operation',
    )
  })

  it('validates at draft level', async () => {
    const e = await rejection(core.createEntry('posts', { slug: 'Hello World', ...post('x') }, editor))
    expect(e.code).toBe('validation')
    expect(e.details.issues?.[0]).toMatchObject({ code: 'invalid', path: ['slug'] })
  })

  it('reads documents back', async () => {
    const doc = await core.createEntry('posts', { ...post('First'), message: 'Hi' }, editor)
    await core.createEntry('posts', post('Second'), editor)
    expect(await core.getDocument(doc.id, { state: 'published' })).toBeNull()
    expect(await core.getDocument('missing')).toBeNull()
    const head = await core.getDocument(doc.id)
    expect(head?.revision.message).toBe('Hi')
    expect(head?.data).toEqual({ slug: 'first', fields: { title: 'First' }, slots: {} })
    expect((await core.listEntries('posts')).map((d) => d.title)).toEqual(['Second', 'First'])
    expect(await core.listEntries('posts', { locale: 'es' })).toEqual([])
    expect(await core.findTranslation(doc.groupId, 'en')).toMatchObject({ id: doc.id, title: 'First' })
    expect(await core.findTranslation(doc.groupId, 'es')).toBeNull()
    expect(await core.findSingleton('home')).toBeNull()
  })

  it('stores the revision time', async () => {
    const doc = await core.createEntry('posts', post('Hello'), editor)
    const rev = await db
      .selectFrom('revisions')
      .selectAll()
      .where('id', '=', doc.revision.id)
      .executeTakeFirstOrThrow()
    expect(rev.created_at).toBe('2026-01-01T00:00:00.000Z')
  })

  it('checks document references', async () => {
    const maria = await core.createEntry('testimonials', { fields: { quote: 'Hi', author: 'Maria' } }, editor)

    let e = await rejection(core.createEntry('posts', post('A', { related: [crypto.randomUUID()] }), editor))
    expect(e.code).toBe('validation')
    expect(e.details.issues).toEqual([
      expect.objectContaining({ code: 'not_found', labels: ['Related posts'], path: ['fields', 'related', 0] }),
    ])

    e = await rejection(core.createEntry('posts', post('A', { related: [maria.groupId] }), editor))
    expect(e.details.issues).toEqual([expect.objectContaining({ code: 'wrong_collection' })])

    e = await rejection(core.createEntry('posts', post('A', { cta: { document: maria.groupId } }), editor))
    expect(e.details.issues).toEqual([
      expect.objectContaining({ code: 'not_routable', labels: ['Call to action'], path: ['fields', 'cta'] }),
    ])
    expect(await core.listEntries('posts')).toEqual([])
  })

  it('writes refs rows for valid references', async () => {
    const target = await core.createEntry('posts', post('Target'), editor)
    const doc = await core.createEntry(
      'posts',
      post('Source', { related: [target.groupId], cta: { document: target.groupId } }),
      editor,
    )
    const refs = await db.selectFrom('refs').selectAll().execute()
    expect(refs).toEqual([
      {
        from_document_id: doc.id,
        from_revision_id: doc.revision.id,
        to_kind: 'document',
        to_id: target.groupId,
      },
    ])
  })
})
