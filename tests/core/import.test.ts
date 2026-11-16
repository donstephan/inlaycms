import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql, type Kysely } from 'kysely'
import * as tar from 'tar'
import { listBackups } from '../../src/core/backup/backup.js'
import { createCore, type Core } from '../../src/core/core.js'
import type { Database } from '../../src/core/db/schema.js'
import { InlayError } from '../../src/core/errors.js'
import { removeUnusedMedia } from '../../src/core/export/import.js'
import { missingMediaLabel } from '../../src/core/media/labels.js'
import { fileMediaStore } from '../../src/core/media/store.js'
import { defineContent } from '../../src/core/registry/content.js'
import { defineSingleton, type SiteDefinition, type TemplateDef } from '../../src/core/registry/define.js'
import type { DocumentData } from '../../src/core/types.js'
import { withType } from '../fixtures/evolve.js'
import { png, sha256 } from '../fixtures/media.js'
import { BasicPage, HomePage, site } from '../fixtures/site.js'
import { makeCore } from '../helpers/core.js'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function temp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'inlay-import-test-'))
  dirs.push(d)
  return d
}

type World = Awaited<ReturnType<typeof makeCore>>

async function world(opts: Parameters<typeof makeCore>[0] = {}): Promise<World> {
  const w = await makeCore(opts)
  if (w.mediaDir) dirs.push(w.mediaDir)
  if (w.backupsDir) dirs.push(w.backupsDir)
  return w
}

/** The fixture site with the testimonials collection left out (and the home slot that refers to it). */
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

/** The fixture site plus a pricing page whose shipped content doesn't fit, so applying it fails. */
const brokenSite: SiteDefinition = {
  ...site,
  singletons: [...site.singletons, defineSingleton({ name: 'pricing', label: 'Pricing', template: BasicPage, path: '/pricing' })],
  content: [...site.content, defineContent('pricing', { edition: 1, content: { en: { fields: {} } } })],
}

const fields = (title: string) => ({ title, date: '2026-02-01', body: `${title} body` })

/** Review Focus 2's list, on the fixture site; `hidden` is a core over the same database with testimonials removed. */
async function seedRoundTrip() {
  const w = await world({ media: true })
  const { core, owner } = w
  await core.applyShippedContent()
  const homeId = (await core.findSingleton('home'))!.id
  const about = (await core.findSingleton('about'))!
  const post = await core.createEntry('posts', { slug: 'hello', fields: fields('Hello') }, owner)
  await core.publish([homeId, post.id], owner)
  await core.publish([about.id], owner)
  await core.createEntry('posts', { slug: 'later', fields: fields('Later') }, owner)
  const gone = await core.createEntry('posts', { slug: 'gone', fields: fields('Gone') }, owner)
  await core.deleteEntry(gone.groupId, owner)
  await core.createTranslation(about.groupId, 'es', owner)
  await core.createRedirect({ from: '/old', to: { document: about.groupId } }, owner)

  await core.addMedia({ data: await png(4, 4), filename: 'first.png' }, owner)
  const second = await core.addMedia({ data: await png(5, 5, '#cc3333'), filename: 'second.png' }, owner)
  const setHero = async (image: { media: string } | undefined) => {
    const doc = (await core.getDocument(homeId))!
    const data: DocumentData = structuredClone(doc.data)
    data.slots.hero!.data.headline = 'Draft headline'
    if (image) data.slots.hero!.data.image = image
    else delete data.slots.hero!.data.image
    return core.saveDraft(homeId, { baseRevisionId: doc.headRev, data }, owner)
  }
  await setHero({ media: second.media.id })
  const withImage = (await core.getDocument(homeId))!.headRev
  await setHero(undefined)
  await core.deleteMedia(second.media.id, owner)
  await core.restoreRevision(homeId, withImage, owner)

  const hidden = createCore({ site: hiddenSite, db: w.db, media: w.mediaDir! })
  return { ...w, hidden, homeId, about, post, gone, deletedMedia: second.media.id }
}

async function exportOf(core: Core, ctx: World['owner']) {
  const file = join(await temp(), 'export.tar.gz')
  const summary = await core.exportContent(file, ctx)
  return { file, summary }
}

const tables = ['documents', 'revisions', 'publish_events', 'refs', 'media', 'media_deletions', 'redirects'] as const

async function snapshot(db: Kysely<Database>) {
  const out: Record<string, unknown[]> = {}
  for (const table of tables) out[table] = await db.selectFrom(table).selectAll().execute()
  return out
}

async function rejection(p: Promise<unknown>): Promise<InlayError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(InlayError)
  return err as InlayError
}

