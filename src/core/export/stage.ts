import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import { upgradeDatabase } from '../boot.js'
import { syncRefs } from '../content/refs.js'
import { createCore, type Core } from '../core.js'
import { openDatabase } from '../db/connection.js'
import { migrateSystem } from '../db/migrate.js'
import type { Database } from '../db/schema.js'
import { InlayError } from '../errors.js'
import { t } from '../messages/index.js'
import type { SiteDefinition } from '../registry/define.js'
import type { CheckReport } from '../report.js'
import type { CoreDeps, DocumentData } from '../types.js'
import type { MediaDeletionRecord } from './format.js'
import type { ExportBundle } from './read.js'

/** What to leave out of a stage: `media` holds the ids of media files to record as deleted instead. */
export interface Exclusions {
  media: ReadonlySet<string>
}

export interface Staged {
  db: Kysely<Database>
  core: Core
  report: CheckReport
  /** Closes the scratch database and deletes its files. */
  close(): Promise<void>
}

export const noExclusions: Exclusions = { media: new Set() }

function stagePath(dir: string): string {
  for (let n = 1; ; n++) {
    const path = join(dir, `stage-${n}.db`)
    if (!existsSync(path)) return path
  }
}

const derived = (data: DocumentData | undefined) => ({
  slug: typeof data?.slug === 'string' ? data.slug : null,
  path: typeof data?.path === 'string' ? data.path : null,
})

/**
 * Loads `bundle` (minus `exclude`) into a new scratch database in `bundle.dir`
 * and brings it up to date with `site` the way boot does. Problems go into
 * `report`; when there are any, the scratch database still holds the content
 * as it was in the export. The caller must `close()` it.
 */
export async function stageBundle(
  site: SiteDefinition,
  bundle: ExportBundle,
  exclude: Exclusions,
  now?: () => Date,
): Promise<Staged> {
  const file = stagePath(bundle.dir)
  const db = openDatabase(file)
  const close = async () => {
    await db.destroy()
    for (const suffix of ['', '-wal', '-shm']) await rm(`${file}${suffix}`, { force: true })
  }
  try {
    await migrateSystem(db)
    const { manifest } = bundle
    const { documents, revisions, redirects } = bundle
    const dataOf = new Map(revisions.map((r) => [r.id, r.data]))

    await db.transaction().execute(async (trx) => {
      for (const d of documents) {
        const head = derived(d.headRevision === null ? undefined : dataOf.get(d.headRevision))
        const published = derived(d.publishedRevision === null ? undefined : dataOf.get(d.publishedRevision))
        await trx
          .insertInto('documents')
          .values({
            id: d.id,
            kind: d.kind,
            type: d.type,
            group_id: d.groupId,
            locale: d.locale,
            head_rev: null,
            published_rev: null,
            head_slug: head.slug,
            published_slug: d.publishedRevision === null ? null : published.slug,
            head_path: head.path,
            published_path: d.publishedRevision === null ? null : published.path,
            deleted_at: d.deletedAt,
            created_at: d.createdAt,
            key: d.key,
            edition: d.edition,
          })
          .execute()
      }
      for (const r of revisions) {
        await trx
          .insertInto('revisions')
          .values({
            id: r.id,
            document_id: r.documentId,
            data: JSON.stringify(r.data),
            author_id: r.authorId,
            author_name: r.authorName,
            source: r.source,
            message: r.message,
            created_at: r.createdAt,
            release_id: r.releaseId,
          })
          .execute()
      }
      for (const d of documents) {
        if (d.headRevision === null && d.publishedRevision === null) continue
        await trx
          .updateTable('documents')
          .set({ head_rev: d.headRevision, published_rev: d.publishedRevision })
          .where('id', '=', d.id)
          .execute()
      }
      for (const e of bundle.publishEvents) {
        await trx
          .insertInto('publish_events')
          .values({
            id: e.id,
            at: e.at,
            user_id: e.userId,
            user_name: e.userName,
            source: e.source,
            message: e.message,
            items: JSON.stringify(e.items),
          })
          .execute()
      }
      for (const r of redirects) {
        await trx
          .insertInto('redirects')
          .values({
            id: r.id,
            from_path: r.from,
            to_path: 'path' in r.to ? r.to.path : 'url' in r.to ? r.to.url : null,
            to_group_id: 'group' in r.to ? r.to.group : null,
            status: r.status,
            source: r.source,
            note: r.note,
            created_by_id: r.createdById,
            created_by_name: r.createdBy,
            created_at: r.createdAt,
          })
          .execute()
      }
      for (const m of bundle.media) {
        if (exclude.media.has(m.id)) continue
        await trx
          .insertInto('media')
          .values({
            id: m.id,
            filename: m.filename,
            mime: m.mime,
            size: m.size,
            width: m.width,
            height: m.height,
            default_alt: m.defaultAlt,
            created_by_id: m.createdById,
            created_by_name: m.createdBy,
            created_at: m.createdAt,
          })
          .execute()
      }
      const deletions: MediaDeletionRecord[] = [
        ...bundle.deletions,
        ...[...bundle.media, ...bundle.damaged]
          .filter((m) => exclude.media.has(m.id))
          .map((m) => ({
            mediaId: m.id,
            filename: m.filename,
            deletedAt: manifest.exportedAt,
            deletedById: null,
            deletedBy: t('label.system'),
          })),
      ]
      for (const d of deletions) {
        await trx
          .insertInto('media_deletions')
          .values({
            media_id: d.mediaId,
            filename: d.filename,
            deleted_at: d.deletedAt,
            deleted_by_id: d.deletedById,
            deleted_by_name: d.deletedBy,
          })
          .execute()
      }
    })

    const core = createCore({ site, db, media: join(bundle.dir, 'media'), ...(now && { now }) })
    const report = await upgradeDatabase(db, core, [])
    await db.transaction().execute(async (trx) => {
      const deps: CoreDeps = { db: trx, registry: core.registry, now: now ?? (() => new Date()), media: null, uploads: { maxBytes: 0, types: [] } }
      const types = [...core.registry.types.keys()]
      if (types.length === 0) return
      // Refs need the type's schema, so documents of types the code doesn't define get none.
      const known = await trx.selectFrom('documents').select('id').where('type', 'in', types).execute()
      for (const { id } of known) await syncRefs(deps, id)
    })
    return { db, core, report, close }
  } catch (e) {
    await close()
    if (isConstraintError(e)) throw new InlayError('validation', 'error.exportDamaged', { detail: t('export.conflict') })
    throw e
  }
}

/** Whether `e` is SQLite refusing a row, which for a checked export means records that clash. */
function isConstraintError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')
}
