import { sql } from 'kysely'
import type { ContentRef, CoreDeps, DocumentSummary, Usage } from '../types.js'
import { summaryQuery, toSummary, whereVisible } from './read.js'

/**
 * Non-deleted documents whose head or published revision references `target`.
 * A hidden document target has no usages.
 * For a document target, the other locales of the same entry are not usages.
 * Inside a transaction pass `{ ...deps, db: trx }`.
 */
export async function findUsages(deps: CoreDeps, target: ContentRef): Promise<Usage[]> {
  if (target.kind === 'document') {
    const visible = await deps.db
      .selectFrom('documents')
      .select('id')
      .where('group_id', '=', target.id)
      .$call(whereVisible(deps.registry))
      .executeTakeFirst()
    if (!visible) return []
  }
  const refRows = await deps.db
    .selectFrom('refs')
    .select(['from_document_id', 'from_revision_id'])
    .where('to_kind', '=', target.kind)
    .where('to_id', '=', target.id)
    .execute()
  if (refRows.length === 0) return []

  const ids = [...new Set(refRows.map((r) => r.from_document_id))]
  let query = summaryQuery(deps).where('documents.id', 'in', ids).where('documents.deleted_at', 'is', null)
  if (target.kind === 'document') query = query.where('documents.group_id', '!=', target.id)
  const docs = await query.orderBy('documents.head_rev', 'asc').execute()

  return docs.flatMap((doc): Usage[] => {
    const revs = new Set(refRows.filter((r) => r.from_document_id === doc.id).map((r) => r.from_revision_id))
    const inDraft = revs.has(doc.head_rev!)
    const inPublished = doc.published_rev !== null && revs.has(doc.published_rev)
    if (!inDraft && !inPublished) return []
    return [
      {
        documentId: doc.id,
        groupId: doc.group_id,
        type: doc.type,
        locale: doc.locale,
        title: toSummary(deps, doc).title,
        in: inDraft && inPublished ? 'draft-and-published' : inDraft ? 'draft' : 'published',
      },
    ]
  })
}

/**
 * Visible, non-deleted documents whose head or published revision links to content that
 * has been deleted. Links to other languages of the same entry are not counted.
 */
export async function brokenReferences(deps: CoreDeps): Promise<DocumentSummary[]> {
  const rows = await summaryQuery(deps)
    .where('documents.deleted_at', 'is', null)
    .where(
      sql<boolean>`exists (
        select 1 from refs
        where refs.from_document_id = documents.id
          and refs.to_kind = 'document'
          and (refs.from_revision_id = documents.head_rev or refs.from_revision_id = documents.published_rev)
          and refs.to_id != documents.group_id
          and exists (select 1 from documents t where t.group_id = refs.to_id)
          and not exists (select 1 from documents t where t.group_id = refs.to_id and t.deleted_at is null)
      )`,
    )
    .orderBy('documents.id', 'asc')
    .execute()
  return rows.map((row) => toSummary(deps, row))
}