describe('importContent', () => {
  it('restores everything an export holds into a fresh site', async () => {
    const a = await seedRoundTrip()
    const { file, summary } = await exportOf(a.hidden, a.owner)
    const b = await world({ site: hiddenSite, media: true, backups: true })

    const result = await b.core.importContent(file, b.owner)
    expect(result.report.ok).toBe(true)
    expect(result.skipped).toEqual({ media: [] })
    expect(result.imported).toEqual({
      documents: summary.counts.documents,
      revisions: summary.counts.revisions,
      media: summary.counts.media,
      redirects: summary.counts.redirects,
    })

    expect(await b.core.liveSingleton('home', 'en')).toEqual(await a.hidden.liveSingleton('home', 'en'))
    expect(await b.core.liveSingleton('about', 'en')).toEqual(await a.hidden.liveSingleton('about', 'en'))
    const page = await b.core.resolvePath('/blog/hello')
    expect(page.kind).toBe('page')
    expect(page).toEqual(await a.hidden.resolvePath('/blog/hello'))

    const history = async (core: Core) =>
      (await core.listRevisions(a.homeId)).map((r) => ({ id: r.id, authorName: r.authorName, source: r.source, message: r.message }))
    expect(await history(b.core)).toEqual(await history(a.hidden))
    expect(await b.core.listPendingChanges()).toEqual(await a.hidden.listPendingChanges())

    const restored = await b.core.restoreEntry(a.gone.groupId, b.owner)
    expect(restored.map((d) => d.id)).toEqual([a.gone.id])

    expect(b.core.registry.types.has('testimonials')).toBe(false)
    expect((await b.core.listPendingChanges()).map((d) => d.type)).not.toContain('testimonials')
    const hiddenRows = await b.db.selectFrom('documents').select('id').where('type', '=', 'testimonials').execute()
    expect(hiddenRows.length).toBeGreaterThan(0)

    const aboutPath = (await a.hidden.liveSingleton('about', 'en'))!.path
    expect(await b.core.resolvePath('/old')).toMatchObject({ kind: 'redirect', location: aboutPath })

    const status = (await b.core.lookupMedia([a.deletedMedia])).get(a.deletedMedia)!
    expect(status.status).toBe('deleted')
    if (status.status !== 'deleted') throw new Error('unreachable')
    expect(missingMediaLabel(status)).toContain('second.png')

    const backups = await b.core.listBackups(b.owner)
    expect(backups.map((x) => x.reason)).toEqual(['pre-import'])
    expect(result.backup.path).toBe(backups[0]!.path)
  })

  it('import keeps key, edition and releaseId', async () => {
    const a = await seedRoundTrip()
    await a.db.updateTable('documents').set({ key: 'about', edition: 2 }).where('id', '=', a.about.id).execute()
    const aboutRev = (await a.db.selectFrom('documents').select('head_rev').where('id', '=', a.about.id).executeTakeFirstOrThrow()).head_rev!
    await a.db.updateTable('revisions').set({ release_id: 'rel-1' }).where('id', '=', aboutRev).execute()
    const { file } = await exportOf(a.hidden, a.owner)
    const b = await world({ site: hiddenSite, media: true, backups: true })
    await b.core.importContent(file, b.owner)
    const row = await b.db.selectFrom('documents').select(['key', 'edition']).where('id', '=', a.about.id).executeTakeFirstOrThrow()
    expect(row).toEqual({ key: 'about', edition: 2 })
    const rev = await b.db.selectFrom('revisions').select('release_id').where('id', '=', aboutRev).executeTakeFirstOrThrow()
    expect(rev.release_id).toBe('rel-1')
  })

  it('round-trips a redirect whose address has a percent sign', async () => {
    const a = await seedRoundTrip()
    await a.hidden.createRedirect({ from: '/50%25-off', to: '/about' }, a.owner)
    const { file } = await exportOf(a.hidden, a.owner)
    const b = await world({ site: hiddenSite, media: true, backups: true })
    await b.core.importContent(file, b.owner)
    expect((await b.core.listRedirects()).map((r) => r.from)).toContain('/50%-off')
  })

  it('replaces the site’s content instead of merging it', async () => {
    const a = await seedRoundTrip()
    const { file } = await exportOf(a.hidden, a.owner)
    const b = await world({ site: hiddenSite, media: true, backups: true })
    const extra = await b.core.createEntry('posts', { slug: 'extra', fields: fields('Extra') }, b.owner)
    const bytes = await png(6, 6, '#00ff00')
    const media = await b.core.addMedia({ data: bytes, filename: 'extra.png' }, b.owner)
    expect(existsSync(join(b.mediaDir!, sha256(bytes)))).toBe(true)

    await b.core.importContent(file, b.owner)
    expect(await b.core.getDocument(extra.id)).toBeNull()
    expect(await b.core.findEntry('posts', 'extra')).toBeNull()
    expect(await b.core.getMedia(media.media.id)).toBeNull()
    expect(existsSync(join(b.mediaDir!, sha256(bytes)))).toBe(false)
    expect((await b.core.listMedia()).map((m) => m.filename)).toEqual(['first.png'])
  })

  it('refuses before any backup when the site\'s own shipped content doesn\'t fit, and changes nothing', async () => {
    const a = await world({ media: true })
    await a.core.applyShippedContent()
    const { file } = await exportOf(a.core, a.owner)
    const b = await world({ site: brokenSite, media: true, backups: true })
    const before = await snapshot(b.db)

    const err = await rejection(b.core.importContent(file, b.owner))
    expect(err.code).toBe('check_failed')
    expect(err.messageId).toBe('error.checkFailed')
    expect(err.details.problems?.map((p) => p.code)).toEqual(['shipped_content'])
    expect(err.details.importReport?.general.map((p) => p.code)).toEqual(['shipped_content'])
    expect(err.details.importReport?.ok).toBe(false)
    expect(await listBackups(b.backupsDir!)).toEqual([])
    expect(await snapshot(b.db)).toEqual(before)
  })

  it('skips damaged media files and records them as deleted', async () => {
    const a = await world({ media: true })
    await a.core.applyShippedContent()
    const { media } = await a.core.addMedia({ data: await png(7, 7, '#abcdef'), filename: 'photo.png' }, a.owner)
    const { file } = await exportOf(a.core, a.owner)
    const damaged = join(await temp(), 'damaged.tar.gz')
    const unpacked = await temp()
    await tar.x({ file, cwd: unpacked })
    await writeFile(join(unpacked, 'media', media.id), 'not the same bytes')
    await tar.c({ gzip: true, file: damaged, cwd: unpacked }, await readdir(unpacked))

    const b = await world({ media: true, backups: true })
    const result = await b.core.importContent(damaged, b.owner)
    expect(result.report.ok).toBe(true)
    expect(result.report.media.damaged).toEqual(['photo.png'])
    expect(result.skipped).toEqual({ media: [media.id] })
    expect(await b.core.getMedia(media.id)).toBeNull()
    expect((await b.core.lookupMedia([media.id])).get(media.id)?.status).toBe('deleted')
  })

  it('leaves the live site as it was when copying media fails halfway', async () => {
    const a = await world({ media: true })
    await a.core.applyShippedContent()
    await a.core.addMedia({ data: await png(7, 7, '#123456'), filename: 'new.png' }, a.owner)
    const { file } = await exportOf(a.core, a.owner)

    const b = await world({ media: true, backups: true })
    await b.core.applyShippedContent()
    const post = await b.core.createEntry('posts', { slug: 'mine', fields: fields('Mine') }, b.owner)
    await b.core.addMedia({ data: await png(8, 8, '#654321'), filename: 'mine.png' }, b.owner)
    const before = await snapshot(b.db)

    const scratch = await temp()
    const savedTmp = process.env.TMPDIR
    await chmod(b.mediaDir!, 0o500)
    try {
      process.env.TMPDIR = scratch
      await expect(b.core.importContent(file, b.owner)).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = savedTmp
      await chmod(b.mediaDir!, 0o700)
    }

    const after = await snapshot(b.db)
    expect(after.documents).toEqual(before.documents)
    expect(after.revisions).toEqual(before.revisions)
    expect(after.media).toEqual(before.media)
    expect(await b.core.getDocument(post.id)).not.toBeNull()
    expect((await listBackups(b.backupsDir!)).map((x) => x.reason)).toEqual(['pre-import'])
    expect((await readdir(scratch)).filter((n) => n.startsWith('inlay-import-'))).toEqual([])
  })

  it('leaves the live site as it was when the replacement fails after media was copied in', async () => {
    const a = await world({ media: true })
    await a.core.applyShippedContent()
    const { media: incoming } = await a.core.addMedia({ data: await png(7, 7, '#123456'), filename: 'new.png' }, a.owner)
    const { file } = await exportOf(a.core, a.owner)

    const b = await world({ media: true, backups: true })
    await b.core.applyShippedContent()
    await b.core.createEntry('posts', { slug: 'mine', fields: fields('Mine') }, b.owner)
    await b.core.addMedia({ data: await png(8, 8, '#654321'), filename: 'mine.png' }, b.owner)
    const before = await snapshot(b.db)
    const files = (await readdir(b.mediaDir!)).sort()
    // The media rows are copied after the documents, so this fails partway through the transaction.
    await sql`CREATE TRIGGER refuse_media BEFORE INSERT ON media BEGIN SELECT RAISE(ABORT, 'refused'); END`.execute(b.db)
    const listener = vi.fn()
    b.core.onLiveChange(listener)

    await expect(b.core.importContent(file, b.owner)).rejects.toThrow('refused')
    await sql`DROP TRIGGER refuse_media`.execute(b.db)

    expect(await snapshot(b.db)).toEqual(before)
    expect((await listBackups(b.backupsDir!)).map((x) => x.reason)).toEqual(['pre-import'])
    expect((await readdir(b.mediaDir!)).sort()).toEqual(files)
    expect(files).not.toContain(incoming.id)
    expect(listener).not.toHaveBeenCalled()
  })

  it('counts as done once the content is replaced, even if an old media file cannot be removed', async () => {
    const a = await world({ media: true })
    await a.core.applyShippedContent()
    const { file } = await exportOf(a.core, a.owner)

    const b = await world({ media: true, backups: true })
    await b.core.applyShippedContent()
    const { media: old } = await b.core.addMedia({ data: await png(8, 8, '#654321'), filename: 'old.png' }, b.owner)
    const listener = vi.fn()
    b.core.onLiveChange(listener)

    await chmod(b.mediaDir!, 0o500)
    try {
      const result = await b.core.importContent(file, b.owner)
      expect(result.imported.media).toBe(0)
    } finally {
      await chmod(b.mediaDir!, 0o700)
    }
    expect(listener).toHaveBeenCalledTimes(1)
    expect(await b.db.selectFrom('media').select('id').execute()).toEqual([])
    expect(existsSync(join(b.mediaDir!, old.id))).toBe(true)
  })

  it('tells live-change listeners once per import, and not for a refused one', async () => {
    const a = await world({ media: true })
    await a.core.applyShippedContent()
    const { file } = await exportOf(a.core, a.owner)

    const broken = await world({ site: brokenSite, media: true, backups: true })
    const refused = vi.fn()
    broken.core.onLiveChange(refused)
    await rejection(broken.core.importContent(file, broken.owner))
    expect(refused).not.toHaveBeenCalled()

    const b = await world({ media: true, backups: true })
    const listener = vi.fn()
    b.core.onLiveChange(listener)
    await b.core.importContent(file, b.owner)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('is for owners only', async () => {
    const a = await world({ media: true })
    await a.core.applyShippedContent()
    const { file } = await exportOf(a.core, a.owner)
    const b = await world({ media: true, backups: true })
    await b.core.applyShippedContent()
    const before = await snapshot(b.db)

    const err = await rejection(b.core.importContent(file, b.editor))
    expect(err.code).toBe('forbidden')
    expect(await snapshot(b.db)).toEqual(before)
    expect(await listBackups(b.backupsDir!)).toEqual([])
  })

  it('needs a backups directory', async () => {
    const a = await world({ media: true })
    await a.core.applyShippedContent()
    const { file } = await exportOf(a.core, a.owner)
    const b = await world({ media: true })
    await b.core.applyShippedContent()
    const before = await snapshot(b.db)

    const err = await rejection(b.core.importContent(file, b.owner))
    expect(err.code).toBe('config')
    expect(err.messageId).toBe('config.backupsMissing')
    expect(await snapshot(b.db)).toEqual(before)
  })
})

describe('removeUnusedMedia', () => {
  it('keeps files that a live row uses', async () => {
    const w = await world({ media: true })
    const store = fileMediaStore(w.mediaDir as string)
    const { media } = await w.core.addMedia({ data: await png(4, 4), filename: 'a.png' }, w.owner)
    const a = media.id
    const b = 'b'.repeat(64)
    await store.put(b, Buffer.from('orphan'))
    expect(await removeUnusedMedia(w.db, store, [a, b])).toEqual([b])
    expect(await store.has(a)).toBe(true)
    expect(await store.has(b)).toBe(false)
  })
})

describe('listBackups', () => {
  it('reads a pre-import backup name', async () => {
    const dir = await temp()
    await writeFile(join(dir, 'inlay-backup-2026-01-01T00-00-00-000Z-pre-import.tar.gz'), 'x')
    const found = await listBackups(dir)
    expect(found).toMatchObject([{ createdAt: '2026-01-01T00:00:00.000Z', reason: 'pre-import', size: 1 }])
  })
})
