import type { Kysely } from 'kysely'
import { findSingleton, findTranslation, getDocument, listEntries } from './content/read.js'
import { findText, type FindTextResult } from './content/find-text.js'
import { findEntry, searchEntries } from './content/search.js'
import { recentActivity } from './content/activity.js'
import { withTransaction } from './content/dry-run.js'
import { describeChanges, listPendingChanges, publish, unpublish, type PublishResult } from './content/publish.js'
import {
  applyShippedContent,
  type ShippedItem,
  type ShippedReport,
} from './content/shipped.js'
import { patchDraft, type PatchOp } from './content/patch.js'
import { saveDraft, type SaveResult } from './content/save.js'
import { deleteEntry, restoreEntry } from './content/delete.js'
import { getRevision, diffRevisions, listRevisions, restoreRevision } from './content/history.js'
import { gapSummary, listGaps, type Gap, type GapFilter, type GapSummary } from './content/gaps.js'
import { hiddenContent, hiddenDocuments, type HiddenContent, type HiddenDocuments } from './content/hidden.js'
import { brokenReferences, findUsages } from './content/usages.js'
import { countEntries } from './content/stats.js'
import { createTranslation } from './content/translate.js'
import { repairRefs } from './content/refs.js'
import { shadowedEntries } from './content/slug.js'
import { createEntry } from './content/write.js'
import { runReleaseMigrations } from './content/release-migrations.js'
import { createBackup, listBackups, type BackupInfo, type BackupReason } from './backup/backup.js'
import { publishBackupDue, pruneBackups, scheduledBackupDue } from './backup/schedule.js'
import { exportContent, type ExportSummary } from './export/export.js'
import { dryRunImport, importContent, type ImportResult } from './export/import.js'
import type { ImportReport } from './export/report.js'
import { assertCan, systemCtx } from './auth/roles.js'
import { InlayError } from './errors.js'
import { basename } from 'node:path'
import type { Database } from './db/schema.js'
import { DEFAULT_MAX_BYTES, DEFAULT_UPLOAD_TYPES } from './media/detect.js'
import { addMedia, deleteMedia, getMedia, listMedia, lookupMedia, mediaFile, mediaStats, setMediaAlt } from './media/library.js'
import { codeImageVariant, mediaVariant, type VariantFormat } from './media/variants.js'
import { fileMediaStore } from './media/store.js'
import type { SiteDefinition } from './registry/define.js'
import type { ReleaseMigration } from './registry/migration.js'
import { buildRegistry, type Registry } from './registry/registry.js'
import { activeIntegrations, listIntegrations, saveIntegration, type ActiveIntegration, type IntegrationState } from './integrations/integrations.js'
import { checkSitePassword, readSiteLock, setSiteLock, setSitePassword, type SiteLockStatus } from './site-lock/site-lock.js'
import { codeRedirectLoops, createRedirect, deleteRedirect, importRedirects, listCodeRedirects, listRedirects } from './redirects/redirects.js'
import { groupIdsByKey, liveAlternates, liveDocuments, liveEntries, liveSingleton } from './site/live.js'
import { resolvePath } from './site/resolve.js'
import { sitemapEntries, type SitemapEntry } from './site/sitemap.js'
import type { Activity, ContentInput, CoreDeps, Ctx, DocumentData, DocumentSummary, DocumentView, ContentRef, Usage, DiffEntry, RevisionMeta, UploadLimits, MediaInfo, MediaStatus, LiveDocument, LiveState, RouteMatch, Redirect, RedirectInput, CodeRedirect } from './types.js'

export type { PatchOp, PublishResult, SaveResult, ShippedItem, ShippedReport }

