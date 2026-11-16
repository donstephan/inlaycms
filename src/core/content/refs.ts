import type { FoundRef } from '../fields/walk.js'
import type { MessageId } from '../messages/index.js'
import type { ContentIssue, CoreDeps, DocumentData, DocumentKind, IssueCode } from '../types.js'
import { whereVisible } from './read.js'
import { readData } from './reader.js'
import { docLabels, documentRefs, documentRefsWithPaths } from './schema.js'
import { contentIssue } from './validate.js'
import { withTransaction } from './dry-run.js'

/** Document refs (from any field with `refs`) with their document paths. Media refs are not included. */
export function documentRefPaths(deps: CoreDeps, type: string, data: DocumentData): FoundRef[] {
  return documentRefsWithPaths(deps.registry, type, data).filter((r) => r.ref.kind === 'document')
}

/** Media refs (from any field with `refs`) with their document paths. */
export function mediaRefPaths(deps: CoreDeps, type: string, data: DocumentData): FoundRef[] {
  return documentRefsWithPaths(deps.registry, type, data).filter((r) => r.ref.kind === 'media')
}

/** A document ref's identity: where it sits and what it points at. */
export function refKey(ref: FoundRef): string {
  return JSON.stringify([ref.path, ref.ref.id])
}

/**
 * Problems with the document references in `data`, from any field: targets
 * that don't exist (`not_found`), `ref`s outside their target collection
 * (`wrong_collection`), links (link fields and rich text) to content
 * without a page (`not_routable`).
 * Hidden targets (removed types or locales) count as not found, except refs
 * whose `refKey` is in `kept`. Deleted targets are allowed here; publishing
 * blocks them.
 * Media refs: an id the library has never had is `not_found` (unless kept or
 * in `opts.media`, the id -> mime of files about to be imported); media in an
 * image field must be an image (`wrong_media_type`). Deleted media is allowed.
 * `opts.pending` holds groups about to be created in the same transaction,
 * which count as existing, visible targets.
 * `deps.db` may be a transaction.
 */
export async function checkReferences(
  deps: CoreDeps,
  type: string,
  data: DocumentData,
  opts: {
    kept?: ReadonlySet<string>
    media?: ReadonlyMap<string, string>
    pending?: ReadonlyMap<string, { group_id: string; kind: DocumentKind; type: string }>
  } = {},
): Promise<ContentIssue[]> {
  const kept = opts.kept ?? new Set<string>()
  const found = documentRefPaths(deps, type, data)
  const mediaFound = mediaRefPaths(deps, type, data)
  if (found.length === 0 && mediaFound.length === 0) return []
  const targets = new Map<string, { group_id: string; kind: string; type: string }>()
  if (found.length > 0) {
    const rows = await deps.db
      .selectFrom('documents')
      .select(['group_id', 'kind', 'type'])
      .where('group_id', 'in', [...new Set(found.map((r) => r.ref.id))])
      .$call(whereVisible(deps.registry))
      .execute()
    for (const r of rows) targets.set(r.group_id, r)
    for (const ref of found) {
      const pending = opts.pending?.get(ref.ref.id)
      if (pending && !targets.has(ref.ref.id)) targets.set(ref.ref.id, pending)
    }
  }
  const mediaMime = new Map<string, string>(opts.media ?? [])
  const deleted = new Set<string>()
  if (mediaFound.length > 0) {
    const ids = [...new Set(mediaFound.map((r) => r.ref.id))]
    const present = await deps.db.selectFrom('media').select(['id', 'mime']).where('id', 'in', ids).execute()
    for (const m of present) mediaMime.set(m.id, m.mime)
    const gone = await deps.db.selectFrom('media_deletions').select('media_id').where('media_id', 'in', ids).execute()
    for (const g of gone) deleted.add(g.media_id)
  }

  const issues: ContentIssue[] = []
  const issue = (
    ref: FoundRef,
    code: IssueCode,
    messageId: MessageId,
    params: Record<string, string> = {},
  ) => {
    const labels = docLabels(deps.registry, type, ref.path) ?? ref.path.map(String)
    issues.push(contentIssue(ref.path, labels, code, messageId, params))
  }

  for (const ref of found) {
    const target = targets.get(ref.ref.id)
    if (!target) {
      if (!kept.has(refKey(ref))) issue(ref, 'not_found', 'issue.notFound')
    } else if (ref.meta.kind === 'ref') {
      if (target.kind !== 'entry' || target.type !== ref.meta.target) {
        const collection = deps.registry.types.get(ref.meta.target ?? '')?.label ?? ref.meta.target ?? ''
        issue(ref, 'wrong_collection', 'issue.wrongCollection', { collection })
      }
    } else if ((ref.meta.kind === 'link' || ref.meta.kind === 'richText') && !isRoutable(deps, target)) {
      issue(ref, 'not_routable', 'issue.notRoutable')
    }
  }
  for (const ref of mediaFound) {
    const mime = mediaMime.get(ref.ref.id)
    if (mime === undefined) {
      if (!deleted.has(ref.ref.id) && !kept.has(refKey(ref))) issue(ref, 'not_found', 'issue.mediaNotFound')
    } else if (ref.meta.kind !== 'file' && !mime.startsWith('image/')) {
      issue(ref, 'wrong_media_type', 'issue.notAnImage')
    }
  }
  return issues
}

