import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { sql } from 'kysely'
import * as tar from 'tar'
import { systemCtx } from '../../src/core/auth/roles.js'
import { bootInlay } from '../../src/core/boot.js'
import { createBackup, listBackups } from '../../src/core/backup/backup.js'
import { databaseInUse, restoreBackup } from '../../src/core/backup/restore.js'
import { openDatabase } from '../../src/core/db/connection.js'
import { migrateSystem } from '../../src/core/db/migrate.js'
import { InlayError } from '../../src/core/errors.js'
import { readCurrentPointer, writeCurrentPointer } from '../../src/core/release/pointer.js'
import type { Ctx } from '../../src/core/types.js'
import { site } from '../fixtures/site.js'
import { png } from '../fixtures/media.js'
import { writeArchive } from '../fixtures/archives.js'

/** Lets a test make one `rename` fail; restore.ts gets these fs functions through the mock. */
const fsHook = vi.hoisted(() => ({ rename: null as null | ((from: string, to: string) => void) }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const rename: typeof real.rename = async (from, to) => {
    fsHook.rename?.(String(from), String(to))
    return real.rename(from, to)
  }
  return { ...real, rename, default: { ...real, rename } }
})
afterEach(() => {
  fsHook.rename = null
})

const owner: Ctx = { actor: { id: 'user-owner', name: 'Olivia Owner', role: 'owner' }, source: 'admin' }

async function rejection(p: Promise<unknown>): Promise<InlayError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(InlayError)
    return e as InlayError
  }
  throw new Error('expected a rejection')
}

describe('databaseInUse', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inlay-inuse-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('is true while a connection is open after a write, false after it closes', async () => {
    const file = join(dir, 'site.db')
    expect(await databaseInUse(file)).toBe(false)
    const db = openDatabase(file)
    await migrateSystem(db)
    expect(await databaseInUse(file)).toBe(true)
    await db.destroy()
    expect(await databaseInUse(file)).toBe(false)
  })
})