export interface Core {
  registry: Registry
  /** A loaded release's images that `.md` files the site imports name, by source: what `/media/files/` serves. */
  readonly codeFiles?: ReadonlyMap<string, string>
  getDocument(id: string, opts?: { state?: 'head' | 'published' }): Promise<DocumentView | null>
  findSingleton(type: string, locale?: string): Promise<DocumentSummary | null>
  findTranslation(groupId: string, locale: string): Promise<DocumentSummary | null>
  listEntries(type: string, opts?: { locale?: string; includeDeleted?: boolean }): Promise<DocumentSummary[]>
  createEntry(
    type: string,
    input: ContentInput & { locale?: string; message?: string },
    ctx: Ctx,
  ): Promise<DocumentView>
  saveDraft(
    documentId: string,
    input: { baseRevisionId: number; data: DocumentData; message?: string },
    ctx: Ctx,
  ): Promise<SaveResult>
  patchDraft(
    documentId: string,
    input: { baseRevisionId: number; ops: PatchOp[]; message?: string },
    ctx: Ctx,
  ): Promise<SaveResult>
  findEntry(type: string, slug: string, locale?: string): Promise<DocumentSummary | null>
  searchEntries(
    type: string,
    query: string,
    opts?: { locale?: string; limit?: number },
  ): Promise<Array<DocumentSummary & { snippet: string }>>
  findText(
    text: string,
    opts?: { type?: string; locale?: string; limit?: number; offset?: number },
  ): Promise<FindTextResult>
  publish(
    documentIds: string[],
    ctx: Ctx,
    opts?: { message?: string; expect?: Record<string, number>; dryRun?: boolean },
  ): Promise<PublishResult>
  unpublish(documentIds: string[], ctx: Ctx, opts?: { dryRun?: boolean }): Promise<PublishResult>
  describeChanges(documentIds: string[]): Promise<Array<{ document: DocumentSummary; isNew: boolean; lines: string[] }>>
  listPendingChanges(): Promise<DocumentSummary[]>
  /** The latest edits and publishes, newest first (`limit` 20 by default, 1 to 100). */
  recentActivity(opts?: { limit?: number }): Promise<Activity[]>
  /**
   * Creates or replaces documents from the site's shipped content by edition (spec §6.3).
   * `validateAll` also checks shipped documents at editions already applied.
   */
  applyShippedContent(opts?: { dryRun?: boolean; validateAll?: boolean }): Promise<ShippedReport>
  /**
   * Runs the release's migration functions it hasn't run yet, in order, in one transaction (spec §8.3).
   * A throw rolls all of them back. Returns the names run.
   */
  runReleaseMigrations(releaseId: string, migrations: readonly ReleaseMigration[]): Promise<string[]>
  createTranslation(groupId: string, locale: string, ctx: Ctx): Promise<DocumentView>
  findUsages(target: ContentRef): Promise<Usage[]>
  /** Per collection: visible entries in the default language, and how many changed at or after `changedSince`. */
  countEntries(opts?: { changedSince?: string }): Promise<Record<string, { total: number; changed: number }>>
  mediaStats(): Promise<{ count: number; totalBytes: number; imagesWithoutAlt: number }>
  /** Documents that link to deleted content. */
  brokenReferences(): Promise<DocumentSummary[]>
  listGaps(opts?: GapFilter): Promise<Gap[]>
  gapSummary(): Promise<GapSummary[]>
  /** Content the site no longer shows, with counts: documents of removed types and locales, unknown slots and fields. */
  hiddenContent(): Promise<HiddenContent>
  /** Only the documents the site hides by type and by locale; cheap, as it reads no content. */
  hiddenDocuments(): Promise<HiddenDocuments>
  deleteEntry(groupId: string, ctx: Ctx): Promise<void>
  restoreEntry(groupId: string, ctx: Ctx): Promise<DocumentView[]>
  listRevisions(documentId: string): Promise<RevisionMeta[]>
  getRevision(revisionId: number): Promise<{ meta: RevisionMeta; documentId: string; data: DocumentData } | null>
  diffRevisions(fromRevisionId: number | null, toRevisionId: number): Promise<DiffEntry[]>
  restoreRevision(documentId: string, revisionId: number, ctx: Ctx, opts?: { message?: string }): Promise<SaveResult>
  addMedia(input: { data: Uint8Array; filename: string }, ctx: Ctx): Promise<{ media: MediaInfo; reused: boolean }>
  getMedia(id: string): Promise<MediaInfo | null>
  listMedia(opts?: { kind?: 'image' | 'file'; search?: string; limit?: number; offset?: number }): Promise<MediaInfo[]>
  setMediaAlt(id: string, alt: string | null, ctx: Ctx): Promise<MediaInfo>
  lookupMedia(ids: string[]): Promise<Map<string, MediaStatus>>
  deleteMedia(id: string, ctx: Ctx): Promise<void>
  mediaFile(id: string): Promise<{ path: string; mime: string; filename: string; size: number }>
  mediaVariant(id: string, opts: { width: number; format: VariantFormat }): Promise<{ path: string; mime: string }>
  /** A resized variant of an image site code names, cached under `code-<sha>`. */
  codeImageVariant(file: { sha: string; path: string }, opts: { width: number; format: VariantFormat }): Promise<{ path: string; mime: string }>
  /** Re-creates missing refs of visible documents; returns how many documents it synced. */
  repairRefs(): Promise<number>
  /** Entries whose slug gives them a page another path hides; editors can't save them until it changes. */
  shadowedEntries(): Promise<Array<{ document: DocumentSummary; slug: string; path: string }>>
  liveDocuments(groupIds: string[], locale: string, opts?: { state?: LiveState }): Promise<Map<string, LiveDocument>>
  /** The group id of each shipped-style document by `type/key` (a missing key means the type); deleted and unknown ones are left out. */
  groupIdsByKey(refs: Array<{ type: string; key: string | null }>): Promise<Map<string, string>>
  liveSingleton(type: string, locale: string, opts?: { state?: LiveState }): Promise<LiveDocument | null>
  liveEntries(collection: string, locale: string, opts?: { state?: LiveState }): Promise<LiveDocument[]>
  liveAlternates(
    groupId: string,
    opts?: { state?: LiveState },
  ): Promise<Array<{ locale: string; path: string; fallback: boolean }>>
  resolvePath(rawPath: string, opts?: { state?: LiveState }): Promise<RouteMatch>
  sitemapEntries(): Promise<SitemapEntry[]>
  siteLock(): Promise<SiteLockStatus>
  setSiteLock(enabled: boolean, ctx: Ctx): Promise<SiteLockStatus>
  setSitePassword(password: string, ctx: Ctx): Promise<SiteLockStatus>
  /** Every integration the site defines with its saved settings; owners only. */
  integrations(ctx: Ctx): Promise<IntegrationState[]>
  saveIntegration(name: string, input: { enabled: boolean; values: Record<string, unknown> }, ctx: Ctx): Promise<void>
  /** The integrations that are on and whose saved values pass; for rendering, no actor. */
  activeIntegrations(): Promise<ActiveIntegration[]>
  checkSitePassword(password: string): Promise<boolean>
  listRedirects(): Promise<Redirect[]>
  createRedirect(input: RedirectInput, ctx: Ctx): Promise<Redirect>
  deleteRedirect(id: number, ctx: Ctx): Promise<void>
  importRedirects(csv: string, ctx: Ctx): Promise<{ created: number; updated: number }>
  /** The site's code redirect rules, in definition order, each marked when an admin rule or a page answers first. */
  listCodeRedirects(): Promise<CodeRedirect[]>
  /** The `from` of each code rule that, with the stored rules, sends visitors round a loop with no stop. */
  codeRedirectLoops(): Promise<string[]>
  /** The backups on disk, newest first. Owners only. */
  listBackups(ctx: Ctx): Promise<BackupInfo[]>
  /** Makes a manual backup of the database and media. Owners only. */
  backup(ctx: Ctx): Promise<BackupInfo>
  /**
   * Makes a `scheduled` backup unless one was made in the last 24 hours; otherwise a `post-publish` backup if
   * something was published after the newest backup. Then prunes each kind to the newest `keep`. Null when neither is due.
   */
  scheduledBackup(keep: number): Promise<BackupInfo | null>
  /** The listed backup called `name`; `not_found` for anything else. Owners only. */
  backupFile(name: string, ctx: Ctx): Promise<BackupInfo>
  /** Writes an export archive of all content to `target`. Owners only. */
  exportContent(target: string, ctx: Ctx): Promise<ExportSummary>
  /** What restoring the export at `archive` would do, worked out on a scratch copy. Changes nothing. Owners only. */
  importDryRun(archive: string, ctx: Ctx): Promise<ImportReport>
  /**
   * Replaces all content with the export at `archive`, after a `pre-import` backup. Skips damaged
   * media files; refuses when the site can't be brought up to date on top of it. Owners only.
   */
  importContent(archive: string, ctx: Ctx): Promise<ImportResult>
  /** Calls `listener` after every committed change to the live site. Returns an unsubscribe function. */
  onLiveChange(listener: () => void): () => void
}

