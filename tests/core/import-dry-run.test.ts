import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import * as tar from 'tar'
import type { Database } from '../../src/core/db/schema.js'
import { InlayError } from '../../src/core/errors.js'
import type { ContentRecord, Manifest, MediaIndex, RedirectRecord, RevisionRecord } from '../../src/core/export/format.js'
import { dryRunImport } from '../../src/core/export/import.js'
import { formatImportReport, type ImportReport } from '../../src/core/export/report.js'
import type { SiteDefinition } from '../../src/core/registry/define.js'
import { noTestimonialsSite, postSummarySite } from '../fixtures/evolve.js'
import { site, withoutLocale } from '../fixtures/site.js'
import { writeArchive, type ArchiveEntry } from '../fixtures/archives.js'
import { png } from '../fixtures/media.js'
import { makeCore } from '../helpers/core.js'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function temp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'inlay-dry-run-test-'))
  dirs.push(d)
  return d
}

type World = Awaited<ReturnType<typeof makeCore>>

async function seed(on: SiteDefinition = site): Promise<World> {
  const w = await makeCore({ site: on, media: true })
  if (w.mediaDir) dirs.push(w.mediaDir)
  await w.core.applyShippedContent()
  const home = (await w.core.findSingleton('home'))!
  await w.core.publish([home.id], w.owner)
  for (const title of ['One', 'Two']) {
    const post = await w.core.createEntry('posts', { fields: { title, date: '2026-02-01', body: 'Body' } }, w.owner)
    await w.core.publish([post.id], w.owner)
  }
  return w
}

async function exportOf(w: World): Promise<string> {
  const file = join(await temp(), 'export.tar.gz')
  await w.core.exportContent(file, w.owner)
  return file
}

interface Unpacked {
  manifest: Manifest
  content: ContentRecord[]
  redirects: RedirectRecord[]
  media: MediaIndex
  files: Map<string, Buffer>
}

