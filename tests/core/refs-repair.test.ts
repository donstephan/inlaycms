import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootInlay } from '../../src/core/boot.js'
import { openDatabase } from '../../src/core/db/connection.js'
import { migrateSystem } from '../../src/core/db/migrate.js'
import { createCore } from '../../src/core/core.js'
import type { SiteDefinition, TemplateDef } from '../../src/core/registry/define.js'
import { png } from '../fixtures/media.js'
import { withType } from '../fixtures/evolve.js'
import { HomePage, site } from '../fixtures/site.js'
import { makeCore } from '../helpers/core.js'

/** The fixture site with testimonials left out (and the home slot that refers to it). */
const { quotes: _quotes, ...homeSlots } = HomePage.slots
const hiddenSite: SiteDefinition = (() => {
  const template: TemplateDef = { ...HomePage, slots: homeSlots }
  const home = withType(site, 'home', { template })
  return {
    ...home,
    collections: home.collections.filter((c) => c.name !== 'testimonials'),
    content: home.content.filter((c) => c.type !== 'testimonials'),
  }
})()

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function setup() {
  const w = await makeCore({ media: true })
  dirs.push(w.mediaDir!)
  await w.core.applyShippedContent()
  const { media } = await w.core.addMedia({ data: await png(40, 20), filename: 'photo.png' }, w.owner)
  const post = await w.core.createEntry(
    'testimonials',
    { fields: { quote: 'Great', author: 'Ann', photo: { media: media.id } } },
    w.owner,
  )
  await w.core.publish([post.id], w.owner)
  return { ...w, media, post }
}

const refCount = async (db: Awaited<ReturnType<typeof makeCore>>['db'], id: string) =>
  (await db.selectFrom('refs').select('to_id').where('from_document_id', '=', id).execute()).length

describe('repairRefs', () => {
  it('re-creates missing refs, so the media stays in use', async () => {
    const { core, db, owner, media, post } = await setup()
    await db.deleteFrom('refs').execute()
    expect(await refCount(db, post.id)).toBe(0)
    expect(await core.repairRefs()).toBeGreaterThanOrEqual(1)
    expect(await refCount(db, post.id)).toBeGreaterThan(0)
    await expect(core.deleteMedia(media.id, owner)).rejects.toMatchObject({ code: 'in_use' })
  })

  it('skips hidden and deleted documents, and is idempotent', async () => {
    const { core, db, owner, media, post } = await setup()
    const gone = await core.createEntry(
      'testimonials',
      { fields: { quote: 'Bye', author: 'Gus', photo: { media: media.id } } },
      owner,
    )
    await core.deleteEntry(gone.groupId, owner)
    await db.deleteFrom('refs').execute()
    await core.repairRefs()
    expect(await refCount(db, gone.id)).toBe(0)
    expect(await refCount(db, post.id)).toBeGreaterThan(0)

    await db.updateTable('documents').set({ type: 'nonexistent' }).where('id', '=', post.id).execute()
    await db.deleteFrom('refs').where('from_document_id', '=', post.id).execute()
    await core.repairRefs()
    expect(await refCount(db, post.id)).toBe(0)
    await db.updateTable('documents').set({ type: 'testimonials' }).where('id', '=', post.id).execute()
    await core.repairRefs()
    expect(await refCount(db, post.id)).toBeGreaterThan(0)

    // documents with no references at all are synced each time but gain nothing
    const second = await core.repairRefs()
    const noRefs = await db.selectFrom('documents').select('id').where('deleted_at', 'is', null).execute()
    expect(second).toBeLessThanOrEqual(noRefs.length)
    expect(await core.repairRefs()).toBe(second)
    expect(await refCount(db, gone.id)).toBe(0)
  })

  it('a revision with no fields or slots yields no refs', async () => {
    const { core, db } = await setup()
    const home = (await core.findSingleton('home'))!
    const rev = await db
      .insertInto('revisions')
      .values({ document_id: home.id, data: '{}', author_id: null, author_name: 'Import', source: 'import', message: null, created_at: '2026-02-01T00:00:00.000Z' })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db.updateTable('documents').set({ head_rev: rev.id, published_rev: rev.id }).where('id', '=', home.id).execute()
    await db.deleteFrom('refs').execute()
    await expect(core.repairRefs()).resolves.toBeGreaterThanOrEqual(1)
    expect(await refCount(db, home.id)).toBe(0)
  })

  it('boot repairs refs of a type that comes back after an import', async () => {
    const a = await setup()
    const dir = await mkdtemp(join(tmpdir(), 'inlay-refs-repair-'))
    dirs.push(dir)
    const file = join(dir, 'export.tar.gz')
    await a.core.exportContent(file, a.owner)

    const dbPath = join(dir, 'b.db')
    const mediaDir = join(dir, 'media')
    const backups = join(dir, 'backups')
    const raw = openDatabase(dbPath)
    await migrateSystem(raw)
    const b = createCore({ site: hiddenSite, db: raw, media: mediaDir, backups })
    await b.importContent(file, a.owner)
    await raw.destroy()

    const booted = await bootInlay({ site, db: dbPath, backups, media: mediaDir })
    try {
      await expect(booted.core.deleteMedia(a.media.id, a.owner)).rejects.toMatchObject({ code: 'in_use' })
    } finally {
      await booted.db.destroy()
    }
  })
})
