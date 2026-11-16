import type { Kysely } from 'kysely'
import { createCore, type Core } from '../../src/core/core.js'
import type { Database } from '../../src/core/db/schema.js'
import { InlayError } from '../../src/core/errors.js'
import { t } from '../../src/core/messages/index.js'
import type { SiteDefinition } from '../../src/core/registry/define.js'
import type { Ctx, DocumentView } from '../../src/core/types.js'
import { homeTitledSite, noTestimonialsSite, postSummarySite, ratedSite, withSlot, withType } from '../fixtures/evolve.js'
import { Hero, HomePage, site, withoutLocale } from '../fixtures/site.js'
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

const withoutPosts: SiteDefinition = {
  ...site,
  collections: site.collections.filter((c) => c.name !== 'posts'),
}

const withoutSpanish: SiteDefinition = withoutLocale(site, 'es')

interface World {
  core: Core
  db: Kysely<Database>
  owner: Ctx
  editor: Ctx
  post: DocumentView
  es: DocumentView
  nav: DocumentView
}

/** Shipped content, a published post with an `es` draft, and the nav linking to the post (published). */
async function setup(): Promise<World> {
  const { core, db, owner, editor } = await makeCore()
  await core.applyShippedContent()
  const created = await core.createEntry('posts', { fields: { title: 'Hello', date: '2026-02-01', body: 'Hi' } }, editor)
  await core.publish([created.id], editor)
  const post = (await core.getDocument(created.id))!
  const es = await core.createTranslation(post.groupId, 'es', editor)
  const navSummary = (await core.findSingleton('nav'))!
  await core.patchDraft(
    navSummary.id,
    { baseRevisionId: navSummary.headRev, ops: [{ path: ['fields', 'links'], value: [{ link: { document: post.groupId } }] }] },
    editor,
  )
  await core.publish([navSummary.id], editor)
  const nav = (await core.getDocument(navSummary.id))!
  return { core, db, owner, editor, post, es, nav }
}

describe('hidden content: removed types', () => {
  let w: World
  let hidden: Core

  beforeEach(async () => {
    w = await setup()
    expect((await w.core.listPendingChanges()).map((d) => d.id)).toContain(w.es.id)
    hidden = createCore({ site: withoutPosts, db: w.db })
  })

  it('reads nothing of a removed type', async () => {
    expect(await hidden.getDocument(w.post.id)).toBeNull()
    expect(await hidden.getDocument(w.post.id, { state: 'published' })).toBeNull()
    expect(await hidden.getDocument(w.es.id)).toBeNull()
    expect(await hidden.findTranslation(w.post.groupId, 'en')).toBeNull()
    expect((await hidden.listPendingChanges()).map((d) => d.type)).not.toContain('posts')
    expect(await hidden.findUsages({ kind: 'document', id: w.post.groupId })).toEqual([])
    expect(await hidden.getRevision(w.post.headRev)).toBeNull()
    expect((await rejection(hidden.listRevisions(w.post.id))).code).toBe('not_found')
    expect((await rejection(hidden.diffRevisions(null, w.post.headRev))).code).toBe('not_found')
  })

  it('still reads documents that link to a removed type', async () => {
    const nav = (await hidden.getDocument(w.nav.id))!
    expect(nav.data.fields.links).toEqual([{ link: { document: w.post.groupId } }])
    expect((await hidden.findSingleton('nav'))!.id).toBe(w.nav.id)
  })

  it('refuses every write to a removed type', async () => {
    const { post, editor, owner } = w
    const notFound = async (p: Promise<unknown>) => expect((await rejection(p)).code).toBe('not_found')
    await notFound(hidden.saveDraft(post.id, { baseRevisionId: post.headRev, data: post.data }, editor))
    await notFound(
      hidden.patchDraft(post.id, { baseRevisionId: post.headRev, ops: [{ path: ['fields', 'title'], value: 'X' }] }, editor),
    )
    await notFound(hidden.restoreRevision(post.id, post.headRev, editor))
    await notFound(hidden.createTranslation(post.groupId, 'es', editor))
    await notFound(hidden.deleteEntry(post.groupId, owner))
    await notFound(hidden.restoreEntry(post.groupId, owner))
    await notFound(hidden.unpublish([post.id], editor))

    const err = await rejection(hidden.publish([w.es.id], editor))
    expect(err.code).toBe('validation')
    expect(err.details.documents).toEqual([
      expect.objectContaining({
        documentId: w.es.id,
        issues: [expect.objectContaining({ code: 'not_found', message: t('issue.documentMissing') })],
      }),
    ])
  })

  it('blocks publishing a link to a removed type until it is fixed', async () => {
    const { nav, post, editor } = w
    const edited = await hidden.patchDraft(
      nav.id,
      { baseRevisionId: nav.headRev, ops: [{ path: ['fields', 'links', 1], value: { link: { url: '/contact' } } }] },
      editor,
    )
    expect(edited.changed).toBe(true)

    const err = await rejection(hidden.publish([nav.id], editor))
    expect(err.code).toBe('validation')
    expect(err.details.documents![0]!.issues).toEqual([
      expect.objectContaining({ code: 'not_found', labels: ['Links', 'Item 1', 'Link'] }),
    ])

    const added = await rejection(
      hidden.patchDraft(
        nav.id,
        {
          baseRevisionId: edited.document.headRev,
          ops: [{ path: ['fields', 'links', 2], value: { link: { document: post.groupId } } }],
        },
        editor,
      ),
    )
    expect(added.code).toBe('validation')
    expect(added.details.issues).toEqual([
      expect.objectContaining({ code: 'not_found', labels: ['Links', 'Item 3', 'Link'] }),
    ])

    const fixed = await hidden.patchDraft(
      nav.id,
      { baseRevisionId: edited.document.headRev, ops: [{ path: ['fields', 'links', 0], value: { link: { url: '/blog' } } }] },
      editor,
    )
    const result = await hidden.publish([nav.id], editor)
    expect(result.items).toEqual([{ documentId: nav.id, revisionId: fixed.document.headRev, action: 'publish' }])
  })
})

