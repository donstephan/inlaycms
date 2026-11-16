import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import { createBackup, type BackupInfo } from '../backup/backup.js'
import type { Database } from '../db/schema.js'
import { InlayError } from '../errors.js'
import { withMediaLock } from '../media/library.js'
import type { MediaStore } from '../media/store.js'
import type { SiteDefinition } from '../registry/define.js'
import { formatReport } from '../report.js'
import { readSiteLock, type SiteLockRow } from '../site-lock/site-lock.js'
import type { Ctx } from '../types.js'
import { readExport, type ExportBundle } from './read.js'
import { siteLockEffects, type ImportLocaleReport, type ImportReport, type ImportTypeReport } from './report.js'
import { replaceContent, type ReplaceCounts } from './replace.js'
import { stageBundle, type Exclusions, type Staged } from './stage.js'

/**
 * Removes the files in `ids` that no live `media` row uses, checking each row under the file's lock.
 * Returns the ids it removed. A failure on one file is ignored.
 */
export async function removeUnusedMedia(db: Kysely<Database>, store: MediaStore, ids: readonly string[]): Promise<string[]> {
  const removed: string[] = []
  for (const id of ids) {
    await withMediaLock(store, id, async () => {
      if (await db.selectFrom('media').select('id').where('id', '=', id).executeTakeFirst()) return
      await store.remove(id)
      removed.push(id)
    }).catch(() => {})
  }
  return removed
}

/** A dry run's report, and the damaged media files an import leaves out. */
export interface ImportPlan {
  report: ImportReport
  exclude: Exclusions
}

/** Ordered names with no repeats. */
const unique = (...lists: string[][]): string[] => [...new Set(lists.flat())]

/** Titles of the shipped documents the import would create or replace. */
async function shippedTitles(stage: Staged): Promise<string[]> {
  const titles: string[] = []
  for (const item of [...stage.report.shipped.created, ...stage.report.shipped.replaced]) {
    const doc = item.documentId === null ? null : await stage.core.getDocument(item.documentId)
    if (doc) titles.push(doc.title)
  }
  return titles
}

/** How many documents of each type would have a gap once imported. */
async function gapCounts(stage: Staged): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  for (const gap of await stage.core.listGaps()) counts.set(gap.document.type, (counts.get(gap.document.type) ?? 0) + 1)
  return counts
}

/**
 * Stages `bundle` against `site`, leaving out damaged media files, and reports
 * per type and locale what restoring it would do. Types and locales the site
 * doesn't have are kept, hidden. Writes only to a scratch database in `bundle.dir`.
 */
export async function planImport(site: SiteDefinition, bundle: ExportBundle, now?: () => Date, current?: SiteLockRow): Promise<ImportPlan> {
  const { manifest } = bundle
  const exclude: Exclusions = { media: new Set(bundle.damaged.map((m) => m.id)) }
  const stage = await stageBundle(site, bundle, exclude, now)
  try {
    const { registry } = stage.core
    const gaps = await gapCounts(stage)

    const typeNames = unique(manifest.types.map((t) => t.name), bundle.documents.map((d) => d.type))
    const localeNames = unique(manifest.locales, bundle.documents.map((d) => d.locale))
    const types = typeNames.map((name): ImportTypeReport => {
      const known = registry.types.get(name)
      const label = known?.label ?? manifest.types.find((t) => t.name === name)?.label ?? name
      const documents = bundle.documents.filter((d) => d.type === name).length
      return {
        type: name,
        current: known ? name : null,
        label,
        documents,
        status: known ? 'compatible' : 'hidden',
        gaps: gaps.get(name) ?? 0,
      }
    })
    const locales = localeNames.map((locale): ImportLocaleReport => {
      const documents = bundle.documents.filter((d) => d.locale === locale).length
      return { locale, documents, status: registry.locales.includes(locale) ? 'compatible' : 'hidden' }
    })

    const report: ImportReport = {
      ok: stage.report.ok,
      exportedAt: manifest.exportedAt,
      inlayVersion: manifest.inlayVersion,
      types,
      locales,
      general: stage.report.problems,
      media: { files: bundle.media.length, damaged: bundle.damaged.map((m) => m.filename) },
      redirects: { count: bundle.redirects.length },
      shipped: await shippedTitles(stage),
      siteLock: manifest.siteLock
        ? {
            enabled: manifest.siteLock.enabled,
            hasPassword: manifest.siteLock.passwordHash !== null,
            effects: current ? siteLockEffects(manifest.siteLock, current) : null,
          }
        : null,
    }
    return { report, exclude }
  } finally {
    await stage.close()
  }
}

