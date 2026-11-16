import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { sql } from 'kysely'
import { extractArchive } from '../archive.js'
import { openDatabase } from '../db/connection.js'
import { unknownSystemMigrations } from '../db/migrate.js'
import { InlayError } from '../errors.js'
import { t } from '../messages/index.js'
import { releaseDir, releasesDirOf, removeCurrentPointer, writeCurrentPointer } from '../release/pointer.js'
import { extractRelease, openRelease } from '../release/read.js'
import type { BackupReason } from './backup.js'

const REASONS: readonly string[] = ['pre-migration', 'pre-import', 'pre-activation', 'manual', 'scheduled', 'post-publish']
const MEDIA_ENTRY = /^media\/[0-9a-f]{64}$/
const RELEASE_ENTRIES: readonly string[] = ['release.tgz', 'release.json']
const RELEASE_ID = /^[A-Za-z0-9-]{1,100}$/

/** True while a connection holds the database open: WAL mode keeps `-wal`/`-shm` until the last one closes cleanly. */
export async function databaseInUse(db: string): Promise<boolean> {
  return existsSync(`${db}-wal`) || existsSync(`${db}-shm`)
}

export interface RestoreBackupResult {
  restored: { createdAt: string; reason: BackupReason; inlayVersion: string }
  previous: { db: string | null; media: string | null }
  /**
   * The release put back as the current one; null for a backup without one. `verified`: its signature was checked
   * against the trusted keys given.
   */
  release: { id: string; name: string; verified: boolean } | null
}

async function readMeta(file: string): Promise<RestoreBackupResult['restored']> {
  let meta: unknown
  try {
    meta = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    throw new InlayError('validation', 'error.backupInvalid')
  }
  const m = meta as Record<string, unknown> | null
  if (
    typeof m !== 'object' || m === null || m.format !== 1 ||
    typeof m.reason !== 'string' || !REASONS.includes(m.reason) ||
    typeof m.createdAt !== 'string' || typeof m.inlayVersion !== 'string'
  ) {
    throw new InlayError('validation', 'error.backupInvalid')
  }
  return { createdAt: m.createdAt, reason: m.reason as BackupReason, inlayVersion: m.inlayVersion }
}

async function checkDatabase(file: string): Promise<void> {
  let unknown: string[] | null
  try {
    const db = openDatabase(file, { readonly: true })
    try {
      const rows = (await sql<{ integrity_check: string }>`PRAGMA integrity_check`.execute(db)).rows
      if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') throw new Error('integrity')
      unknown = await unknownSystemMigrations(db)
    } finally {
      await db.destroy()
    }
  } catch {
    throw new InlayError('validation', 'error.backupDamaged')
  }
  if (unknown === null) throw new InlayError('validation', 'error.backupInvalid')
  if (unknown.length > 0) throw new InlayError('validation', 'error.backupNewer')
}

/** `release.json` and the database's row for it; the release file's contents are checked by `extractRelease`. */
async function readRelease(work: string): Promise<{ id: string; name: string; activatedAt: string | null; checksum: string }> {
  let meta: unknown
  try {
    meta = JSON.parse(await readFile(join(work, 'release.json'), 'utf8'))
  } catch {
    throw new InlayError('validation', 'error.backupInvalid')
  }
  const m = meta as Record<string, unknown> | null
  if (typeof m !== 'object' || m === null || typeof m.id !== 'string' || !RELEASE_ID.test(m.id) || typeof m.name !== 'string') {
    throw new InlayError('validation', 'error.backupInvalid')
  }
  const id = m.id
  let row: { activated_at: string | null; checksum: string } | undefined
  const db = openDatabase(join(work, 'inlay.db'), { readonly: true })
  try {
    row = await db.selectFrom('releases').select(['activated_at', 'checksum']).where('id', '=', id).executeTakeFirst()
  } catch {
    row = undefined
  } finally {
    await db.destroy()
  }
  if (row === undefined) throw new InlayError('validation', 'error.backupInvalid')
  return { id, name: m.name, activatedAt: row.activated_at, checksum: row.checksum }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Renames, falling back to copy and remove across devices. For files extracted into the work directory. */
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    await cp(from, to, { recursive: true })
    await rm(from, { recursive: true, force: true })
  }
}

/**
 * Swaps the database and media for those in a backup. The server must be stopped; what is replaced is kept beside
 * it. A backup with a release puts its file and folder back in `releases` (default: the `releases` folder beside
 * `db`, as in the host's data folder) and makes it the one `current.json` names; one without removes
 * `current.json`. The release must suit this version of Inlay and, with `trustedKeys`, be signed by one of them.
 */
