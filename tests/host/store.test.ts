import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Kysely } from 'kysely'
import { openDatabase } from '../../src/core/db/connection.js'
import { migrateSystem } from '../../src/core/db/migrate.js'
import type { Database } from '../../src/core/db/schema.js'
import { InlayError } from '../../src/core/errors.js'
import { fingerprint, generateKeyPair } from '../../src/core/release/keys.js'
import type { ReleaseManifest } from '../../src/core/release/manifest.js'
import { packRelease } from '../../src/core/release/pack.js'
import {
  currentRelease,
  deleteRelease,
  getRelease,
  listReleases,
  openCurrentRelease,
  readCurrentPointer,
  releaseDir,
  storeRelease,
  writeCurrentPointer,
} from '../../src/host/store.js'
import { png } from '../fixtures/media.js'

const fixtures = resolve(import.meta.dirname, '../fixtures')

async function rejection(p: Promise<unknown>): Promise<InlayError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(InlayError)
    return e as InlayError
  }
  throw new Error('expected a rejection')
}

let packDir: string
let file: string
let manifest: ReleaseManifest
let keys: { privateKey: string; publicKey: string }

beforeAll(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'inlay-store-pack-'))
  const siteDir = join(packDir, 'site')
  await cp(join(fixtures, 'release'), siteDir, { recursive: true })
  await mkdir(join(siteDir, 'assets'))
  await writeFile(join(siteDir, 'assets/pic.png'), await png(20, 10))
  keys = generateKeyPair()
  file = join(packDir, 'site.tgz')
  ;({ manifest } = await packRelease({
    configFile: join(siteDir, 'inlay.config.ts'),
    privateKey: keys.privateKey,
    out: file,
    name: 'test-1',
  }))
})
afterAll(() => rm(packDir, { recursive: true, force: true }))

let dir: string
let releasesDir: string
let db: Kysely<Database>
let clock: number
const now = () => new Date(Date.UTC(2026, 10, 4, 12, 0, clock++))
const deps = () => ({ db, releasesDir, trustedKeys: [keys.publicKey], now })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inlay-store-'))
  releasesDir = join(dir, 'releases')
  await mkdir(releasesDir)
  db = openDatabase(':memory:')
  await migrateSystem(db)
  clock = 0
})
afterEach(async () => {
  await db.destroy()
  await rm(dir, { recursive: true, force: true })
})

describe('storeRelease', () => {
  it('keeps the file, opens it and records a staged row', async () => {
    const row = await storeRelease(deps(), file, { pushedBy: 'user-1' })
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(existsSync(join(releasesDir, `${row.id}.tgz`))).toBe(true)
    expect(existsSync(join(releaseDir(releasesDir, row.id), 'site.js'))).toBe(true)
    expect(existsSync(join(releaseDir(releasesDir, row.id), 'node_modules'))).toBe(false)
    expect(row).toMatchObject({
      name: 'test-1',
      state: 'staged',
      file: `${row.id}.tgz`,
      checksum: createHash('sha256').update(await readFile(file)).digest('hex'),
      signed_by: fingerprint(keys.publicKey),
      inlay_range: manifest.inlay.range,
      secrets: ['HOOK'],
      pushed_by: 'user-1',
      pushed_at: '2026-11-04T12:00:00.000Z',
      activated_at: null,
      deactivated_at: null,
    })
    expect(JSON.parse(row.schema)).toHaveProperty('home')
    expect(await getRelease(db, row.id)).toEqual(row)
  })

  it('takes a name over the manifest name', async () => {
    const row = await storeRelease(deps(), file, { pushedBy: null, name: 'spring' })
    expect(row.name).toBe('spring')
    expect(row.pushed_by).toBeNull()
  })

  it('leaves nothing behind for an untrusted key', async () => {
    const e = await rejection(
      storeRelease({ ...deps(), trustedKeys: [generateKeyPair().publicKey] }, file, { pushedBy: null }),
    )
    expect(e.messageId).toBe('error.releaseSignature')
    expect(await readdir(releasesDir)).toEqual([])
    expect(await listReleases(db)).toEqual([])
  })
})

describe('listing', () => {
  it('lists newest first and finds the current release', async () => {
    const a = await storeRelease(deps(), file, { pushedBy: null, name: 'a' })
    const b = await storeRelease(deps(), file, { pushedBy: null, name: 'b' })
    expect((await listReleases(db)).map((r) => r.name)).toEqual(['b', 'a'])
    expect(await currentRelease(db)).toBeNull()
    await db.updateTable('releases').set({ state: 'current' }).where('id', '=', a.id).execute()
    expect((await currentRelease(db))?.id).toBe(a.id)
    expect(await getRelease(db, 'nope')).toBeNull()
    expect(b.state).toBe('staged')
  })
})