describe('restoreBackup', () => {
  let dir: string
  let dbFile: string
  let media: string
  let backups: string
  const boot = () => bootInlay({ site, db: dbFile, media, backups })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inlay-restore-'))
    dbFile = join(dir, 'site.db')
    media = join(dir, 'media')
    backups = join(dir, 'backups')
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  async function titleOf(): Promise<string> {
    const { core, db } = await boot()
    try {
      const about = (await core.findSingleton('about'))!
      return (await core.getDocument(about.id, { state: 'published' }))!.data.fields.title as string
    } finally {
      await db.destroy()
    }
  }

  async function setTitle(core: Awaited<ReturnType<typeof boot>>['core'], title: string) {
    const about = (await core.findSingleton('about'))!
    const doc = (await core.getDocument(about.id))!
    await core.saveDraft(about.id, { baseRevisionId: doc.headRev, data: { ...doc.data, fields: { ...doc.data.fields, title } } }, owner)
    await core.publish([about.id], owner)
  }

  async function backupWith(files: Array<{ path: string; body: string | Uint8Array; type?: 'File' | 'SymbolicLink'; linkpath?: string }>) {
    await mkdir(backups, { recursive: true })
    const archive = join(backups, 'inlay-backup-2026-01-01T00-00-00-000Z-manual.tar.gz')
    await writeArchive(archive, files)
    return archive
  }

  const meta = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ format: 1, inlayVersion: '0.0.0', createdAt: '2026-01-01T00:00:00.000Z', reason: 'manual', ...over })

  it('swaps the database and media back to the backup, keeping the replaced ones', async () => {
    const first = await boot()
    await setTitle(first.core, 'Before')
    const info = await createBackup({ db: first.db, backups, media, reason: 'manual', ctx: owner })
    await setTitle(first.core, 'After')
    const image = await png(4, 4)
    const { media: added } = await first.core.addMedia({ data: image, filename: 'a.png' }, owner)
    await first.db.destroy()
    expect(existsSync(join(media, added.id))).toBe(true)

    const result = await restoreBackup({ archive: basename(info.path), db: dbFile, media, backups })
    expect(result.restored.reason).toBe('manual')
    expect(await titleOf()).toBe('Before')
    expect(existsSync(join(media, added.id))).toBe(false)
    expect(await databaseInUse(dbFile)).toBe(false)

    expect(result.previous.db).not.toBeNull()
    expect(result.previous.media).not.toBeNull()
    expect(existsSync(join(result.previous.media!, added.id))).toBe(true)
    const old = openDatabase(result.previous.db!, { readonly: true })
    const row = await old.selectFrom('revisions').select('data').orderBy('id', 'desc').executeTakeFirstOrThrow()
    expect(JSON.parse(row.data).fields.title).toBe('After')
    await old.destroy()
    expect((await readdir(dir)).filter((n) => n.startsWith('.inlay-restore-'))).toEqual([])
  })

  it('restores into a site with no database or media yet', async () => {
    const first = await boot()
    const info = await createBackup({ db: first.db, backups, reason: 'manual', ctx: owner })
    await first.db.destroy()
    await rm(dbFile)
    await rm(media, { recursive: true, force: true })
    const result = await restoreBackup({ archive: info.path, db: dbFile, media, backups })
    expect(result.previous).toEqual({ db: null, media: null })
    expect(existsSync(media)).toBe(true)
    expect(await titleOf()).toBe('About us')
  })

  it('a backup without a release removes the pointer to the live release', async () => {
    const first = await boot()
    const info = await createBackup({ db: first.db, backups, reason: 'manual', ctx: owner })
    await first.db.destroy()
    await mkdir(join(dir, 'releases'))
    await writeCurrentPointer(join(dir, 'releases'), { id: 'r-1', name: 'one', activatedAt: '2026-01-01T00:00:00.000Z' })
    const result = await restoreBackup({ archive: info.path, db: dbFile, media, backups })
    expect(result.release).toBeNull()
    expect(await readCurrentPointer(join(dir, 'releases'))).toBeNull()
  })

  it('refuses while the database is open, and goes ahead with serverStopped', async () => {
    const first = await boot()
    const info = await createBackup({ db: first.db, backups, reason: 'manual', ctx: owner })
    const err = await rejection(restoreBackup({ archive: info.path, db: dbFile, media, backups }))
    expect(err.messageId).toBe('error.databaseInUse')
    expect(err.code).toBe('invalid_operation')
    expect((await readdir(dir)).some((n) => n.includes('before-restore'))).toBe(false)
    await first.db.destroy()
    const again = await boot()
    await restoreBackup({ archive: info.path, db: dbFile, media, backups, serverStopped: true })
    await again.db.destroy()
  })

  it('reports an unknown backup', async () => {
    const err = await rejection(restoreBackup({ archive: 'nope.tar.gz', db: dbFile, media, backups }))
    expect(err.messageId).toBe('error.backupNotFound')
  })

  it('rejects a damaged database and leaves the current one alone', async () => {
    await (await boot()).db.destroy()
    const before = await readFile(dbFile)
    await backupWith([
      { path: 'backup.json', body: meta() },
      { path: 'inlay.db', body: Buffer.from('this is not a database '.repeat(200)) },
    ])
    const err = await rejection(restoreBackup({ archive: 'inlay-backup-2026-01-01T00-00-00-000Z-manual.tar.gz', db: dbFile, media, backups }))
    expect(err.messageId).toBe('error.backupDamaged')
    expect(await readFile(dbFile)).toEqual(before)
    expect((await readdir(dir)).some((n) => n.includes('before-restore') || n.startsWith('.inlay-restore-'))).toBe(false)
  })

  it('rejects a backup with another format', async () => {
    await (await boot()).db.destroy()
    const good = await readFile(dbFile)
    await backupWith([
      { path: 'backup.json', body: meta({ format: 2 }) },
      { path: 'inlay.db', body: good },
    ])
    const err = await rejection(restoreBackup({ archive: join(backups, 'inlay-backup-2026-01-01T00-00-00-000Z-manual.tar.gz'), db: dbFile, media, backups }))
    expect(err.messageId).toBe('error.backupInvalid')
  })

  it('rejects a backup with an unknown reason or no backup.json', async () => {
    await (await boot()).db.destroy()
    const good = await readFile(dbFile)
    await backupWith([{ path: 'backup.json', body: meta({ reason: 'whim' }) }, { path: 'inlay.db', body: good }])
    const a = join(backups, 'inlay-backup-2026-01-01T00-00-00-000Z-manual.tar.gz')
    expect((await rejection(restoreBackup({ archive: a, db: dbFile, media, backups }))).messageId).toBe('error.backupInvalid')
    await backupWith([{ path: 'inlay.db', body: good }])
    expect((await rejection(restoreBackup({ archive: a, db: dbFile, media, backups }))).messageId).toBe('error.backupInvalid')
  })

  it('rejects a backup with only one of release.tgz and release.json', async () => {
    await (await boot()).db.destroy()
    const good = await readFile(dbFile)
    const a = join(backups, 'inlay-backup-2026-01-01T00-00-00-000Z-manual.tar.gz')
    await backupWith([{ path: 'backup.json', body: meta() }, { path: 'inlay.db', body: good }, { path: 'release.tgz', body: 'x' }])
    expect((await rejection(restoreBackup({ archive: a, db: dbFile, media, backups }))).messageId).toBe('error.backupInvalid')
    await backupWith([
      { path: 'backup.json', body: meta() },
      { path: 'inlay.db', body: good },
      { path: 'release.json', body: JSON.stringify({ id: 'r-1', name: 'x' }) },
    ])
    expect((await rejection(restoreBackup({ archive: a, db: dbFile, media, backups }))).messageId).toBe('error.backupInvalid')
  })

  it('rejects a release the database in the backup has no row for', async () => {
    await (await boot()).db.destroy()
    const good = await readFile(dbFile)
    const a = join(backups, 'inlay-backup-2026-01-01T00-00-00-000Z-manual.tar.gz')
    await backupWith([
      { path: 'backup.json', body: meta() },
      { path: 'inlay.db', body: good },
      { path: 'release.tgz', body: 'x' },
      { path: 'release.json', body: JSON.stringify({ id: 'r-1', name: 'x' }) },
    ])
    expect((await rejection(restoreBackup({ archive: a, db: dbFile, media, backups }))).messageId).toBe('error.backupInvalid')
    expect(existsSync(join(dir, 'releases'))).toBe(false)
  })

  it('rejects a database from a newer version', async () => {
    const first = await boot()
    await sql`INSERT INTO kysely_migration (name, timestamp) VALUES ('9999_future', '2099')`.execute(first.db)
    const info = await createBackup({ db: first.db, backups, reason: 'manual', ctx: systemCtx('system') })
    await first.db.destroy()
    const err = await rejection(restoreBackup({ archive: info.path, db: dbFile, media, backups }))
    expect(err.messageId).toBe('error.backupNewer')
    expect((await listBackups(backups)).length).toBe(1)
  })

  it('ignores hostile entries', async () => {
    const first = await boot()
    const info = await createBackup({ db: first.db, backups, reason: 'manual', ctx: owner })
    await first.db.destroy()
    const sentinel = join(dir, 'outside')
    await writeFile(sentinel, 'untouched')
    const sub = join(dir, 'sub')
    await mkdir(sub)
    const real = await mkdtemp(join(dir, 'x-'))
    await tar.x({ file: info.path, cwd: real })
    const hostile = join(dir, 'hostile.tar.gz')
    const hash = 'a'.repeat(64)
    await writeArchive(hostile, [
      { path: 'backup.json', body: meta() },
      { path: 'inlay.db', body: await readFile(join(real, 'inlay.db')) },
      { path: '../outside', body: 'pwned' },
      { path: 'media/../../outside', body: 'pwned' },
      { path: `media/${hash}`, type: 'SymbolicLink', linkpath: '/etc/passwd' },
    ])
    await restoreBackup({ archive: hostile, db: dbFile, media, backups })
    expect(await readFile(sentinel, 'utf8')).toBe('untouched')
    expect(await readdir(media)).toEqual([])
  })

  it('rejects an SQLite file that is not an Inlay database', async () => {
    await (await boot()).db.destroy()
    const before = await readFile(dbFile)
    const other = join(dir, 'other.db')
    const db = openDatabase(other)
    await sql`CREATE TABLE notes (body TEXT)`.execute(db)
    await db.destroy()
    await backupWith([{ path: 'backup.json', body: meta() }, { path: 'inlay.db', body: await readFile(other) }])
    const err = await rejection(restoreBackup({ archive: 'inlay-backup-2026-01-01T00-00-00-000Z-manual.tar.gz', db: dbFile, media, backups }))
    expect(err.messageId).toBe('error.backupInvalid')
    expect(await readFile(dbFile)).toEqual(before)
  })

  it('keeps the replaced database with its write-ahead log, so nothing written before an unclean stop is lost', async () => {
    const first = await boot()
    await setTitle(first.core, 'Before')
    const info = await createBackup({ db: first.db, backups, reason: 'manual', ctx: owner })
    await setTitle(first.core, 'Latest')
    // A copy taken while the connection is open is what an unclean stop leaves: the newest writes are only in -wal.
    const crashed = join(dir, 'crashed.db')
    for (const s of ['', '-wal', '-shm']) await copyFile(`${dbFile}${s}`, `${crashed}${s}`)
    await first.db.destroy()

    const result = await restoreBackup({ archive: info.path, db: crashed, media, backups, serverStopped: true })
    expect(existsSync(`${result.previous.db}-wal`)).toBe(true)
    const old = openDatabase(result.previous.db!)
    const row = await old.selectFrom('revisions').select('data').orderBy('id', 'desc').executeTakeFirstOrThrow()
    expect(JSON.parse(row.data).fields.title).toBe('Latest')
    await old.destroy()
  })

  describe('when a step fails', () => {
    async function setUp(mediaDir: string) {
      const first = bootInlay({ site, db: dbFile, media: mediaDir, backups })
      const { core, db } = await first
      await setTitle(core, 'Before')
      const image = await png(4, 4)
      await core.addMedia({ data: image, filename: 'a.png' }, owner)
      const info = await createBackup({ db, backups, media: mediaDir, reason: 'manual', ctx: owner })
      await setTitle(core, 'After')
      const { media: added } = await core.addMedia({ data: await png(6, 6, '#336699'), filename: 'b.png' }, owner)
      await db.destroy()
      return { info, added: added.id, db: await readFile(dbFile), media: (await readdir(mediaDir)).sort() }
    }

    async function unchanged(mediaDir: string, before: { db: Buffer; media: string[] }) {
      expect(await readFile(dbFile)).toEqual(before.db)
      expect((await readdir(mediaDir)).sort()).toEqual(before.media)
      expect((await readdir(dir)).filter((n) => n.includes('before-restore') || n.startsWith('.inlay-restore-'))).toEqual([])
    }

    it('puts the database back when the media folder cannot be moved aside', async () => {
      const parent = join(dir, 'locked')
      await mkdir(parent)
      const mediaDir = join(parent, 'media')
      const before = await setUp(mediaDir)
      await chmod(parent, 0o500)
      try {
        await expect(restoreBackup({ archive: before.info.path, db: dbFile, media: mediaDir, backups })).rejects.toMatchObject({ code: 'EACCES' })
      } finally {
        await chmod(parent, 0o700)
      }
      await unchanged(mediaDir, before)
      expect(await readdir(parent)).toEqual(['media'])
    })

    it('puts both back when the restored media cannot be put in place', async () => {
      const before = await setUp(media)
      fsHook.rename = (from, to) => {
        if (to === media && from.includes('.inlay-restore-')) throw Object.assign(new Error('no'), { code: 'EIO' })
      }
      await expect(restoreBackup({ archive: before.info.path, db: dbFile, media, backups })).rejects.toMatchObject({ code: 'EIO' })
      fsHook.rename = null
      await unchanged(media, before)
      expect(await titleOf()).toBe('After')
    })

    it('puts both back when the restored database cannot be put in place', async () => {
      const before = await setUp(media)
      fsHook.rename = (from, to) => {
        if (to === dbFile && from.includes('.inlay-restore-')) throw Object.assign(new Error('no'), { code: 'EIO' })
      }
      await expect(restoreBackup({ archive: before.info.path, db: dbFile, media, backups })).rejects.toMatchObject({ code: 'EIO' })
      fsHook.rename = null
      await unchanged(media, before)
    })

    it('says where the old files are when they cannot be put back', async () => {
      const before = await setUp(media)
      fsHook.rename = (from, to) => {
        if (to === media && from.includes('.inlay-restore-')) throw Object.assign(new Error('no'), { code: 'EIO' })
        if (to === media && from.includes('.before-restore-')) throw Object.assign(new Error('no'), { code: 'EIO' })
      }
      const err = await rejection(restoreBackup({ archive: before.info.path, db: dbFile, media, backups }))
      fsHook.rename = null
      expect(err.messageId).toBe('error.restoreRollbackFailed')
      expect(err.cause).toMatchObject({ code: 'EIO' })
      const kept = (await readdir(dir)).filter((n) => n.includes('before-restore'))
      expect(kept).toEqual(['media.before-restore-' + kept[0]!.split('before-restore-')[1]])
      expect(err.message).toContain(join(dir, kept[0]!))
      expect(await readFile(dbFile)).toEqual(before.db)
      expect((await readdir(join(dir, kept[0]!))).sort()).toEqual(before.media)
    })
  })
})