/** Reads the export at `archive` and reports what restoring it would do. Changes nothing. */
export async function dryRunImport(site: SiteDefinition, archive: string, now?: () => Date, current?: SiteLockRow): Promise<ImportReport> {
  const bundle = await readExport(archive)
  try {
    return (await planImport(site, bundle, now, current)).report
  } finally {
    await bundle.close()
  }
}

export interface ImportResult {
  report: ImportReport
  backup: BackupInfo
  imported: ReplaceCounts
  /** Ids of the damaged media files left out. */
  skipped: { media: string[] }
}

export interface ImportOptions {
  site: SiteDefinition
  db: Kysely<Database>
  backups: string
  /** The live media store, or null when media isn't set up. */
  media: MediaStore | null
  archive: string
  ctx: Ctx
  now?: () => Date
}

/** The error for an import the site can't be brought up to date on top of, as boot gives it. */
function refused(report: ImportReport): InlayError {
  const problems = report.general
  const list = formatReport({ ok: false, systemMigrations: [], shipped: { created: [], replaced: [], skipped: [], deletedRefs: [], warnings: [] }, problems, warnings: [] }).join('\n')
  return new InlayError('check_failed', 'error.checkFailed', { count: problems.length, list }, { problems, importReport: report })
}

/**
 * Replaces the live content with the export at `archive`, leaving out damaged
 * media files. Dry-runs it first and refuses when the site can't be brought up
 * to date on top of it. Takes a `pre-import` backup before changing anything.
 */
export async function importContent(opts: ImportOptions): Promise<ImportResult> {
  const bundle = await readExport(opts.archive)
  let stage: Staged | null = null
  try {
    const { report, exclude } = await planImport(opts.site, bundle, opts.now, await readSiteLock(opts.db))
    if (!report.ok) throw refused(report)
    stage = await stageBundle(opts.site, bundle, exclude, opts.now)
    if (!stage.report.ok) throw refused({ ...report, ok: false, general: stage.report.problems })
    const staged = (await stage.db.selectFrom('media').select('id').execute()).map((m) => m.id)
    if (staged.length > 0 && !opts.media) throw new InlayError('invalid_operation', 'error.mediaNotConfigured')

    const backup = await createBackup({
      db: opts.db,
      backups: opts.backups,
      ...(opts.media && { media: opts.media.dir }),
      reason: 'pre-import',
      ctx: opts.ctx,
      ...(opts.now && { now: opts.now }),
    })
    const store = opts.media
    const added: string[] = []
    let replaced: Awaited<ReturnType<typeof replaceContent>>
    try {
      if (store) {
        for (const id of staged) {
          await withMediaLock(store, id, async () => {
            if (await store.has(id)) return
            await store.put(id, await readFile(join(bundle.dir, 'media', id)))
            added.push(id)
          })
        }
      }
      replaced = await replaceContent(opts.db, stage.db, bundle.manifest.siteLock)
    } catch (e) {
      if (store) await removeUnusedMedia(opts.db, store, added)
      throw e
    }
    // The content is replaced: from here a failure only leaves a stray file, so the import still succeeds.
    const { removedMedia, ...imported } = replaced
    if (store) await removeUnusedMedia(opts.db, store, removedMedia)

    return {
      report,
      backup,
      imported,
      skipped: { media: [...exclude.media] },
    }
  } finally {
    await stage?.close().catch(() => {})
    await bundle.close().catch(() => {})
  }
}
