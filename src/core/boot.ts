import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import { systemCtx } from './auth/roles.js'
import { createAuthService, type AuthService } from './auth/service.js'
import { createBackup, type BackupInfo } from './backup/backup.js'
import { createCore, type Core } from './core.js'
import { openDatabase } from './db/connection.js'
import { migrateSystem, pendingSystemMigrations } from './db/migrate.js'
import type { Database } from './db/schema.js'
import { InlayError } from './errors.js'
import { t } from './messages/index.js'
import type { SiteDefinition } from './registry/define.js'
import { formatReport, type CheckReport } from './report.js'
import type { UploadLimits } from './types.js'

export interface BootOptions {
  site: SiteDefinition
  db: string
  backups: string
  media?: string
  uploads?: UploadLimits
  now?: () => Date
  /** Sets up better-auth on the content database and runs its migrations. */
  auth?: { secret: string; baseUrl: string; rateLimit?: boolean }
  /**
   * `'apply'` (the default) applies the site's shipped content at boot. `'none'` leaves content alone: a host
   * worker passes it, since only activating a release writes content there.
   */
  content?: 'apply' | 'none'
  /** A loaded release's shipped files, by source as written in the site. */
  shippedFiles?: ReadonlyMap<string, string>
}

export interface BootResult {
  core: Core
  db: Kysely<Database>
  report: CheckReport
  backup: BackupInfo | null
  auth: AuthService | null
}

/**
 * Spec §5 steps 3–4 on an open database: system migrations, better-auth's
 * migrations when `auth` is given, ref repair, then shipped content
 * (`validateAll` checks shipped documents already applied too; `content:
 * 'none'` skips shipped content). Stored content is never rewritten: it's
 * read against the current schema. Problems go into the report; nothing here
 * throws for them.
 */
export async function upgradeDatabase(
  db: Kysely<Database>,
  core: Core,
  systemMigrations: string[],
  auth?: AuthService,
  opts: { validateAll?: boolean; content?: 'apply' | 'none' } = {},
): Promise<CheckReport> {
  await migrateSystem(db)
  if (auth) await auth.migrate()
  const report: CheckReport = {
    ok: true,
    systemMigrations,
    shipped: { created: [], replaced: [], skipped: [], deletedRefs: [], warnings: [] },
    problems: [],
    warnings: [],
  }
  await core.repairRefs()
  if (opts.content !== 'none') {
    try {
      report.shipped = await core.applyShippedContent(opts.validateAll !== undefined ? { validateAll: opts.validateAll } : {})
    } catch (e) {
      if (!(e instanceof InlayError) || e.code !== 'shipped_content') throw e
      report.ok = false
      report.problems.push({ code: 'shipped_content', message: e.message, ...(e.details.issues && { issues: e.details.issues }) })
      return report
    }
  }
  for (const { document: d, slug, path } of await core.shadowedEntries()) {
    report.warnings.push({
      code: 'slug_shadowed',
      message: t('report.slugShadowed', { title: d.title, locale: d.locale, slug, path }),
      document: { id: d.id, type: d.type, locale: d.locale, title: d.title },
    })
  }
  return report
}

/** True for a database that has never been set up: no content tables yet. */
export async function isFresh(db: Kysely<Database>): Promise<boolean> {
  const tables = await db.introspection.getTables()
  return !tables.some((table) => table.name === 'documents')
}

async function mtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** When the database file or its -wal last changed. Must run before the database is opened, since opening creates a fresh -wal. */
async function lastChanged(db: string): Promise<number | null> {
  const times = [await mtime(db), await mtime(`${db}-wal`)].filter((t) => t !== null)
  return times.length > 0 ? Math.max(...times) : null
}

/** When the newest pre-migration backup was written, or null if there is none. */
async function lastPreMigrationBackup(backups: string): Promise<number | null> {
  let names: string[]
  try {
    names = await readdir(backups)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  let newest: number | null = null
  for (const name of names.filter((n) => n.endsWith('-pre-migration.tar.gz'))) {
    const time = await mtime(join(backups, name))
    if (time !== null && (newest === null || time > newest)) newest = time
  }
  return newest
}

/** True if a pre-migration backup was written after the database last changed. */
async function backedUpSince(backups: string, changed: number | null): Promise<boolean> {
  if (changed === null) return false
  const backup = await lastPreMigrationBackup(backups)
  return backup !== null && backup > changed
}

/**
 * Opens the database and brings it up to date with the site code (spec §5
 * steps 1–4): a pre-migration backup if a migration is about to run, system
 * migrations, better-auth's migrations (with `opts.auth`) and shipped content.
 * Throws `check_failed` with every problem if the database can't be brought
 * up to date. The caller owns the returned `db` and must close it.
 */
export async function bootInlay(opts: BootOptions & { auth: NonNullable<BootOptions['auth']> }): Promise<BootResult & { auth: AuthService }>;
export async function bootInlay(opts: BootOptions): Promise<BootResult>;
export async function bootInlay(opts: BootOptions): Promise<BootResult> {
  const changed = await lastChanged(opts.db)
  const db = openDatabase(opts.db)
  try {
    const core = createCore({
      site: opts.site,
      db,
      ...(opts.media !== undefined && { media: opts.media }),
      backups: opts.backups,
      ...(opts.uploads && { uploads: opts.uploads }),
      ...(opts.now && { now: opts.now }),
      ...(opts.shippedFiles && { shippedFiles: opts.shippedFiles }),
    })
    const auth = opts.auth ? createAuthService({ db, ...opts.auth }) : null
    const systemMigrations = await pendingSystemMigrations(db)

    let backup: BackupInfo | null = null
    // A boot that keeps failing would otherwise add a full backup on every retry.
    if (
      !(await isFresh(db)) &&
      (systemMigrations.length > 0 || (await auth?.migrationsPending())) &&
      !(await backedUpSince(opts.backups, changed))
    ) {
      backup = await createBackup({
        db,
        backups: opts.backups,
        ...(opts.media !== undefined && { media: opts.media }),
        reason: 'pre-migration',
        ctx: systemCtx('system'),
        ...(opts.now && { now: opts.now }),
      })
    }

    const report = await upgradeDatabase(db, core, systemMigrations, auth ?? undefined, {
      ...(opts.content && { content: opts.content }),
    })
    if (report.problems.length > 0) {
      const list = formatReport(report).join('\n')
      throw new InlayError('check_failed', 'error.checkFailed', { count: report.problems.length, list }, { problems: report.problems })
    }
    return { core, db, report, backup, auth }
  } catch (e) {
    await db.destroy()
    throw e
  }
}