describe('deleteRelease', () => {
  it('refuses the current release', async () => {
    const row = await storeRelease(deps(), file, { pushedBy: null })
    await db.updateTable('releases').set({ state: 'current' }).where('id', '=', row.id).execute()
    const e = await rejection(deleteRelease(deps(), row.id))
    expect(e.messageId).toBe('error.releaseCurrent')
    expect(existsSync(join(releasesDir, row.file))).toBe(true)
    expect((await getRelease(db, row.id))?.state).toBe('current')
  })

  it('removes a staged release and keeps its row as deleted', async () => {
    const row = await storeRelease(deps(), file, { pushedBy: null })
    await deleteRelease(deps(), row.id)
    expect(await readdir(releasesDir)).toEqual([])
    expect((await getRelease(db, row.id))?.state).toBe('deleted')
  })

  it('refuses an unknown release', async () => {
    const e = await rejection(deleteRelease(deps(), 'nope'))
    expect(e.messageId).toBe('error.releaseUnknown')
    expect(e.params).toEqual({ id: 'nope' })
  })
})

describe('the current pointer', () => {
  it('writes atomically and reads back', async () => {
    expect(await readCurrentPointer(releasesDir)).toBeNull()
    const pointer = { id: 'r1', name: 'spring', activatedAt: '2026-11-04T12:00:00.000Z' }
    await writeCurrentPointer(releasesDir, pointer)
    expect(await readCurrentPointer(releasesDir)).toEqual(pointer)
    expect(await readdir(releasesDir)).toEqual(['current.json'])
  })

  it('refuses a damaged pointer', async () => {
    await writeFile(join(releasesDir, 'current.json'), '{"id":')
    const e = await rejection(readCurrentPointer(releasesDir))
    expect(e.messageId).toBe('error.releasePointerInvalid')
  })

  it('refuses a pointer of the wrong shape', async () => {
    for (const text of [
      'null',
      '[]',
      '42',
      '{"name":"a","activatedAt":"b"}',
      '{"id":"","name":"a","activatedAt":"b"}',
      '{"id":"r1","name":1,"activatedAt":"b"}',
      '{"id":"r1","name":"a","activatedAt":null}',
      '{"id":"r1","name":"a","activatedAt":"b","extra":true}',
    ]) {
      await writeFile(join(releasesDir, 'current.json'), text)
      const e = await rejection(readCurrentPointer(releasesDir))
      expect(e.messageId, text).toBe('error.releasePointerInvalid')
    }
  })

  it('reads a pointer with surrounding whitespace', async () => {
    await writeFile(join(releasesDir, 'current.json'), '\n  {"id":"r1","name":"a","activatedAt":"b"}\n')
    expect(await readCurrentPointer(releasesDir)).toEqual({ id: 'r1', name: 'a', activatedAt: 'b' })
  })
})

describe('openCurrentRelease', () => {
  it('is null without a pointer', async () => {
    expect(await openCurrentRelease({ releasesDir })).toBeNull()
  })

  it('loads the release the pointer names', async () => {
    const row = await storeRelease(deps(), file, { pushedBy: null })
    const pointer = { id: row.id, name: row.name, activatedAt: '2026-11-04T12:00:00.000Z' }
    await writeCurrentPointer(releasesDir, pointer)
    const opened = await openCurrentRelease({ releasesDir })
    expect(opened).not.toBeNull()
    expect(opened && 'loaded' in opened).toBe(true)
    if (opened && 'loaded' in opened) {
      expect(opened.pointer).toEqual(pointer)
      expect(opened.loaded.dir).toBe(releaseDir(releasesDir, row.id))
      expect(opened.loaded.site.routes.map((r) => r.path)).toEqual(['/ping'])
    }
  })

  it('says the release is missing when its folder is gone', async () => {
    const row = await storeRelease(deps(), file, { pushedBy: null })
    const pointer = { id: row.id, name: row.name, activatedAt: '2026-11-04T12:00:00.000Z' }
    await writeCurrentPointer(releasesDir, pointer)
    await rm(join(releaseDir(releasesDir, row.id), 'site.js'))
    const load = vi.fn()
    expect(await openCurrentRelease({ releasesDir, load })).toEqual({ pointer, missing: true })
    await rm(releaseDir(releasesDir, row.id), { recursive: true })
    expect(await openCurrentRelease({ releasesDir, load })).toEqual({ pointer, missing: true })
    expect(load).not.toHaveBeenCalled()
  })
})