/** Unpacks `archive`, lets `edit` change it, and packs it again. */
async function rewrite(archive: string, edit: (x: Unpacked) => void): Promise<string> {
  const dir = await temp()
  await tar.x({ file: archive, cwd: dir })
  const json = async (name: string): Promise<unknown> => JSON.parse(await readFile(join(dir, name), 'utf8'))
  const files = new Map<string, Buffer>()
  const names = await readdir(join(dir, 'media')).catch(() => [])
  for (const name of names) files.set(name, await readFile(join(dir, 'media', name)))
  const x: Unpacked = {
    manifest: (await json('manifest.json')) as Manifest,
    content: (await readFile(join(dir, 'content.ndjson'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ContentRecord),
    redirects: (await json('redirects.json')) as RedirectRecord[],
    media: (await json('media.json')) as MediaIndex,
    files,
  }
  edit(x)
  const entries: ArchiveEntry[] = [
    { path: 'manifest.json', body: JSON.stringify(x.manifest) },
    { path: 'content.ndjson', body: x.content.map((r) => `${JSON.stringify(r)}\n`).join('') },
    { path: 'redirects.json', body: JSON.stringify(x.redirects) },
    { path: 'media.json', body: JSON.stringify(x.media) },
    ...[...x.files].map(([id, body]) => ({ path: `media/${id}`, body })),
  ]
  const out = join(await temp(), 'edited.tar.gz')
  await writeArchive(out, entries)
  return out
}

const typeRow = (report: ImportReport, type: string) => report.types.find((r) => r.type === type)
const localeRow = (report: ImportReport, locale: string) => report.locales.find((r) => r.locale === locale)

/** The fixture site in English only (no `es` shipped content). */
const englishOnly: SiteDefinition = withoutLocale(site, 'es')

async function counts(db: Kysely<Database>) {
  const n = async (table: 'documents' | 'revisions' | 'publish_events' | 'refs' | 'media' | 'media_deletions' | 'redirects') =>
    Number((await db.selectFrom(table).select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)
  const maxRev = await db.selectFrom('revisions').select((eb) => eb.fn.max('id').as('id')).executeTakeFirstOrThrow()
  return {
    documents: await n('documents'),
    revisions: await n('revisions'),
    events: await n('publish_events'),
    refs: await n('refs'),
    media: await n('media'),
    deletions: await n('media_deletions'),
    redirects: await n('redirects'),
    maxRev: maxRev.id,
  }
}

describe('dryRunImport', () => {
  it('reports the same site as ready', async () => {
    const w = await seed()
    const report = await dryRunImport(site, await exportOf(w))
    expect(report.ok).toBe(true)
    expect(report.general).toEqual([])
    expect(report.shipped).toEqual([])
    expect(report.media).toEqual({ files: 0, damaged: [] })
    expect(report.redirects).toEqual({ count: 0 })
    const documents = Object.fromEntries(report.types.map((r) => [r.type, r.documents]))
    expect(documents).toEqual({ home: 2, about: 1, notFound: 1, posts: 2, testimonials: 1, nav: 1 })
    for (const row of report.types) {
      expect(row).toMatchObject({ status: 'compatible', current: row.type, gaps: 0 })
    }
    expect(typeRow(report, 'posts')?.label).toBe('Posts')
    expect(report.locales.length).toBeGreaterThan(0)
    expect(localeRow(report, 'en')).toMatchObject({ status: 'compatible' })
    for (const row of report.locales) expect(row.status).toBe('compatible')
  })

  it('keeps a type the site doesn\'t have, hidden', async () => {
    const report = await dryRunImport(noTestimonialsSite, await exportOf(await seed()))
    const row = typeRow(report, 'testimonials')!
    expect(row).toMatchObject({ status: 'hidden', current: null, label: 'Testimonials', documents: 1, gaps: 0 })
    expect(typeRow(report, 'home')?.status).toBe('compatible')
    expect(report.general).toEqual([])
    expect(report.ok).toBe(true)
  })

  it('keeps a locale the site doesn\'t have, hidden', async () => {
    const w = await seed()
    const about = (await w.core.findSingleton('about'))!
    await w.core.createTranslation(about.groupId, 'es', w.owner)
    const report = await dryRunImport(englishOnly, await exportOf(w))
    expect(localeRow(report, 'es')).toMatchObject({ status: 'hidden', documents: 2 })
    expect(localeRow(report, 'en')?.status).toBe('compatible')
    expect(typeRow(report, 'about')?.status).toBe('compatible')
    expect(report.ok).toBe(true)
  })

  it('counts the documents that will need attention when the site requires a new field', async () => {
    const report = await dryRunImport(postSummarySite, await exportOf(await seed()))
    expect(typeRow(report, 'posts')).toMatchObject({ status: 'compatible', documents: 2, gaps: 2 })
    expect(typeRow(report, 'about')?.gaps).toBe(0)
    expect(report.ok).toBe(true)
  })

  it('counts published content that no longer fits as needing attention', async () => {
    const archive = await rewrite(await exportOf(await seed()), (x) => {
      const doc = x.content.find((r) => r.record === 'document' && r.type === 'about')
      if (doc?.record !== 'document') throw new Error('no about')
      const rev = x.content.find((r): r is RevisionRecord => r.record === 'revision' && r.id === doc.publishedRevision)!
      delete rev.data.fields.title
    })
    const report = await dryRunImport(site, archive)
    expect(typeRow(report, 'about')).toMatchObject({ status: 'compatible', gaps: 1 })
    expect(report.ok).toBe(true)
  })

  it('lists the shipped content an import would create', async () => {
    const archive = await rewrite(await exportOf(await seed()), (x) => {
      const ids = new Set(x.content.filter((r) => r.record === 'document' && r.type === 'about').map((r) => r.id))
      x.content = x.content
        .filter((r) => !(r.record === 'document' && ids.has(r.id)) && !(r.record === 'revision' && ids.has(r.documentId)))
        .map((r) => (r.record === 'publishEvent' ? { ...r, items: r.items.filter((i) => !ids.has(i.documentId)) } : r))
    })
    const report = await dryRunImport(site, archive)
    expect(report.ok).toBe(true)
    expect(report.shipped).toContain('About')
  })

  it('reports damaged media', async () => {
    const w = await seed()
    const added = await w.core.addMedia({ data: await png(4, 4), filename: 'photo.png' }, w.owner)
    const archive = await rewrite(await exportOf(w), (x) => {
      x.files.set(added.media.id, Buffer.from('not the same bytes'))
    })
    const report = await dryRunImport(site, archive)
    expect(report.media).toEqual({ files: 0, damaged: ['photo.png'] })
    expect(report.ok).toBe(true)
  })

  it('says an export whose records clash is damaged, not a database error', async () => {
    const w = await seed()
    const edited = await rewrite(await exportOf(w), (x) => {
      const home = x.content.find((r) => r.record === 'document' && r.type === 'home')!
      x.content.push({ ...home, id: 'another-home', groupId: 'another-home-group', headRevision: null, publishedRevision: null } as ContentRecord)
    })
    const err = await dryRunImport(site, edited).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(InlayError)
    expect((err as InlayError).messageId).toBe('error.exportDamaged')
  })

  it('writes nothing to the live database', async () => {
    const w = await seed()
    const archive = await exportOf(w)
    const before = await counts(w.db)
    const report = await w.core.importDryRun(archive, w.owner)
    expect(report.ok).toBe(true)
    expect(await counts(w.db)).toEqual(before)
  })

  it('is for owners only', async () => {
    const w = await seed()
    const archive = await exportOf(w)
    const err = await w.core.importDryRun(archive, w.editor).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(InlayError)
    expect((err as InlayError).code).toBe('forbidden')
  })
})

describe('formatImportReport', () => {
  it('gives one line per type, with the documents that will need attention underneath', async () => {
    const report = await dryRunImport(postSummarySite, await exportOf(await seed()))
    const lines = formatImportReport(report)
    expect(lines).toContain('Home: Ready (2 documents)')
    const at = lines.indexOf('Posts: Ready (2 documents)')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(lines[at + 1]).toMatch(/^\s+\S/)
    expect(lines[at + 1]).toContain('2')
  })
})
