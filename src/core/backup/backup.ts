import { chmod, copyFile, cp, link, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { sql, type Kysely } from 'kysely'
import * as tar from 'tar'
import { assertCan } from '../auth/roles.js'
import { openDatabase } from '../db/connection.js'
import type { Database } from '../db/schema.js'
import { releasesDirOf } from '../release/pointer.js'
import type { Ctx } from '../types.js'
import { inlayVersion } from '../version.js'

export type BackupReason = 'pre-migration' | 'pre-import' | 'pre-activation' | 'manual' | 'scheduled' | 'post-publish'

export interface BackupInfo {
  path: string
  createdAt: string
  reason: BackupReason
  size: number
}

/** Writes a consistent copy of the database with VACUUM INTO. Safe while the server is running. */
export async function snapshotDatabase(db: Kysely<Database>, target: string): Promise<void> {
  await sql`VACUUM INTO ${target}`.execute(db)
}

/** The release a database snapshot says is current, with its file in `releases`; null without one or its file. */
async function liveRelease(snapshot: string, releases: string): Promise<{ id: string; name: string; file: string } | null> {
  const db = openDatabase(snapshot, { readonly: true })
  let row: { id: string; name: string; file: string } | undefined
  try {
    const table = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'releases'`.execute(db)
    if (table.rows.length === 0) return null
    row = await db.selectFrom('releases').select(['id', 'name', 'file']).where('state', '=', 'current').executeTakeFirst()
  } finally {
    await db.destroy()
  }
  if (row === undefined || basename(row.file) !== row.file) return null
  const file = join(releases, row.file)
  if (!(await stat(file).then((s) => s.isFile(), () => false))) return null
  return { id: row.id, name: row.name, file }
}

/** The file `db` is open on; null for an in-memory database. */
async function databaseFile(db: Kysely<Database>): Promise<string | null> {
  const { rows } = await sql<{ name: string; file: string }>`PRAGMA database_list`.execute(db)
  return rows.find((r) => r.name === 'main')?.file || null
}

/**
 * Writes a backup archive: `backup.json`, a snapshot of the database as `inlay.db`, the media and, when the
 * snapshot has a current release whose file is in `releases` (default: the `releases` folder beside the database
 * file, as in the host's data folder), that file as `release.tgz` with `release.json` (`{ id, name }`).
 */
export async function createBackup(opts: {
  db: Kysely<Database>
  backups: string
  media?: string
  releases?: string
  reason: BackupReason
  ctx: Ctx
  now?: () => Date
}): Promise<BackupInfo> {
  assertCan(opts.ctx, 'backup.create')
  const createdAt = (opts.now ?? (() => new Date()))().toISOString()
  const stamp = createdAt.replace(/[:.]/g, '-')
  await mkdir(opts.backups, { recursive: true })

  const staging = await mkdtemp(join(opts.backups, '.tmp-'))
  let path: string
  try {
    await snapshotDatabase(opts.db, join(staging, 'inlay.db'))
    await writeFile(
      join(staging, 'backup.json'),
      JSON.stringify({ format: 1, inlayVersion: inlayVersion(), createdAt, reason: opts.reason }, null, 2),
    )
    const entries = ['backup.json', 'inlay.db']
    // Read from the snapshot, so the release in the archive is the one its database says is current.
    const file = await databaseFile(opts.db)
    const releases = opts.releases ?? (file === null ? null : releasesDirOf(file))
    const release = releases === null ? null : await liveRelease(join(staging, 'inlay.db'), releases)
    if (release) {
      await copyFile(release.file, join(staging, 'release.tgz'))
      await writeFile(join(staging, 'release.json'), JSON.stringify({ id: release.id, name: release.name }, null, 2))
      entries.push('release.tgz', 'release.json')
    }
    if (opts.media && existsSync(opts.media)) {
      const mediaRoot = opts.media
      await cp(mediaRoot, join(staging, 'media'), {
        recursive: true,
        filter: (src) => {
          const [first = ''] = relative(mediaRoot, src).split(sep)
          return first !== 'cache' && !first.startsWith('.tmp-')
        },
      })
      // `cp` keeps the directory's mode; a read-only media dir would leave a copy we can't clean up.
      await chmod(join(staging, 'media'), ((await stat(mediaRoot)).mode & 0o777) | 0o700)
      entries.push('media')
    }
    // Built beside the staging files, then linked into place, so a failed or
    // concurrent backup never leaves a partial archive under a real name.
    const archive = join(staging, 'archive.tar.gz')
    await tar.c({ gzip: true, file: archive, cwd: staging }, entries)
    path = await claimName(archive, opts.backups, stamp, opts.reason)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return { path, createdAt, reason: opts.reason, size: (await stat(path)).size }
}

/** Links `archive` to the first free backup name; `link` fails if the name exists, so two backups can't take the same one. */
async function claimName(archive: string, backups: string, stamp: string, reason: BackupReason): Promise<string> {
  for (let n = 1; ; n++) {
    const path = join(backups, `inlay-backup-${stamp}${n === 1 ? '' : `-${n}`}-${reason}.tar.gz`)
    try {
      await link(archive, path)
      return path
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
}

const BACKUP_NAME = /^inlay-backup-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-\d+)?-(pre-migration|pre-import|pre-activation|manual|scheduled|post-publish)\.tar\.gz$/

/** The backup archives in `dir`, newest first. A missing directory has none. */
export async function listBackups(dir: string): Promise<BackupInfo[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const found: BackupInfo[] = []
  for (const name of names) {
    const m = BACKUP_NAME.exec(name)
    if (!m) continue
    const path = join(dir, name)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) continue
    found.push({ path, createdAt: `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`, reason: m[6] as BackupReason, size: info.size })
  }
  return found.sort((a, b) => (a.createdAt === b.createdAt ? (a.path < b.path ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
}
