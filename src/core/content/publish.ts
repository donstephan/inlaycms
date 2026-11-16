import type { Selectable } from 'kysely'
import { assertCan } from '../auth/roles.js'
import type { DocumentsTable } from '../db/schema.js'
import { InlayError } from '../errors.js'
import { autoRedirect } from '../redirects/redirects.js'
import type { ContentIssue, CoreDeps, Ctx, DocumentSummary } from '../types.js'
import { t } from '../messages/index.js'
import { runTransaction } from './dry-run.js'
import { diffRevisions } from './history.js'
import { formatDiff } from './diff.js'
import { documentTitle, parseData, summaryQuery, toSummary, whereVisible } from './read.js'
import { documentRefPaths, mediaRefPaths, syncRefs } from './refs.js'
import { docLabels } from './schema.js'
import { contentIssue, validateContent } from './validate.js'

export interface PublishResult {
  eventId: number | null
  items: Array<{ documentId: string; revisionId: number | null; action: 'publish' | 'unpublish' }>
}

type Failure = { documentId: string; title: string; issues: ContentIssue[] }

export async function recordEvent(
  deps: CoreDeps,
  ctx: Ctx,
  message: string | null,
  items: PublishResult['items'],
): Promise<number | null> {
  if (items.length === 0) return null
  const row = await deps.db
    .insertInto('publish_events')
    .values({
      at: deps.now().toISOString(),
      user_id: ctx.actor.id,
      user_name: ctx.actor.name,
      source: ctx.source,
      message,
      items: JSON.stringify(items),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

export async function publish(
  deps: CoreDeps,
  documentIds: string[],
  ctx: Ctx,
  opts: { message?: string; expect?: Record<string, number>; dryRun?: boolean } = {},
): Promise<PublishResult> {
  assertCan(ctx, 'content.publish')
  const ids = [...new Set(documentIds)]
  return runTransaction(deps, async (tx) => {
    const trx = tx.db
    const failures: Failure[] = []
    const items: PublishResult['items'] = []
    const docs = new Map<string, Selectable<DocumentsTable>>()
    for (const id of ids) {
      const doc = await trx
        .selectFrom('documents')
        .selectAll()
        .where('id', '=', id)
        .$call(whereVisible(deps.registry))
        .executeTakeFirst()
      if (!doc || doc.head_rev === null) {
        failures.push({
          documentId: id,
          title: id,
          issues: [contentIssue([], [], 'not_found', 'issue.documentMissing')],
        })
        continue
      }
      const rev = await trx
        .selectFrom('revisions')
        .select('data')
        .where('id', '=', doc.head_rev)
        .executeTakeFirstOrThrow()
      const data = parseData(tx, doc.type, rev.data)
      const title = documentTitle(tx, doc, data, doc.head_slug)
      if (doc.deleted_at !== null) {
        failures.push({
          documentId: id,
          title,
          issues: [contentIssue([], [], 'invalid', 'issue.documentDeleted')],
        })
        continue
      }
      const expected = opts.expect?.[id]
      if (expected !== undefined && doc.head_rev !== expected) {
        throw new InlayError('conflict', 'error.publishChanged', { title })
      }
      if (doc.published_rev === doc.head_rev) continue

      const issues: ContentIssue[] = []
      const validated = validateContent(deps.registry, doc.type, data, 'strict')
      if (!validated.ok) issues.push(...validated.issues)
      const found = documentRefPaths(tx, doc.type, data)
      if (found.length > 0) {
        const targets = await trx
          .selectFrom('documents')
          .select(['group_id', 'deleted_at'])
          .where('group_id', 'in', [...new Set(found.map((r) => r.ref.id))])
          .$call(whereVisible(deps.registry))
          .execute()
        const visible = new Set(targets.map((d) => d.group_id))
        const gone = new Set(targets.filter((d) => d.deleted_at !== null).map((d) => d.group_id))
        for (const ref of found) {
          const missing = !visible.has(ref.ref.id)
          if (!missing && !gone.has(ref.ref.id)) continue
          const labels = docLabels(deps.registry, doc.type, ref.path) ?? ref.path.map(String)
          issues.push(
            missing
              ? contentIssue(ref.path, labels, 'not_found', 'issue.notFound')
              : contentIssue(ref.path, labels, 'deleted_reference', 'issue.deletedReference'),
          )
        }
      }
      const mediaFound = mediaRefPaths(tx, doc.type, data)
      if (mediaFound.length > 0) {
        const mediaIds = [...new Set(mediaFound.map((r) => r.ref.id))]
        const present = new Set(
          (await trx.selectFrom('media').select('id').where('id', 'in', mediaIds).execute()).map((m) => m.id),
        )
        const dels = await trx
          .selectFrom('media_deletions')
          .select(['media_id', 'filename'])
          .where('media_id', 'in', mediaIds)
          .orderBy('id', 'asc')
          .execute()
        const filenames = new Map(dels.map((d) => [d.media_id, d.filename]))
        for (const ref of mediaFound) {
          if (present.has(ref.ref.id)) continue
          const labels = docLabels(deps.registry, doc.type, ref.path) ?? ref.path.map(String)
          const filename = filenames.get(ref.ref.id)
          issues.push(
            filename !== undefined
              ? contentIssue(ref.path, labels, 'missing_media', 'issue.missingMedia', { filename })
              : contentIssue(ref.path, labels, 'missing_media', 'issue.mediaNotFound'),
          )
        }
      }
      if (issues.length > 0) {
        failures.push({ documentId: id, title, issues })
        continue
      }
      items.push({ documentId: id, revisionId: doc.head_rev, action: 'publish' })
      docs.set(id, doc)
    }
    if (failures.length > 0) {
      throw new InlayError('validation', 'error.publishFailed', { count: failures.length }, { documents: failures })
    }
    if (opts.dryRun) return { eventId: null, items }
    for (const item of items) {
      await autoRedirect(tx, ctx, docs.get(item.documentId)!)
      await trx
        .updateTable('documents')
        .set((eb) => ({
          published_rev: eb.ref('head_rev'),
          published_slug: eb.ref('head_slug'),
          published_path: eb.ref('head_path'),
        }))
        .where('id', '=', item.documentId)
        .execute()
      await syncRefs(tx, item.documentId)
    }
    return { eventId: await recordEvent(tx, ctx, opts.message ?? null, items), items }
  }, opts)
}

export async function unpublish(
  deps: CoreDeps,
  documentIds: string[],
  ctx: Ctx,
  opts: { dryRun?: boolean } = {},
): Promise<PublishResult> {
  assertCan(ctx, 'content.publish')
  const ids = [...new Set(documentIds)]
  return runTransaction(deps, async (tx) => {
    const trx = tx.db
    const items: PublishResult['items'] = []
    for (const id of ids) {
      const doc = await trx
        .selectFrom('documents')
        .selectAll()
        .where('id', '=', id)
        .$call(whereVisible(deps.registry))
        .executeTakeFirst()
      if (!doc) throw new InlayError('not_found', 'error.notFound', { name: id })
      if (doc.kind !== 'entry') throw new InlayError('invalid_operation', 'error.unpublishNotAllowed')
      if (doc.published_rev === null) continue
      items.push({ documentId: id, revisionId: null, action: 'unpublish' })
    }
    if (opts.dryRun) return { eventId: null, items }
    for (const item of items) {
      await trx
        .updateTable('documents')
        .set({ published_rev: null, published_slug: null, published_path: null })
        .where('id', '=', item.documentId)
        .execute()
      await syncRefs(tx, item.documentId)
    }
    return { eventId: await recordEvent(tx, ctx, null, items), items }
  }, opts)
}

/** Non-deleted documents never published or changed since, newest head first. */
export async function listPendingChanges(deps: CoreDeps): Promise<DocumentSummary[]> {
  const rows = await summaryQuery(deps)
    .where('documents.deleted_at', 'is', null)
    .where((eb) =>
      eb.or([eb('documents.published_rev', 'is', null), eb('documents.head_rev', '!=', eb.ref('documents.published_rev'))]),
    )
    .orderBy('documents.head_rev', 'desc')
    .execute()
  return rows.map((row) => toSummary(deps, row))
}

const MAX_CHANGE_LINES = 12

/** What publishing each document would change, as readable lines (at most 12 each, plus a "more" line). */
export async function describeChanges(
  deps: CoreDeps,
  documentIds: string[],
): Promise<Array<{ document: DocumentSummary; isNew: boolean; lines: string[] }>> {
  const ids = [...new Set(documentIds)]
  const rows = ids.length === 0 ? [] : await summaryQuery(deps).where('documents.id', 'in', ids).execute()
  const byId = new Map(rows.map((row) => [row.id, row]))
  const out: Array<{ document: DocumentSummary; isNew: boolean; lines: string[] }> = []
  for (const id of ids) {
    const row = byId.get(id)
    if (!row) throw new InlayError('not_found', 'error.notFound', { name: id })
    const document = toSummary(deps, row)
    const isNew = document.publishedRev === null
    const all =
      document.publishedRev === document.headRev
        ? []
        : formatDiff(await diffRevisions(deps, document.publishedRev, document.headRev))
    const lines = all.slice(0, MAX_CHANGE_LINES)
    if (all.length > MAX_CHANGE_LINES) lines.push(t('changes.more', { count: all.length - MAX_CHANGE_LINES }))
    out.push({ document, isNew, lines })
  }
  return out
}