function isRoutable(deps: CoreDeps, target: { kind: string; type: string }): boolean {
  const def = deps.registry.types.get(target.type)
  if (!def) return false
  if (target.kind === 'singleton') return def.kind === 'singleton' && def.path !== null
  if (target.kind === 'entry') return def.kind === 'collection' && def.route !== null
  return false
}

/**
 * Makes `refs` hold exactly the refs of the document's current head and
 * published revisions as the reader sees them (none if it is deleted). Inside
 * a transaction pass `{ ...deps, db: trx }`.
 */
export async function syncRefs(deps: CoreDeps, documentId: string): Promise<void> {
  const { db, registry } = deps
  await db.deleteFrom('refs').where('from_document_id', '=', documentId).execute()
  const doc = await db
    .selectFrom('documents')
    .select(['type', 'head_rev', 'published_rev', 'deleted_at'])
    .where('id', '=', documentId)
    .executeTakeFirst()
  if (!doc || doc.deleted_at !== null) return
  const revIds = [...new Set([doc.head_rev, doc.published_rev])].filter((id) => id !== null)
  if (revIds.length === 0) return
  const revisions = await db
    .selectFrom('revisions')
    .select(['id', 'data'])
    .where('id', 'in', revIds)
    .execute()
  const rows = revisions.flatMap((rev) =>
    documentRefs(registry, doc.type, readData(registry, doc.type, JSON.parse(rev.data)).data).map((ref) => ({
      from_document_id: documentId,
      from_revision_id: rev.id,
      to_kind: ref.kind,
      to_id: ref.id,
    })),
  )
  if (rows.length > 0) await db.insertInto('refs').values(rows).execute()
}

/**
 * Re-creates the refs of visible, live documents that have none (for
 * example documents of a removed type that an import brought back). Returns
 * how many documents it synced.
 */
export async function repairRefs(deps: CoreDeps): Promise<number> {
  return withTransaction(deps, async (tdeps) => {
    const trx = tdeps.db
    const ids = await trx
      .selectFrom('documents')
      .select('documents.id')
      .$call(whereVisible(deps.registry))
      .where('documents.deleted_at', 'is', null)
      .where('documents.head_rev', 'is not', null)
      .where((eb) =>
        eb.not(eb.exists(eb.selectFrom('refs').select('refs.from_document_id').whereRef('refs.from_document_id', '=', 'documents.id'))),
      )
      .execute()
    for (const { id } of ids) await syncRefs(tdeps, id)
    return ids.length
  })
}
