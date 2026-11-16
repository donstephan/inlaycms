import { assertCan } from '../auth/roles.js'
import { InlayError } from '../errors.js'
import { t } from '../messages/index.js'
import type { CoreDeps, Ctx, DiffEntry, DocumentData, RevisionMeta } from '../types.js'
import { diffData } from './diff.js'
import { parseData, revisionMeta, whereVisible } from './read.js'
import { writeDraft, type SaveResult } from './save.js'

/** Revisions of a document, newest first. */
export async function listRevisions(deps: CoreDeps, documentId: string): Promise<RevisionMeta[]> {
  const doc = await deps.db
    .selectFrom('documents')
    .select('id')
    .where('id', '=', documentId)
    .$call(whereVisible(deps.registry))
    .executeTakeFirst()
  if (!doc) throw new InlayError('not_found', 'error.notFound', { name: documentId })
  const rows = await deps.db
    .selectFrom('revisions')
    .selectAll()
    .where('document_id', '=', documentId)
    .orderBy('id', 'desc')
    .execute()
  return rows.map(revisionMeta)
}

export async function getRevision(
  deps: CoreDeps,
  revisionId: number,
): Promise<{ meta: RevisionMeta; documentId: string; data: DocumentData } | null> {
  const rev = await deps.db.selectFrom('revisions').selectAll().where('id', '=', revisionId).executeTakeFirst()
  if (!rev) return null
  const doc = await deps.db
    .selectFrom('documents')
    .select('type')
    .where('id', '=', rev.document_id)
    .$call(whereVisible(deps.registry))
    .executeTakeFirst()
  if (!doc) return null
  return { meta: revisionMeta(rev), documentId: rev.document_id, data: parseData(deps, doc.type, rev.data) }
}

async function requireRevision(deps: CoreDeps, revisionId: number) {
  const rev = await getRevision(deps, revisionId)
  if (!rev) throw new InlayError('not_found', 'error.notFound', { name: String(revisionId) })
  return rev
}

/** Changes from `fromRevisionId` (`null` = empty) to `toRevisionId`; both must belong to one document. */
export async function diffRevisions(
  deps: CoreDeps,
  fromRevisionId: number | null,
  toRevisionId: number,
): Promise<DiffEntry[]> {
  const to = await requireRevision(deps, toRevisionId)
  const from = fromRevisionId === null ? null : await requireRevision(deps, fromRevisionId)
  if (from && from.documentId !== to.documentId) {
    throw new InlayError('invalid_operation', 'error.revisionMismatch')
  }
  const doc = await deps.db.selectFrom('documents').select('type').where('id', '=', to.documentId).executeTakeFirstOrThrow()
  return diffData(deps.registry, doc.type, from?.data ?? null, to.data)
}

/** Writes the data of an old revision as a new head draft. Never publishes. */
export async function restoreRevision(
  deps: CoreDeps,
  documentId: string,
  revisionId: number,
  ctx: Ctx,
  opts: { message?: string } = {},
): Promise<SaveResult> {
  assertCan(ctx, 'content.write')
  const rev = await requireRevision(deps, revisionId)
  if (rev.documentId !== documentId) throw new InlayError('invalid_operation', 'error.revisionMismatch')
  return writeDraft(
    deps,
    documentId,
    { baseRevisionId: null, message: opts.message ?? t('history.restored', { id: revisionId }) },
    { ...ctx, source: 'restore' },
    () => rev.data,
  )
}
