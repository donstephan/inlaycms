import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import * as tar from 'tar'
import { snapshotDatabase } from '../backup/backup.js'
import { openDatabase } from '../db/connection.js'
import type { Database } from '../db/schema.js'
import { InlayError } from '../errors.js'
import { fileMediaStore } from '../media/store.js'
import { t } from '../messages/index.js'
import { readIntegrationRows, type IntegrationRow } from '../integrations/integrations.js'
import { readSiteLock, type SiteLockRow } from '../site-lock/site-lock.js'
import { targetOf } from '../redirects/rule.js'
import type { Registry } from '../registry/registry.js'
import type { DocumentData, RevisionSource } from '../types.js'
import { inlayVersion } from '../version.js'
import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  type ContentRecord,
  type MediaDeletionRecord,
  type MediaIndex,
  type MediaRecord,
  type Manifest,
  type PublishEventRecord,
  type RedirectRecord,
} from './format.js'
import { storedTypeSchema } from './schema.js'

export interface ExportSummary {
  path: string
  size: number
  counts: Manifest['counts']
}

export interface ExportOptions {
  db: Kysely<Database>
  registry: Registry
  media: string | null
  target: string
  now: () => Date
}

const lines = (records: unknown[]): string => records.map((r) => `${JSON.stringify(r)}\n`).join('')

export async function exportContent(opts: ExportOptions): Promise<ExportSummary> {
  const { registry } = opts
  const exportedAt = opts.now()
  const staging = await mkdtemp(join(tmpdir(), 'inlay-export-'))
  const partial = `${opts.target}.tmp-${randomUUID()}`
  try {
    await snapshotDatabase(opts.db, join(staging, 'snapshot.db'))
    const snap = openDatabase(join(staging, 'snapshot.db'), { readonly: true })
    let content: ContentRecord[]
    let redirects: RedirectRecord[]
    let mediaRows: MediaRecord[]
    let deletions: MediaDeletionRecord[]
    let siteLock: SiteLockRow
    let integrations: IntegrationRow[]
    try {
      content = await readContent(snap)
      redirects = await readRedirects(snap)
      mediaRows = await readMedia(snap)
      deletions = await readDeletions(snap)
      siteLock = await readSiteLock(snap)
      integrations = await readIntegrationRows(snap)
    } finally {
      await snap.destroy()
    }

    const store = opts.media === null ? null : fileMediaStore(opts.media)
    const files: MediaRecord[] = []
    await mkdir(join(staging, 'media'))
    for (const row of mediaRows) {
      try {
        if (store === null) throw new Error('no media store')
        await copyFile(store.path(row.id), join(staging, 'media', row.id))
        files.push(row)
      } catch {
        await rm(join(staging, 'media', row.id), { force: true })
        deletions.push({
          mediaId: row.id,
          filename: row.filename,
          deletedAt: exportedAt.toISOString(),
          deletedById: null,
          deletedBy: t('label.system'),
        })
      }
    }
    const index: MediaIndex = { files, deletions }

    const counts: Manifest['counts'] = {
      documents: content.filter((r) => r.record === 'document').length,
      revisions: content.filter((r) => r.record === 'revision').length,
      publishEvents: content.filter((r) => r.record === 'publishEvent').length,
      media: files.length,
      redirects: redirects.length,
    }
    const manifest: Manifest = {
      format: EXPORT_FORMAT,
      formatVersion: EXPORT_FORMAT_VERSION,
      inlayVersion: inlayVersion(),
      exportedAt: exportedAt.toISOString(),
      locales: [...registry.locales],
      defaultLocale: registry.defaultLocale,
      types: [...registry.types.values()].map((type) => ({
        name: type.name,
        kind: type.kind,
        label: type.label,
        template: type.template.name,
        schema: storedTypeSchema(registry, type.name),
      })),
      counts,
      siteLock,
      integrations,
    }

    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2))
    await writeFile(join(staging, 'content.ndjson'), lines(content))
    await writeFile(join(staging, 'redirects.json'), JSON.stringify(redirects, null, 2))
    await writeFile(join(staging, 'media.json'), JSON.stringify(index, null, 2))

    const entries = ['manifest.json', 'content.ndjson', 'redirects.json', 'media.json', ...files.map((f) => `media/${f.id}`)]
    await tar.c({ gzip: true, file: partial, cwd: staging }, entries)
    await rename(partial, opts.target)
    return { path: opts.target, size: (await stat(opts.target)).size, counts }
  } catch (e) {
    await rm(partial, { force: true })
    if (e instanceof InlayError) throw e
    throw new InlayError('invalid_operation', 'error.exportFailed', { error: e instanceof Error ? e.message : String(e) })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function readContent(db: Kysely<Database>): Promise<ContentRecord[]> {
  const docs = await db.selectFrom('documents').selectAll().orderBy('created_at').orderBy('id').execute()
  const revs = await db.selectFrom('revisions').selectAll().orderBy('id').execute()
  const events = await db.selectFrom('publish_events').selectAll().orderBy('id').execute()
  return [
    ...docs.map((d): ContentRecord => ({
      record: 'document',
      id: d.id,
      kind: d.kind,
      type: d.type,
      groupId: d.group_id,
      locale: d.locale,
      headRevision: d.head_rev,
      publishedRevision: d.published_rev,
      deletedAt: d.deleted_at,
      createdAt: d.created_at,
      key: d.key,
      edition: d.edition,
      firstPublishedAt: d.first_published_at,
    })),
    ...revs.map((r): ContentRecord => ({
      record: 'revision',
      id: r.id,
      documentId: r.document_id,
      data: JSON.parse(r.data) as DocumentData,
      authorId: r.author_id,
      authorName: r.author_name,
      source: r.source as RevisionSource,
      message: r.message,
      createdAt: r.created_at,
      releaseId: r.release_id,
    })),
    ...events.map((e): PublishEventRecord => ({
      record: 'publishEvent',
      id: e.id,
      at: e.at,
      userId: e.user_id,
      userName: e.user_name,
      source: e.source as RevisionSource,
      message: e.message,
      items: JSON.parse(e.items) as PublishEventRecord['items'],
    })),
  ]
}

async function readRedirects(db: Kysely<Database>): Promise<RedirectRecord[]> {
  const rows = await db.selectFrom('redirects').selectAll().orderBy('id').execute()
  return rows.map((r) => ({
    id: r.id,
    from: r.from_path,
    to: r.to_group_id !== null ? { group: r.to_group_id } : targetOf(r.to_path ?? ''),
    status: r.status,
    source: r.source,
    note: r.note,
    createdById: r.created_by_id,
    createdBy: r.created_by_name,
    createdAt: r.created_at,
  }))
}

async function readMedia(db: Kysely<Database>): Promise<MediaRecord[]> {
  const rows = await db.selectFrom('media').selectAll().orderBy('created_at').orderBy('id').execute()
  return rows.map((m) => ({
    id: m.id,
    filename: m.filename,
    mime: m.mime,
    size: m.size,
    width: m.width,
    height: m.height,
    defaultAlt: m.default_alt,
    createdById: m.created_by_id,
    createdBy: m.created_by_name,
    createdAt: m.created_at,
  }))
}

async function readDeletions(db: Kysely<Database>): Promise<MediaDeletionRecord[]> {
  const rows = await db.selectFrom('media_deletions').selectAll().orderBy('id').execute()
  return rows.map((d) => ({
    mediaId: d.media_id,
    filename: d.filename,
    deletedAt: d.deleted_at,
    deletedById: d.deleted_by_id,
    deletedBy: d.deleted_by_name,
  }))
}
