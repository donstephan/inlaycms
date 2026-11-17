import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractArchive } from '../../src/core/archive.js'
import { InlayError } from '../../src/core/errors.js'
import { readExport } from '../../src/core/export/read.js'
import type { Manifest, MediaIndex, RedirectRecord } from '../../src/core/export/format.js'
import { png, sha256 } from '../fixtures/media.js'
import { writeArchive, type ArchiveEntry } from '../fixtures/archives.js'
import { makeCore } from '../helpers/core.js'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function temp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'inlay-read-test-'))
  dirs.push(d)
  return d
}

const manifest: Manifest = {
  format: 'inlay-export',
  formatVersion: 1,
  inlayVersion: '0.0.0',
  exportedAt: '2026-01-01T00:00:00.000Z',
  locales: ['en'],
  defaultLocale: 'en',
  types: [],
  counts: { documents: 0, revisions: 0, publishEvents: 0, media: 0, redirects: 0 },
}
const doc = (id: string, over: Record<string, unknown> = {}) => ({
  record: 'document', id, kind: 'entry', type: 'posts', groupId: `g-${id}`, locale: 'en',
  headRevision: null, publishedRevision: null, deletedAt: null, createdAt: '2026-01-01T00:00:00.000Z', ...over,
})
const rev = (id: number, documentId: string) => ({
  record: 'revision', id, documentId, data: { fields: {}, slots: {} }, authorId: null,
  authorName: 'A', source: 'admin', message: null, createdAt: '2026-01-01T00:00:00.000Z',
})
const event = (id: number, items: unknown[]) => ({
  record: 'publishEvent', id, at: '2026-01-01T00:00:00.000Z', userId: null, userName: 'A', source: 'admin', message: null, items,
})
const nd = (...rows: unknown[]) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'

function base(over: { manifest?: unknown; content?: string; redirects?: unknown; media?: unknown; extra?: ArchiveEntry[] } = {}): ArchiveEntry[] {
  return [
    { path: 'manifest.json', body: JSON.stringify(over.manifest ?? manifest) },
    { path: 'content.ndjson', body: over.content ?? '' },
    { path: 'redirects.json', body: JSON.stringify(over.redirects ?? []) },
    { path: 'media.json', body: JSON.stringify(over.media ?? { files: [], deletions: [] }) },
    ...(over.extra ?? []),
  ]
}

async function archive(entries: ArchiveEntry[]): Promise<string> {
  const file = join(await temp(), 'a.tar.gz')
  await writeArchive(file, entries)
  return file
}

async function fails(entries: ArchiveEntry[], id: string): Promise<InlayError> {
  const err = await readExport(await archive(entries)).then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(InlayError)
  expect((err as InlayError).messageId).toBe(id)
  return err as InlayError
}