describe('hidden content: removed locales', () => {
  let w: World
  let hidden: Core

  beforeEach(async () => {
    w = await setup()
    hidden = createCore({ site: withoutSpanish, db: w.db })
  })

  it('reads nothing in a removed locale', async () => {
    expect(await hidden.findTranslation(w.post.groupId, 'es')).toBeNull()
    expect(await hidden.findTranslation(w.post.groupId, 'en')).not.toBeNull()
    expect(await hidden.getDocument(w.es.id)).toBeNull()
    expect(await hidden.findSingleton('home', 'es')).toBeNull()
    expect((await hidden.listPendingChanges()).map((d) => d.locale)).not.toContain('es')
  })

  it('refuses writes in a removed locale', async () => {
    const { es, editor } = w
    const err = await rejection(hidden.saveDraft(es.id, { baseRevisionId: es.headRev, data: es.data }, editor))
    expect(err.code).toBe('not_found')
  })

  it('restores hidden-locale documents without rewriting them, even when their slug is taken', async () => {
    const { core, db, editor, owner } = w
    const fields = { title: 'Other', date: '2026-02-02', body: 'Yo' }
    const a = await core.createEntry('posts', { fields }, editor)
    const aEs = await core.createTranslation(a.groupId, 'es', editor)
    await core.deleteEntry(a.groupId, owner)
    const b = await core.createEntry('posts', { fields }, editor)
    const bEs = await core.createTranslation(b.groupId, 'es', editor)
    const head = async (id: string) =>
      db.selectFrom('documents').select(['head_rev', 'head_slug']).where('id', '=', id).executeTakeFirstOrThrow()
    expect((await head(bEs.id)).head_slug).toBe((await head(aEs.id)).head_slug)
    const before = await head(aEs.id)

    const [restored] = await hidden.restoreEntry(a.groupId, owner)
    expect(restored!.data.slug).not.toBe(b.data.slug)
    expect(await head(aEs.id)).toEqual(before)
  })

  it('deletes and restores an entry in every locale, hidden ones included', async () => {
    const { core, db, editor, owner } = w
    const en = await core.createEntry('posts', { fields: { title: 'Other', date: '2026-02-02', body: 'Yo' } }, editor)
    const es = await core.createTranslation(en.groupId, 'es', editor)
    const deletedAt = async (id: string) =>
      (await db.selectFrom('documents').select('deleted_at').where('id', '=', id).executeTakeFirstOrThrow()).deleted_at

    await hidden.deleteEntry(en.groupId, owner)
    expect(await deletedAt(en.id)).not.toBeNull()
    expect(await deletedAt(es.id)).not.toBeNull()

    const restored = await hidden.restoreEntry(en.groupId, owner)
    expect(restored.map((d) => d.id)).toEqual([en.id])
    expect(await deletedAt(en.id)).toBeNull()
    expect(await deletedAt(es.id)).toBeNull()
  })
})