export interface CreateCoreOptions {
  site: SiteDefinition
  db: Kysely<Database>
  now?: () => Date
  media?: string
  backups?: string
  uploads?: UploadLimits
  /** A loaded release's shipped files, by source as written in the site. */
  shippedFiles?: ReadonlyMap<string, string>
  /** As `shippedFiles`, only the images `.md` files the site imports name. */
  codeFiles?: ReadonlyMap<string, string>
}

/** Builds the registry and binds the core functions. Does not migrate the database. */
export function createCore(opts: CreateCoreOptions): Core {
  const registry = buildRegistry(opts.site)
  const backupsDir = (): string => {
    if (opts.backups === undefined) throw new InlayError('config', 'config.backupsMissing')
    return opts.backups
  }
  const deps: CoreDeps = { db: opts.db, registry, now: opts.now ?? (() => new Date()),
    media: opts.media ? fileMediaStore(opts.media) : null,
    ...(opts.backups !== undefined && { backups: opts.backups }),
    uploads: {
      maxBytes: opts.uploads?.maxBytes ?? DEFAULT_MAX_BYTES,
      types: opts.uploads?.types ?? DEFAULT_UPLOAD_TYPES,
    },
    rules: { current: null },
    ...(opts.shippedFiles !== undefined && { shippedFiles: opts.shippedFiles }),
  }
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        const out: unknown = listener()
        if (out instanceof Promise) out.catch(() => {})
      } catch {
        // A listener's failure must not affect the change that already committed.
      }
    }
  }
  const live =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>, changed: (result: R, ...args: A) => boolean = () => true) =>
    async (...args: A): Promise<R> => {
      const result = await fn(...args)
      if (changed(result, ...args)) notify()
      return result
    }
  const published = (r: PublishResult) => r.items.length > 0

  return {
    registry,
    ...(opts.codeFiles !== undefined && { codeFiles: opts.codeFiles }),
    getDocument: (id, o) => getDocument(deps, id, o),
    findSingleton: (type, locale) => findSingleton(deps, type, locale),
    findTranslation: (groupId, locale) => findTranslation(deps, groupId, locale),
    listEntries: (type, o) => listEntries(deps, type, o),
    createEntry: (type, input, ctx) => createEntry(deps, type, input, ctx),
    saveDraft: (id, input, ctx) => saveDraft(deps, id, input, ctx),
    patchDraft: (id, input, ctx) => patchDraft(deps, id, input, ctx),
    findEntry: (type, slug, locale) => findEntry(deps, type, slug, locale),
    searchEntries: (type, query, o) => searchEntries(deps, type, query, o),
    findText: (text, o) => findText(deps, text, o),
    publish: live((ids, ctx, o) => publish(deps, ids, ctx, o), (r, ...args) => published(r) && !args[2]?.dryRun),
    unpublish: live((ids, ctx, o) => unpublish(deps, ids, ctx, o), (r, ...args) => published(r) && !args[2]?.dryRun),
    describeChanges: (ids) => describeChanges(deps, ids),
    listPendingChanges: () => listPendingChanges(deps),
    recentActivity: (o) => recentActivity(deps, o),
    applyShippedContent: live(
      (o) => applyShippedContent(deps, o),
      (r, o) => !o?.dryRun && (r.created.length > 0 || r.replaced.length > 0),
    ),
    runReleaseMigrations: live(
      (releaseId, migrations) =>
        withTransaction(deps, (tx) => runReleaseMigrations(tx, releaseId, migrations, systemCtx('release'))),
      (ran) => ran.length > 0,
    ),
    createTranslation: (groupId, locale, ctx) => createTranslation(deps, groupId, locale, ctx),
    findUsages: (target) => findUsages(deps, target),
    countEntries: (o) => countEntries(deps, o),
    mediaStats: () => mediaStats(deps),
    brokenReferences: () => brokenReferences(deps),
    listGaps: (opts) => listGaps(deps, opts),
    gapSummary: () => gapSummary(deps),
    hiddenContent: () => hiddenContent(deps),
    hiddenDocuments: () => hiddenDocuments(deps),
    deleteEntry: live((groupId, ctx) => deleteEntry(deps, groupId, ctx)),
    restoreEntry: (groupId, ctx) => restoreEntry(deps, groupId, ctx),
    listRevisions: (documentId) => listRevisions(deps, documentId),
    getRevision: (revisionId) => getRevision(deps, revisionId),
    diffRevisions: (from, to) => diffRevisions(deps, from, to),
    restoreRevision: (documentId, revisionId, ctx, o) => restoreRevision(deps, documentId, revisionId, ctx, o),
    addMedia: (input, ctx) => addMedia(deps, input, ctx),
    getMedia: (id) => getMedia(deps, id),
    listMedia: (o) => listMedia(deps, o),
    setMediaAlt: live((id, alt, ctx) => setMediaAlt(deps, id, alt, ctx)),
    lookupMedia: (ids) => lookupMedia(deps, ids),
    deleteMedia: live((id, ctx) => deleteMedia(deps, id, ctx)),
    mediaFile: (id) => mediaFile(deps, id),
    mediaVariant: (id, o) => mediaVariant(deps, id, o),
    codeImageVariant: (file, o) => codeImageVariant(deps, file, o),
    repairRefs: () => repairRefs(deps),
    shadowedEntries: () => shadowedEntries(deps),
    liveDocuments: (groupIds, locale, o) => liveDocuments(deps, groupIds, locale, o),
    groupIdsByKey: (refs) => groupIdsByKey(deps, refs),
    liveSingleton: (type, locale, o) => liveSingleton(deps, type, locale, o),
    liveEntries: (collection, locale, o) => liveEntries(deps, collection, locale, o),
    liveAlternates: (groupId, o) => liveAlternates(deps, groupId, o),
    resolvePath: (rawPath, o) => resolvePath(deps, rawPath, o),
    sitemapEntries: () => sitemapEntries(deps),
    listBackups: async (ctx) => {
      assertCan(ctx, 'backup.read')
      return listBackups(backupsDir())
    },
    backup: async (ctx) => {
      assertCan(ctx, 'backup.create')
      return createBackup({
        db: opts.db,
        backups: backupsDir(),
        ...(opts.media !== undefined && { media: opts.media }),
        reason: 'manual',
        ctx,
        now: deps.now,
      })
    },
    scheduledBackup: async (keep) => {
      const dir = backupsDir()
      const backups = await listBackups(dir)
      let reason: BackupReason
      if (scheduledBackupDue(backups, deps.now())) reason = 'scheduled'
      else if (publishBackupDue(backups, await lastPublishAt(opts.db))) reason = 'post-publish'
      else return null
      const info = await createBackup({
        db: opts.db,
        backups: dir,
        ...(opts.media !== undefined && { media: opts.media }),
        reason,
        ctx: systemCtx('system'),
        now: deps.now,
      })
      await pruneBackups(dir, keep)
      return info
    },
    backupFile: async (name, ctx) => {
      assertCan(ctx, 'backup.read')
      const found = (await listBackups(backupsDir())).find((b) => basename(b.path) === name)
      if (!found) throw new InlayError('not_found', 'error.backupNotFound')
      return found
    },
    exportContent: async (target, ctx) => {
      assertCan(ctx, 'content.export')
      return exportContent({ db: opts.db, registry, media: opts.media ?? null, target, now: deps.now })
    },
    importDryRun: async (archive, ctx) => {
      assertCan(ctx, 'content.import')
      return dryRunImport(opts.site, archive, deps.now, await readSiteLock(deps.db))
    },
    importContent: live(async (archive, ctx) => {
      assertCan(ctx, 'content.import')
      return importContent({
        site: opts.site,
        db: opts.db,
        backups: backupsDir(),
        media: deps.media,
        archive,
        ctx,
        now: deps.now,
      })
    }),
    siteLock: async () => {
      const row = await readSiteLock(deps.db)
      return { enabled: row.enabled, hasPassword: row.passwordHash !== null }
    },
    setSiteLock: live((enabled, ctx) => setSiteLock(deps, enabled, ctx)),
    setSitePassword: live((password, ctx) => setSitePassword(deps, password, ctx)),
    integrations: (ctx) => listIntegrations(deps, ctx),
    saveIntegration: live((name, input, ctx) => saveIntegration(deps, name, input, ctx)),
    activeIntegrations: () => activeIntegrations(deps),
    checkSitePassword: (password) => checkSitePassword(deps, password),
    listRedirects: () => listRedirects(deps),
    createRedirect: live((input, ctx) => createRedirect(deps, input, ctx)),
    deleteRedirect: live((id, ctx) => deleteRedirect(deps, id, ctx)),
    importRedirects: live((csv, ctx) => importRedirects(deps, csv, ctx)),
    listCodeRedirects: () => listCodeRedirects(deps),
    codeRedirectLoops: () => codeRedirectLoops(deps),
    onLiveChange: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const readOnlyError = () => new InlayError('read_only', 'error.previewReadOnly')
const refuse = async (): Promise<never> => {
  throw readOnlyError()
}

/** When the newest publish or unpublish happened; null if nothing ever was. */
async function lastPublishAt(db: Kysely<Database>): Promise<string | null> {
  const row = await db
    .selectFrom('publish_events')
    .select((eb) => eb.fn.max('at').as('at'))
    .executeTakeFirst()
  return row?.at ?? null
}

/**
 * `core` with every write refused with `read_only` (`error.previewReadOnly`), for a release preview: content,
 * media, redirects, the site lock, backups and imports. Reads, dry runs and exports still work. The database the
 * core was booted on may have been written before this (boot applies shipped content); nothing is after.
 */
export function readOnlyCore(core: Core): Core {
  return {
    ...core,
    createEntry: refuse,
    saveDraft: refuse,
    patchDraft: refuse,
    publish: (ids, ctx, o) => (o?.dryRun ? core.publish(ids, ctx, o) : refuse()),
    unpublish: (ids, ctx, o) => (o?.dryRun ? core.unpublish(ids, ctx, o) : refuse()),
    applyShippedContent: (o) => (o?.dryRun ? core.applyShippedContent(o) : refuse()),
    runReleaseMigrations: refuse,
    createTranslation: refuse,
    deleteEntry: refuse,
    restoreEntry: refuse,
    restoreRevision: refuse,
    addMedia: refuse,
    setMediaAlt: refuse,
    deleteMedia: refuse,
    repairRefs: refuse,
    setSiteLock: refuse,
    setSitePassword: refuse,
    saveIntegration: refuse,
    createRedirect: refuse,
    deleteRedirect: refuse,
    importRedirects: refuse,
    backup: refuse,
    scheduledBackup: refuse,
    importContent: refuse,
  }
}