describe('readExport', () => {
  it('reads back what exportContent wrote', async () => {
    const w = await makeCore({ media: true })
    await w.core.applyShippedContent()
    const home = (await w.core.findSingleton('home'))!
    await w.core.publish([home.id], w.owner)
    const img = await png(4, 4)
    await w.core.addMedia({ data: img, filename: 'one.png' }, w.owner)
    const gone = await w.core.addMedia({ data: await png(5, 5, '#cc3333'), filename: 'two.png' }, w.owner)
    await w.core.deleteMedia(gone.media.id, w.owner)
    const about = (await w.core.findSingleton('about'))!
    await w.core.createRedirect({ from: '/old', to: { document: about.groupId } }, w.owner)
    const file = join(await temp(), 'out.tar.gz')
    await w.core.exportContent(file, w.owner)

    const bundle = await readExport(file)
    expect(bundle.manifest.formatVersion).toBe(2)
    expect(bundle.damaged).toEqual([])
    expect(bundle.documents.length).toBe(bundle.manifest.counts.documents)
    expect(bundle.revisions.length).toBe(bundle.manifest.counts.revisions)
    expect(bundle.publishEvents.length).toBe(bundle.manifest.counts.publishEvents)
    expect(bundle.media.map((m) => m.id)).toEqual([sha256(img)])
    expect(bundle.deletions.map((d) => d.filename)).toEqual(['two.png'])
    expect(bundle.redirects[0]?.to).toEqual({ group: about.groupId })
    expect(existsSync(join(bundle.dir, 'media', sha256(img)))).toBe(true)
    await bundle.close()
    expect(existsSync(bundle.dir)).toBe(false)
  })

  it('ignores hostile entries and never writes outside its directory', async () => {
    const outside = await temp()
    const sentinel = join(outside, 'sentinel')
    await writeFile(sentinel, 'untouched')
    const hex = 'a'.repeat(64)
    const file = await archive(
      base({
        extra: [
          { path: '../../evil', body: 'x' },
          { path: '/etc/x', body: 'x' },
          { path: 'media/../../x', body: 'x' },
          { path: `media/${hex}`, type: 'SymbolicLink', linkpath: '/etc/passwd' },
          { path: `media/${'b'.repeat(64)}`, type: 'Link', linkpath: sentinel },
          { path: 'media/notahash', body: 'x' },
          { path: 'extra.txt', body: 'x' },
        ],
      }),
    )
    const dir = await temp()
    const got = await extractArchive(file, dir, (p) => p === 'manifest.json' || /^media\/[0-9a-f]{64}$/.test(p))
    expect(got).toEqual(['manifest.json'])
    expect(await readFile(sentinel, 'utf8')).toBe('untouched')

    const bundle = await readExport(file)
    expect(bundle.media).toEqual([])
    expect(existsSync(join(bundle.dir, 'media', hex))).toBe(false)
    expect(existsSync(join(bundle.dir, 'extra.txt'))).toBe(false)
    expect(existsSync(join(bundle.dir, 'media', 'notahash'))).toBe(false)
    await bundle.close()
  })

  it('accepts entries written as ./name, as tar -C dir . makes them, but nothing less tidy', async () => {
    const hex = 'e'.repeat(64)
    const file = await archive([
      { path: './', type: 'Directory' },
      ...base().map((e) => ({ ...e, path: `./${e.path}` })),
      { path: './media/', type: 'Directory' },
      { path: `./media/${hex}`, body: 'x' },
      { path: `././media/${'f'.repeat(64)}`, body: 'x' },
      { path: `./media//${'1'.repeat(64)}`, body: 'x' },
      { path: `media/./${'2'.repeat(64)}`, body: 'x' },
      { path: './../evil', body: 'x' },
    ])
    const dir = await temp()
    const got = await extractArchive(file, dir, (p) => /^[a-z]+\.(json|ndjson)$/.test(p) || /^media\/[0-9a-f]{64}$/.test(p))
    expect(got.sort()).toEqual(['content.ndjson', 'manifest.json', 'media.json', `media/${hex}`, 'redirects.json'])
    expect(existsSync(join(dir, 'media', hex))).toBe(true)
    const bundle = await readExport(file)
    expect(bundle.manifest.format).toBe('inlay-export')
    await bundle.close()
  })

  it('does not accept a directory in place of a file', async () => {
    const entries = base().filter((e) => e.path !== 'manifest.json')
    await fails([{ path: 'manifest.json', type: 'Directory' }, ...entries], 'error.exportInvalid')
  })

  it('removes its directory when reading fails', async () => {
    // A private TMPDIR, so other test files' import dirs running in parallel can't show up here
    const scratch = await mkdtemp(join(tmpdir(), 'inlay-read-scratch-'))
    const savedTmp = process.env.TMPDIR
    try {
      process.env.TMPDIR = scratch
      await fails(base({ content: '{\n' }), 'error.exportDamaged')
      const after = await import('node:fs/promises').then((m) => m.readdir(scratch))
      expect(after.filter((n) => n.startsWith('inlay-import-'))).toEqual([])
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = savedTmp
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('refuses an archive over the size or entry limit', async () => {
    const hex = (n: number) => String(n).repeat(64)
    const file = await archive([
      ...base(),
      { path: '../evil', body: Buffer.alloc(1024 * 1024) },
      ...[1, 2, 3].map((n) => ({ path: `media/${hex(n)}`, body: '0123456789' })),
    ])
    const mediaOnly = (p: string) => p.startsWith('media/')
    const space = await extractArchive(file, await temp(), mediaOnly, { maxBytes: 25 }).catch((e: unknown) => e)
    expect(space).toBeInstanceOf(InlayError)
    expect((space as InlayError).messageId).toBe('error.archiveNoSpace')
    const many = await extractArchive(file, await temp(), mediaOnly, { maxEntries: 2 }).catch((e: unknown) => e)
    expect(many).toBeInstanceOf(InlayError)
    expect((many as InlayError).messageId).toBe('error.archiveTooManyFiles')
    expect((many as InlayError).params).toEqual({ count: 2 })
    expect(await extractArchive(file, await temp(), mediaOnly, { maxBytes: 30, maxEntries: 3 })).toHaveLength(3)
  })

  it('extracts a normal archive under the default limits', async () => {
    const file = await archive([...base(), { path: `media/${'1'.repeat(64)}`, body: '0123456789' }])
    expect(await extractArchive(file, await temp(), (p) => p.startsWith('media/'))).toHaveLength(1)
  })

  it('rejects a missing, foreign or newer manifest', async () => {
    await fails(base().filter((e) => e.path !== 'manifest.json'), 'error.exportInvalid')
    await fails(base({ manifest: { ...manifest, format: 'other' } }), 'error.exportInvalid')
    await fails(base({ manifest: '{' as unknown as object }), 'error.exportInvalid')
    const err = await fails(base({ manifest: { ...manifest, formatVersion: 3 } }), 'error.exportNewer')
    expect(err.code).toBe('validation')
    expect(err.params).toEqual({ version: 3 })
  })

  it('accepts a version-2 export whose documents carry fields it doesn\'t know', async () => {
    const content = nd(
      doc('d1', { firstPublishedAt: '2026-01-01T00:00:00.000Z' }),
      doc('d2'),
    )
    const bundle = await readExport(await archive(base({ manifest: { ...manifest, formatVersion: 2 }, content })))
    expect(bundle.documents.map((d) => d.id)).toEqual(['d1', 'd2'])
    await bundle.close()
  })

  it('reads firstPublishedAt, and a record without it as absent', async () => {
    const content = nd(
      doc('d1', { firstPublishedAt: '2026-01-02T00:00:00.000Z' }),
      doc('d2', { firstPublishedAt: null }),
      doc('d3'),
    )
    const bundle = await readExport(await archive(base({ manifest: { ...manifest, formatVersion: 2 }, content })))
    const byId = new Map(bundle.documents.map((d) => [d.id, d]))
    expect(byId.get('d1')!.firstPublishedAt).toBe('2026-01-02T00:00:00.000Z')
    expect(byId.get('d2')!.firstPublishedAt).toBeNull()
    expect(byId.get('d3')!.firstPublishedAt).toBeUndefined()
    await bundle.close()
  })

  it('ignores a schema version on a manifest type from an older export', async () => {
    const type = { name: 'posts', kind: 'collection', label: 'Posts', template: 'post', schema: {} }
    const versioned = { ...type, version: { template: 1, slots: {} } }
    const bundle = await readExport(await archive(base({ manifest: { ...manifest, types: [versioned] } })))
    expect(bundle.manifest.types).toEqual([type])
    await bundle.close()
  })

  it('rejects a missing content file', async () => {
    await fails(base().filter((e) => e.path !== 'content.ndjson'), 'error.exportInvalid')
    await fails(base().filter((e) => e.path !== 'media.json'), 'error.exportInvalid')
    await fails(base().filter((e) => e.path !== 'redirects.json'), 'error.exportInvalid')
  })

  describe('content.ndjson', () => {
    it('names the line of bad JSON', async () => {
      const err = await fails(base({ content: nd(doc('d1'), '{') }), 'error.exportDamaged')
      expect(err.code).toBe('validation')
      expect(err.message).toContain('Line 2')
    })

    it('rejects a record of the wrong shape', async () => {
      const err = await fails(base({ content: nd({ record: 'document', id: 5 }) }), 'error.exportDamaged')
      expect(err.message).toContain('Line 1')
    })

    it('ignores schema versions on a revision from an older export', async () => {
      const versioned = { ...rev(1, 'd1'), versions: { template: 1, slots: {} } }
      const bundle = await readExport(await archive(base({ content: nd(doc('d1'), versioned) })))
      expect(bundle.revisions).toEqual([{ ...rev(1, 'd1'), releaseId: null }])
      await bundle.close()
    })

    it('reads document and revision records that predate key, edition and releaseId', async () => {
      const bundle = await readExport(await archive(base({ content: nd(doc('d1'), rev(1, 'd1')) })))
      expect(bundle.documents[0]).toMatchObject({ key: null, edition: null })
      expect(bundle.revisions[0]).toMatchObject({ releaseId: null })
      await bundle.close()
    })

    it("reads an older export's initial source as release", async () => {
      const content = nd(doc('d1', { headRevision: 1 }), { ...rev(1, 'd1'), source: 'initial' }, { ...event(1, []), source: 'initial' })
      const bundle = await readExport(await archive(base({ content })))
      expect(bundle.revisions[0]!.source).toBe('release')
      expect(bundle.publishEvents[0]!.source).toBe('release')
      await bundle.close()
    })

    it('rejects a revision of an unknown document', async () => {
      const err = await fails(base({ content: nd(doc('d1'), rev(1, 'nope')) }), 'error.exportDamaged')
      expect(err.message).toContain('Line 2')
    })

    it('rejects a head revision that belongs to another document', async () => {
      const err = await fails(
        base({ content: nd(doc('d1', { headRevision: 2 }), doc('d2'), rev(1, 'd1'), rev(2, 'd2')) }),
        'error.exportDamaged',
      )
      expect(err.message).toContain('Line 1')
      await fails(base({ content: nd(doc('d1', { publishedRevision: 9 }), rev(1, 'd1')) }), 'error.exportDamaged')
    })

    it('rejects a publish event naming an unknown revision', async () => {
      const err = await fails(
        base({ content: nd(doc('d1'), rev(1, 'd1'), event(1, [{ documentId: 'd1', revisionId: 7, action: 'publish' }])) }),
        'error.exportDamaged',
      )
      expect(err.message).toContain('Line 3')
      await fails(
        base({ content: nd(doc('d1'), event(1, [{ documentId: 'zzz', revisionId: null, action: 'unpublish' }])) }),
        'error.exportDamaged',
      )
    })

    it('rejects duplicate ids', async () => {
      await fails(base({ content: nd(doc('d1'), doc('d1')) }), 'error.exportDamaged')
    })

    it('accepts a consistent set, ignoring blank lines', async () => {
      const content = nd(doc('d1', { headRevision: 1, publishedRevision: 1 }), rev(1, 'd1'), '', event(1, [{ documentId: 'd1', revisionId: 1, action: 'publish' }]))
      const bundle = await readExport(await archive(base({ content })))
      expect(bundle.documents.length).toBe(1)
      expect(bundle.revisions.length).toBe(1)
      expect(bundle.publishEvents.length).toBe(1)
      await bundle.close()
    })
  })

  it('rejects a redirect to a group no document has', async () => {
    const redirect: RedirectRecord = {
      id: 1, from: '/a', to: { group: 'nowhere' }, status: 301, source: 'manual', note: null,
      createdById: null, createdBy: 'A', createdAt: '2026-01-01T00:00:00.000Z',
    }
    await fails(base({ redirects: [redirect] }), 'error.exportDamaged')
    const ok = await readExport(await archive(base({ content: nd(doc('d1', { groupId: 'nowhere' })), redirects: [redirect] })))
    expect(ok.redirects.length).toBe(1)
    await ok.close()
  })

  describe('redirects.json', () => {
    const redirect = (id: number, from: string, to: RedirectRecord['to']): RedirectRecord => ({
      id, from, to, status: 301, source: 'manual', note: null, createdById: null, createdBy: 'A', createdAt: '2026-01-01T00:00:00.000Z',
    })
    const detailOf = async (redirects: RedirectRecord[]) => (await fails(base({ redirects }), 'error.exportDamaged')).params.detail

    it('rejects a redirect to another site', async () => {
      expect(await detailOf([redirect(1, '/a', { path: '//evil.example/' })])).toContain('redirects.json, entry 1')
      await detailOf([redirect(1, '/a', { path: 'https://evil.example/' })])
    })

    it('checks URL targets', async () => {
      await detailOf([redirect(1, '/a', { url: 'http://example.com/' })])
      await detailOf([redirect(1, '/a/:x', { url: 'https://example.com/:x' })])
      const ok = await readExport(await archive(base({ redirects: [redirect(1, '/a', { url: 'https://example.com/x' })] })))
      expect(ok.redirects[0]?.to).toEqual({ url: 'https://example.com/x' })
      await ok.close()
    })

    it('rejects an old address that is not a site path', async () => {
      await detailOf([redirect(1, 'nope', { path: '/b' })])
      await detailOf([redirect(1, '/admin/users', { path: '/b' })])
      await detailOf([redirect(1, '/en/a', { path: '/b' })])
      await detailOf([redirect(1, '/a?x=1', { path: '/b' })])
    })

    it('rejects a new address in the default language or with an unknown placeholder', async () => {
      await detailOf([redirect(1, '/a', { path: '/en/b' })])
      await detailOf([redirect(1, '/a/:slug', { path: '/b/:other' })])
    })

    it('rejects a repeated id or old address', async () => {
      await detailOf([redirect(1, '/a', { path: '/b' }), redirect(1, '/c', { path: '/d' })])
      expect(await detailOf([redirect(1, '/a', { path: '/b' }), redirect(2, '/a', { path: '/d' })])).toContain('entry 2')
    })

    it('rejects hostile addresses however they are written', async () => {
      for (const path of ['//evil', '/\\evil', '/%2F%2Fevil', '/%5Cevil', 'https://evil.example/', 'javascript:alert(1)', '/a\nb', '/a\u0000b']) {
        await detailOf([redirect(1, '/a', { path })])
        await detailOf([redirect(1, path, { path: '/b' })])
      }
    })

    it('accepts addresses stored decoded, with a literal percent sign', async () => {
      const ok = await readExport(
        await archive(base({ redirects: [redirect(1, '/100%-off', { path: '/b' }), redirect(2, '/a%41', { path: '/50%-off/x' })] })),
      )
      expect(ok.redirects.map((r) => r.from)).toEqual(['/100%-off', '/a%41'])
      await ok.close()
    })

    it('accepts valid redirects', async () => {
      const ok = await readExport(await archive(base({ redirects: [redirect(1, '/a/:slug', { path: '/b/:slug' }), redirect(2, '/c', { path: '/' })] })))
      expect(ok.redirects.length).toBe(2)
      await ok.close()
    })
  })

  it('rejects two documents for the same page and language', async () => {
    await fails(base({ content: nd(doc('d1', { groupId: 'g' }), doc('d2', { groupId: 'g' })) }), 'error.exportDamaged')
    const ok = await readExport(await archive(base({ content: nd(doc('d1', { groupId: 'g' }), doc('d2', { groupId: 'g', locale: 'es' })) })))
    expect(ok.documents.length).toBe(2)
    await ok.close()
  })

  it('rejects a document whose kind does not match its type in the manifest', async () => {
    const type = (name: string, kind: Manifest['types'][number]['kind']) => ({
      name, kind, label: name, template: name, schema: {},
    })
    const withTypes = { ...manifest, types: [type('posts', 'collection'), type('about', 'singleton'), type('footer', 'global')] }
    await fails(base({ manifest: withTypes, content: nd(doc('d1', { kind: 'singleton' })) }), 'error.exportDamaged')
    await fails(base({ manifest: withTypes, content: nd(doc('d1', { type: 'about' })) }), 'error.exportDamaged')
    await fails(base({ manifest: withTypes, content: nd(doc('d1', { type: 'footer', kind: 'singleton' })) }), 'error.exportDamaged')
    const content = nd(doc('d1'), doc('d2', { type: 'about', kind: 'singleton' }), doc('d3', { type: 'footer', kind: 'global' }), doc('d4', { type: 'unlisted', kind: 'singleton' }))
    const ok = await readExport(await archive(base({ manifest: withTypes, content })))
    expect(ok.documents.length).toBe(4)
    await ok.close()
  })

  it('rejects a media id listed twice', async () => {
    const good = Buffer.from('good bytes')
    const row = {
      id: sha256(good), filename: 'a.png', mime: 'image/png', size: 1, width: null, height: null, defaultAlt: null,
      createdById: null, createdBy: 'A', createdAt: '2026-01-01T00:00:00.000Z',
    }
    await fails(base({ media: { files: [row, { ...row, filename: 'b.png' }], deletions: [] }, extra: [{ path: `media/${row.id}`, body: good }] }), 'error.exportDamaged')
  })

  it('reports media that is missing or does not match its id as damaged', async () => {
    const good = Buffer.from('good bytes')
    const row = (id: string, filename: string) => ({
      id, filename, mime: 'image/png', size: 1, width: null, height: null, defaultAlt: null,
      createdById: null, createdBy: 'A', createdAt: '2026-01-01T00:00:00.000Z',
    })
    const missing = 'c'.repeat(64)
    const wrong = 'd'.repeat(64)
    const media: MediaIndex = {
      files: [row(sha256(good), 'good.png'), row(missing, 'missing.png'), row(wrong, 'wrong.png'), row('../../etc/passwd', 'sneaky.png')],
      deletions: [],
    }
    const bundle = await readExport(
      await archive(
        base({
          media,
          extra: [
            { path: `media/${sha256(good)}`, body: good },
            { path: `media/${wrong}`, body: 'not matching' },
          ],
        }),
      ),
    )
    expect(bundle.media.map((m) => m.filename)).toEqual(['good.png'])
    expect(bundle.damaged.map((m) => m.filename).sort()).toEqual(['missing.png', 'sneaky.png', 'wrong.png'])
    await bundle.close()
  })

  it('says a plain text file is not an archive', async () => {
    const file = join(await temp(), 'notes.tar.gz')
    await writeFile(file, 'just some words, nothing to see here\n'.repeat(40))
    const err = await readExport(file).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(InlayError)
    expect((err as InlayError).messageId).toBe('error.archiveUnreadable')
    expect((err as InlayError).code).toBe('validation')
    const missing = await readExport(join(await temp(), 'nope.tar.gz')).then(() => null, (e: unknown) => e)
    expect((missing as InlayError).messageId).toBe('error.archiveUnreadable')
  })
})
