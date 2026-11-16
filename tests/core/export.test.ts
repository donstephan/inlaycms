import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { InlayError } from '../../src/core/errors.js'
import { createCore } from '../../src/core/core.js'
import { exportFileName, type ContentRecord, type Manifest, type MediaIndex, type RedirectRecord } from '../../src/core/export/format.js'
import { site as fixtureSite } from '../fixtures/site.js'
import { png, sha256 } from '../fixtures/media.js'
import { makeCore } from '../helpers/core.js'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function temp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'inlay-export-test-'))
  dirs.push(d)
  return d
}

async function unpack(archive: string) {
  const dir = await temp()
  const entries: string[] = []
  await tar.x({ file: archive, cwd: dir, onReadEntry: (e) => entries.push(e.path) })
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Manifest
  const content = (await readFile(join(dir, 'content.ndjson'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ContentRecord)
  const redirects = JSON.parse(await readFile(join(dir, 'redirects.json'), 'utf8')) as RedirectRecord[]
  const media = JSON.parse(await readFile(join(dir, 'media.json'), 'utf8')) as MediaIndex
  return { dir, entries, manifest, content, redirects, media }
}

async function seed() {
  const world = await makeCore({ media: true })
  const { core, owner } = world
  await core.applyShippedContent()
  const home = (await core.getDocument((await core.findSingleton('home'))!.id))!
  await core.publish([home.id], owner)
  const draft = structuredClone(home.data)
  draft.slots.hero!.data.headline = 'Draft headline'
  await core.saveDraft(home.id, { baseRevisionId: home.headRev, data: draft }, owner)
  const post = await core.createEntry(
    'posts',
    { slug: 'gone', fields: { title: 'Gone', date: '2026-01-01', body: 'bye' } },
    owner,
  )
  await core.deleteEntry(post.groupId, owner)
  const first = await png(4, 4)
  const second = await png(5, 5, '#cc3333')
  const a = await core.addMedia({ data: first, filename: 'first.png' }, owner)
  const b = await core.addMedia({ data: second, filename: 'second.png' }, owner)
  const about = (await core.findSingleton('about'))!
  const withImage = structuredClone(draft)
  withImage.slots.hero!.data.image = { media: a.media.id }
  const saved = await core.saveDraft(home.id, { baseRevisionId: (await core.getDocument(home.id))!.headRev, data: withImage }, owner)
  await core.deleteMedia(b.media.id, owner)
  await core.createRedirect({ from: '/old', to: { document: about.groupId } }, owner)
  return { ...world, home, saved, about, first, second }
}

describe('exportContent', () => {
  it('writes the documented archive', async () => {
    const w = await seed()
    const target = join(await temp(), 'out.tar.gz')
    const summary = await w.core.exportContent(target, w.owner)
    const x = await unpack(target)

    expect(summary.path).toBe(target)
    expect(summary.counts).toEqual(x.manifest.counts)
    expect([...x.entries].filter((e) => e !== 'media' && e !== 'media/').sort()).toEqual(
      ['manifest.json', 'content.ndjson', 'redirects.json', 'media.json', `media/${sha256(w.first)}`].sort(),
    )

    expect(x.manifest.format).toBe('inlay-export')
    expect(x.manifest.formatVersion).toBe(1)
    expect(x.manifest.exportedAt).toMatch(/^2026-01-01T/)
    expect(x.manifest.locales).toEqual(['en', 'es'])
    expect(x.manifest.types.map((t) => t.name).sort()).toEqual([...w.core.registry.types.keys()].sort())
    const home = x.manifest.types.find((t) => t.name === 'home')!
    expect(Object.keys(home).sort()).toEqual(['kind', 'label', 'name', 'schema', 'template'])
    const props = (home.schema.properties as any).fields.properties
    expect(props.title.title).toBe('Title')

    const count = (r: string) => x.content.filter((c) => c.record === r).length
    expect(count('document')).toBe(x.manifest.counts.documents)
    expect(count('revision')).toBe(x.manifest.counts.revisions)
    expect(count('publishEvent')).toBe(x.manifest.counts.publishEvents)
    const gone = x.content.find((c) => c.record === 'document' && c.type === 'posts')
    expect(gone?.record === 'document' && gone.deletedAt).toBeTruthy()
    const doc = x.content.find((c) => c.record === 'document' && c.id === w.home.id)!
    if (doc.record !== 'document') throw new Error('unreachable')
    expect(doc.headRevision).not.toBe(doc.publishedRevision)
    for (const id of [doc.headRevision, doc.publishedRevision]) {
      expect(x.content.some((c) => c.record === 'revision' && c.id === id)).toBe(true)
    }

    expect(x.redirects[0]?.to).toEqual({ group: w.about.groupId })
    expect(x.media.deletions[0]?.filename).toBe('second.png')
    expect(x.media.files.map((f) => f.filename)).toEqual(['first.png'])
    expect(await readdir(join(x.dir, 'media'))).toEqual([sha256(w.first)])
  })

  it('documents carry key and edition and revisions carry releaseId', async () => {
    const w = await seed()
    await w.db.updateTable('documents').set({ key: 'about', edition: 2 }).where('id', '=', w.about.id).execute()
    const target = join(await temp(), 'out.tar.gz')
    await w.core.exportContent(target, w.owner)
    const x = await unpack(target)
    const documentRecord = x.content.find((c) => c.record === 'document' && c.id === w.about.id)
    const revisionRecord = x.content.find((c) => c.record === 'revision')
    expect(documentRecord).toMatchObject({ key: 'about', edition: 2 })
    expect(revisionRecord).toMatchObject({ releaseId: null })
  })

  it('keeps hidden content', async () => {
    const w = await seed()
    const post = (await w.core.listEntries('posts', { includeDeleted: true }))[0]!
    expect(post).toBeDefined()
    const hidden = createCore({
      site: { ...fixtureSite, collections: fixtureSite.collections.filter((c) => c.name !== 'posts') },
      db: w.db,
      media: w.mediaDir!,
    })
    const target = join(await temp(), 'out.tar.gz')
    await hidden.exportContent(target, w.owner)
    const x = await unpack(target)
    expect(x.content.some((c) => c.record === 'document' && c.type === 'posts')).toBe(true)
  })

  it('moves media whose file vanished to deletions', async () => {
    const w = await seed()
    await rm(join(w.mediaDir!, sha256(w.first)))
    const target = join(await temp(), 'out.tar.gz')
    await w.core.exportContent(target, w.owner)
    const x = await unpack(target)
    expect(x.media.files).toEqual([])
    expect(x.media.deletions.map((d) => d.filename).sort()).toEqual(['first.png', 'second.png'])
    expect(x.entries.some((e) => e.startsWith('media/') && e !== 'media/')).toBe(false)
    expect(x.manifest.counts.media).toBe(0)
  })

  it('refuses editors and writes nothing', async () => {
    const { core, editor } = await makeCore({ media: true })
    const target = join(await temp(), 'out.tar.gz')
    const err = await core.exportContent(target, editor).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InlayError)
    expect((err as InlayError).code).toBe('forbidden')
    expect(existsSync(target)).toBe(false)
  })
})

describe('exportFileName', () => {
  it('uses the backup stamp', () => {
    expect(exportFileName(new Date('2026-01-01T00:00:00Z'))).toBe('inlay-export-2026-01-01T00-00-00-000Z.tar.gz')
  })
})