export async function restoreBackup(opts: {
  archive: string
  db: string
  media: string
  backups: string
  releases?: string
  trustedKeys?: readonly string[]
  serverStopped?: boolean
  now?: () => Date
  /** The Inlay version the release must suit; the running one by default. */
  inlayVersion?: string
}): Promise<RestoreBackupResult> {
  if (!opts.serverStopped && (await databaseInUse(opts.db))) {
    throw new InlayError('invalid_operation', 'error.databaseInUse', { path: opts.db })
  }
  const file = (await stat(opts.archive).then((s) => s.isFile(), () => false))
    ? opts.archive
    : basename(opts.archive) === opts.archive && (await stat(join(opts.backups, opts.archive)).then((s) => s.isFile(), () => false))
      ? join(opts.backups, opts.archive)
      : null
  if (file === null) throw new InlayError('not_found', 'error.backupNotFound')

  const work = await mkdtemp(join(dirname(opts.db), '.inlay-restore-'))
  try {
    const entries = await extractArchive(
      file,
      work,
      (p) => p === 'backup.json' || p === 'inlay.db' || RELEASE_ENTRIES.includes(p) || MEDIA_ENTRY.test(p),
    )
    if (!entries.includes('backup.json') || !entries.includes('inlay.db')) throw new InlayError('validation', 'error.backupInvalid')
    const restored = await readMeta(join(work, 'backup.json'))
    await checkDatabase(join(work, 'inlay.db'))

    const withRelease = RELEASE_ENTRIES.filter((p) => entries.includes(p)).length
    if (withRelease === 1) throw new InlayError('validation', 'error.backupInvalid')
    const release = withRelease === 2 ? await readRelease(work) : null
    const verified = opts.trustedKeys !== undefined && opts.trustedKeys.length > 0
    if (release) {
      // The file the database recorded when the release was stored, not another one put in its place.
      if ((await sha256File(join(work, 'release.tgz'))) !== release.checksum) {
        throw new InlayError('validation', 'error.backupRelease', { problem: t('error.backupReleaseChecksum') })
      }
      await mkdir(join(work, 'release'))
      const extract = { dir: join(work, 'release'), ...(opts.inlayVersion !== undefined && { inlayVersion: opts.inlayVersion }) }
      try {
        if (verified) await openRelease(join(work, 'release.tgz'), { ...extract, trustedKeys: opts.trustedKeys! })
        else await extractRelease(join(work, 'release.tgz'), extract)
      } catch (e) {
        if (!(e instanceof InlayError)) throw e
        throw new InlayError('validation', 'error.backupRelease', { problem: e.message })
      }
    }
    const releases = opts.releases ?? releasesDirOf(opts.db)

    const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-')
    const kept = `${opts.db}.before-restore-${stamp}`
    const keptMedia = `${opts.media}.before-restore-${stamp}`
    // The sidecars keep the names SQLite looks for beside the kept database, so it opens with its last writes.
    const sidecars: Array<[from: string, to: string]> = [
      [`${opts.db}-wal`, `${kept}-wal`],
      [`${opts.db}-shm`, `${kept}-shm`],
    ]
    const previous: RestoreBackupResult['previous'] = { db: null, media: null }
    const movedSidecars: Array<[from: string, to: string]> = []
    let movedDb = false
    let movedMedia = false
    let placedDb = false
    let placedMedia = false
    /** Puts back what was moved aside, then deletes what this call placed. Says where the old files are if it can't. */
    const rollBack = async (cause: unknown): Promise<void> => {
      const stuck: string[] = []
      const discard: string[] = []
      const back = async (from: string, to: string) => {
        try {
          await rename(to, from)
        } catch {
          stuck.push(to)
        }
      }
      if (placedMedia && existsSync(opts.media)) {
        const failed = `${opts.media}.failed-restore-${stamp}`
        try {
          await rename(opts.media, failed)
          discard.push(failed)
        } catch {
          if (movedMedia) stuck.push(keptMedia)
          movedMedia = false
        }
      }
      if (movedMedia) await back(opts.media, keptMedia)
      if (movedDb) await back(opts.db, kept)
      else if (placedDb) discard.push(opts.db)
      for (const [from, to] of movedSidecars.reverse()) await back(from, to)
      for (const path of discard) await rm(path, { recursive: true, force: true }).catch(() => {})
      if (stuck.length > 0) {
        const error = new InlayError('invalid_operation', 'error.restoreRollbackFailed', { paths: stuck.join(', ') })
        error.cause = cause
        throw error
      }
    }

    if (release) {
      // Before the swap: the folder is only used once `current.json` names it, which happens last. A release with
      // the same ID is the same release, so whatever is there is replaced.
      const target = releaseDir(releases, release.id)
      await mkdir(releases, { recursive: true })
      await rm(target, { recursive: true, force: true })
      await move(join(work, 'release'), target)
      await move(join(work, 'release.tgz'), join(releases, `${release.id}.tgz`))
    }

    try {
      if (existsSync(opts.db)) {
        await rename(opts.db, kept)
        movedDb = true
        previous.db = kept
      }
      for (const [from, to] of sidecars) {
        if (!existsSync(from)) continue
        await rename(from, to)
        movedSidecars.push([from, to])
      }
      if (existsSync(opts.media)) {
        await rename(opts.media, keptMedia)
        movedMedia = true
        previous.media = keptMedia
      }
      // From here, whatever is at `db` and `media` was put there by this call.
      placedDb = true
      await move(join(work, 'inlay.db'), opts.db)
      placedMedia = true
      if (existsSync(join(work, 'media'))) await move(join(work, 'media'), opts.media)
      else await mkdir(opts.media, { recursive: true })
      if (release) {
        await writeCurrentPointer(releases, {
          id: release.id,
          name: release.name,
          activatedAt: release.activatedAt ?? restored.createdAt,
        })
      } else {
        // The restored database has no release of its own; a worker would otherwise serve the replaced one.
        await removeCurrentPointer(releases)
      }
    } catch (e) {
      await rollBack(e)
      throw e
    }
    return { restored, previous, release: release && { id: release.id, name: release.name, verified } }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