describe('hidden content: counts', () => {
  const nothing = { types: [], locales: [], slots: [], fields: [] }

  it('finds nothing hidden on the plain fixture', async () => {
    const { core, editor } = await makeCore()
    await core.applyShippedContent()
    const post = await core.createEntry('posts', { fields: { title: 'Hello', date: '2026-02-01', body: 'Hi' } }, editor)
    await core.publish([post.id], editor)
    await core.createTranslation(post.groupId, 'es', editor)
    expect(await core.hiddenContent()).toEqual(nothing)
  })

  it('hidden documents are counted, never listed as gaps', async () => {
    const { core, db, owner } = await makeCore()
    await core.applyShippedContent()
    const maria = (await core.listEntries('testimonials'))[0]!
    await core.publish([maria.id], owner)
    expect((await createCore({ site: ratedSite, db }).listGaps()).map((g) => g.document.id)).toEqual([maria.id])

    const hidden = createCore({ site: noTestimonialsSite, db })
    expect(await hidden.hiddenContent()).toEqual({
      ...nothing,
      types: [{ type: 'testimonials', documents: 1 }],
      slots: [{ type: 'home', slot: 'quotes', documents: 2 }],
    })
    expect(await hidden.hiddenDocuments()).toEqual({ types: [{ type: 'testimonials', documents: 1 }], locales: [] })
    expect(await hidden.listGaps()).toEqual([])
    expect(await hidden.listGaps({ type: 'testimonials' })).toEqual([])
    expect(await hidden.gapSummary()).toEqual([])
  })

  it('counts documents in a removed locale, leaving deleted ones out', async () => {
    const { core, db, editor, owner } = await makeCore()
    await core.applyShippedContent()
    const maria = (await core.listEntries('testimonials'))[0]!
    await core.createTranslation(maria.groupId, 'es', editor)
    const gone = await core.createEntry('posts', { fields: { title: 'Gone', date: '2026-02-01', body: 'x' } }, editor)
    await core.createTranslation(gone.groupId, 'es', editor)
    await core.deleteEntry(gone.groupId, owner)

    const hidden = createCore({ site: withoutLocale(site, 'es'), db })
    expect(await hidden.hiddenContent()).toEqual({ ...nothing, locales: [{ locale: 'es', documents: 2 }] })
    expect(await hidden.hiddenDocuments()).toEqual({ types: [], locales: [{ locale: 'es', documents: 2 }] })
  })

  it('counts a removed slot per document', async () => {
    const bannerSite = withType(site, 'home', { template: withSlot(HomePage, 'banner', Hero) })
    const { core, db, editor } = await makeCore()
    await core.applyShippedContent()
    const withBanner = createCore({ site: bannerSite, db })
    const home = (await withBanner.getDocument((await withBanner.findSingleton('home'))!.id))!
    const banner = { enabled: true, data: { headline: 'Sale' } }
    await withBanner.saveDraft(home.id, { baseRevisionId: home.headRev, data: { ...home.data, slots: { ...home.data.slots, banner } } }, editor)

    expect(await core.hiddenContent()).toEqual({ ...nothing, slots: [{ type: 'home', slot: 'banner', documents: 1 }] })
    // Hidden slots and fields need the content read: the document counts alone don't have them.
    expect(await core.hiddenDocuments()).toEqual({ types: [], locales: [] })
  })

  it('counts a renamed field once per document, head and published together, never inside list items', async () => {
    const { core, db, editor, owner } = await makeCore()
    await core.applyShippedContent()
    const home = (await core.getDocument((await core.findSingleton('home'))!.id))!
    await core.publish([home.id], owner)
    const cards = [{ title: 'Fast', extra: 'not counted' }]
    const saved = await core.saveDraft(
      home.id,
      { baseRevisionId: home.headRev, data: { ...home.data, slots: { ...home.data.slots, features: { enabled: true, data: { cards } } } } },
      editor,
    )
    await db
      .updateTable('revisions')
      .set({ data: (eb) => eb.fn('json_set', ['data', eb.val('$.slots.features.data.cards[0].extra'), eb.val('x')]) })
      .where('id', '=', saved.document.headRev)
      .execute()
    const stored = await db.selectFrom('revisions').select('data').where('id', '=', saved.document.headRev).executeTakeFirstOrThrow()
    expect(JSON.parse(stored.data).slots.features.data.cards[0].extra).toBe('x')

    const summary = createCore({ site: postSummarySite, db })
    const post = await summary.createEntry('posts', { fields: { title: 'A', date: '2026-02-01', body: 'x', summary: 'S' } }, editor)
    await summary.publish([post.id], editor)

    const titled = createCore({ site: homeTitledSite, db })
    expect(await titled.hiddenContent()).toEqual({
      ...nothing,
      fields: [
        { type: 'home', path: 'slots.hero.data.headline', documents: 2 },
        { type: 'posts', path: 'fields.summary', documents: 1 },
      ],
    })
  })
})
