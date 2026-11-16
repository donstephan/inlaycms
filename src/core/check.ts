import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotDatabase } from './backup/backup.js'
import { upgradeDatabase } from './boot.js'
import { createCore } from './core.js'
import { openDatabase } from './db/connection.js'
import { pendingSystemMigrations } from './db/migrate.js'
import { InlayError } from './errors.js'
import type { SiteDefinition } from './registry/define.js'
import { bundleSite } from './release/bundle.js'
import type { CheckProblem, CheckReport } from './report.js'

/**
 * Runs the boot pipeline (system migrations, shipped content) on a throwaway
 * snapshot of the database at `opts.db`, and reports what would happen.
 * Every shipped document is checked, including those at editions already
 * applied, which boot leaves alone; a shipped slug or path that is already taken is a problem here, though
 * activation resolves it with a warning. Shipped-content files are imported into a throwaway media
 * directory. Never writes to the given file. Returns `ok: false` with
 * the problems instead of throwing.
 */
export async function checkDatabase(opts: { site: SiteDefinition; db: string; now?: () => Date }): Promise<CheckReport> {
  if (!existsSync(opts.db)) throw new InlayError('not_found', 'error.noDatabase', { path: opts.db })
  const dir = await mkdtemp(join(tmpdir(), 'inlay-check-'))
  try {
    const snapshot = join(dir, 'inlay.db')
    if (existsSync(`${opts.db}-wal`)) {
      const source = openDatabase(opts.db, { readonly: true })
      try {
        await snapshotDatabase(source, snapshot)
      } finally {
        await source.destroy()
      }
    } else {
      // With no -wal file the main file holds every committed page, so a byte
      // copy is the snapshot. Opening it with SQLite, even readonly, would
      // create -wal/-shm beside it (and fail in a read-only directory); the
      // bundled SQLite is built without URI support, so `?immutable=1` isn't
      // available.
      await copyFile(opts.db, snapshot)
    }

    const db = openDatabase(snapshot)
    try {
      const core = createCore({ site: opts.site, db, media: join(dir, 'media'), ...(opts.now && { now: opts.now }) })
      const report = await upgradeDatabase(db, core, await pendingSystemMigrations(db), undefined, { validateAll: true })
      // Activation resolves a slug or path that is taken and goes ahead; a check asks for it to be fixed.
      const warnings = report.shipped.warnings ?? []
      if (warnings.length === 0) return report
      for (const w of warnings) report.problems.push({ code: 'shipped_content', message: w.message })
      return { ...report, ok: false, shipped: { ...report.shipped, warnings: [] } }
    } finally {
      await db.destroy()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The report of a check that looked at no database. */
export function emptyCheckReport(): CheckReport {
  return {
    ok: true,
    systemMigrations: [],
    shipped: { created: [], replaced: [], skipped: [], deletedRefs: [], warnings: [] },
    problems: [],
    warnings: [],
  }
}

/**
 * Checks `site` against a fresh, empty database, so its shipped content is
 * validated when there is no database to check. Reports only problems and
 * warnings: what a fresh database would get isn't news.
 */
export async function checkWithoutDatabase(opts: { site: SiteDefinition; now?: () => Date }): Promise<CheckReport> {
  const dir = await mkdtemp(join(tmpdir(), 'inlay-check-empty-'))
  try {
    const db = join(dir, 'empty.db')
    await writeFile(db, '')
    const report = await checkDatabase({ ...opts, db })
    return { ...emptyCheckReport(), ok: report.ok, problems: report.problems, warnings: report.warnings }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Bundles the site at `configFile` the way `inlaycms pack` does, into a throwaway file, and reports an import a
 * release can't hold, or code it refuses, as a problem. Other bundling failures throw.
 */
export async function checkBundle(configFile: string): Promise<CheckProblem[]> {
  const dir = await mkdtemp(join(tmpdir(), 'inlay-check-bundle-'))
  try {
    await bundleSite(configFile, join(dir, 'site.js'))
    return []
  } catch (e) {
    if (e instanceof InlayError && e.messageId === 'error.packImport') return [{ code: 'release_import', message: e.message }]
    if (e instanceof InlayError && e.messageId === 'error.packForbidden') return [{ code: 'release_forbidden', message: e.message }]
    throw e
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
