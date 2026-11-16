import { expressionBuilder, type Expression, type Selectable, type SelectQueryBuilder, type SqlBool } from 'kysely'
import type { Database, DocumentsTable, RevisionsTable } from '../db/schema.js'
import { t } from '../messages/index.js'
import type { Registry } from '../registry/registry.js'
import type {
  CoreDeps,
  DocumentData,
  DocumentSummary,
  DocumentView,
  RevisionMeta,
  RevisionSource,
} from '../types.js'
import { readData } from './reader.js'

type DocumentRow = Selectable<DocumentsTable>
type RevisionRow = Selectable<RevisionsTable>

/** Stored revision JSON read against the current schema: defaults filled, unfit values absent, unknown keys carried. */
export function parseData(deps: CoreDeps, type: string, json: string): DocumentData {
  return readData(deps.registry, type, JSON.parse(json)).data
}

/** Singleton/global → type label; entry → title field if non-blank, else slug, else "Untitled". */
export function documentTitle(
  deps: CoreDeps,
  doc: Pick<DocumentRow, 'kind' | 'type'>,
  data: DocumentData,
  slug: string | null,
): string {
  const def = deps.registry.getType(doc.type)
  if (def.kind !== 'collection') return def.label
  const title = data.fields[def.titleField]
  if (typeof title === 'string' && title.trim() !== '') return title
  return slug ?? t('label.untitled')
}

export function revisionMeta(rev: RevisionRow): RevisionMeta {
  return {
    id: rev.id,
    createdAt: rev.created_at,
    authorId: rev.author_id,
    authorName: rev.author_name,
    source: rev.source as RevisionSource,
    message: rev.message,
  }
}

function summary(doc: DocumentRow, title: string, updatedAt: string): DocumentSummary {
  return {
    id: doc.id,
    groupId: doc.group_id,
    kind: doc.kind,
    type: doc.type,
    locale: doc.locale,
    title,
    headRev: doc.head_rev!,
    publishedRev: doc.published_rev,
    deletedAt: doc.deleted_at,
    updatedAt,
  }
}

/**
 * Query modifier (for `$call`) keeping only visible documents: those whose
 * type is in the site and whose locale is one of its locales. Documents of
 * removed types or locales stay in the database but are hidden.
 */
export function whereVisible(registry: Registry) {
  const eb = expressionBuilder<Database, 'documents'>()
  const types = [...registry.types.keys()]
  const visible: Expression<SqlBool> =
    types.length === 0
      ? eb.or([])
      : eb.and([eb('documents.type', 'in', types), eb('documents.locale', 'in', [...registry.locales])])
  return <DB, TB extends keyof DB, O>(qb: SelectQueryBuilder<DB, TB, O>): SelectQueryBuilder<DB, TB, O> =>
    qb.where(visible)
}

/** Documents (hidden ones included) joined with their head revision's data and time. */
export function headQuery(deps: CoreDeps) {
  return deps.db
    .selectFrom('documents')
    .innerJoin('revisions', 'revisions.id', 'documents.head_rev')
    .selectAll('documents')
    .select(['revisions.data as head_data', 'revisions.created_at as head_created_at'])
}

/** Visible documents joined with their head revision's data and time. */
export function summaryQuery(deps: CoreDeps) {
  return headQuery(deps).$call(whereVisible(deps.registry))
}

type SummaryRow = DocumentRow & { head_data: string; head_created_at: string }

export function toSummary(deps: CoreDeps, row: SummaryRow): DocumentSummary {
  const title = documentTitle(deps, row, parseData(deps, row.type, row.head_data), row.head_slug)
  return summary(row, title, row.head_created_at)
}

/** Visible documents joined with their published revision's data and time (documents never published are left out). */
export function summaryBase(deps: CoreDeps) {
  return deps.db
    .selectFrom('documents')
    .innerJoin('revisions', 'revisions.id', 'documents.published_rev')
    .selectAll('documents')
    .select(['revisions.data as published_data', 'revisions.created_at as published_created_at'])
    .$call(whereVisible(deps.registry))
}

/** A summary of `doc` titled from the given revision JSON (its slug too, else the head's); `updatedAt` is that revision's time. */
export function summarizeRevision(deps: CoreDeps, doc: DocumentRow, json: string, updatedAt: string): DocumentSummary {
  const data = parseData(deps, doc.type, json)
  return summary(doc, documentTitle(deps, doc, data, data.slug ?? doc.head_slug), updatedAt)
}

export async function getDocument(
  deps: CoreDeps,
  id: string,
  opts: { state?: 'head' | 'published' } = {},
): Promise<DocumentView | null> {
  const state = opts.state ?? 'head'
  const doc = await deps.db
    .selectFrom('documents')
    .selectAll()
    .where('id', '=', id)
    .$call(whereVisible(deps.registry))
    .executeTakeFirst()
  if (!doc || doc.head_rev === null) return null
  const revId = state === 'head' ? doc.head_rev : doc.published_rev
  if (revId === null) return null
  const ids = [...new Set([doc.head_rev, revId])]
  const revs = await deps.db.selectFrom('revisions').selectAll().where('id', 'in', ids).execute()
  const head = revs.find((r) => r.id === doc.head_rev)
  const rev = revs.find((r) => r.id === revId)
  if (!head || !rev) return null
  const data = parseData(deps, doc.type, rev.data)
  const slug = state === 'head' ? doc.head_slug : doc.published_slug
  return {
    ...summary(doc, documentTitle(deps, doc, data, slug), head.created_at),
    state,
    revision: revisionMeta(rev),
    data,
  }
}

/** The document of a singleton or global in `locale` (default locale if omitted). */
export async function findSingleton(
  deps: CoreDeps,
  type: string,
  locale?: string,
): Promise<DocumentSummary | null> {
  deps.registry.getType(type)
  const row = await summaryQuery(deps)
    .where('documents.type', '=', type)
    .where('documents.kind', 'in', ['singleton', 'global'])
    .where('documents.locale', '=', locale ?? deps.registry.defaultLocale)
    .executeTakeFirst()
  return row ? toSummary(deps, row) : null
}

export async function findTranslation(
  deps: CoreDeps,
  groupId: string,
  locale: string,
): Promise<DocumentSummary | null> {
  const row = await summaryQuery(deps)
    .where('documents.group_id', '=', groupId)
    .where('documents.locale', '=', locale)
    .executeTakeFirst()
  return row ? toSummary(deps, row) : null
}

/** Entries of collection `type` in `locale` (default locale if omitted), newest head first. */
export async function listEntries(
  deps: CoreDeps,
  type: string,
  opts: { locale?: string; includeDeleted?: boolean } = {},
): Promise<DocumentSummary[]> {
  deps.registry.getType(type)
  let query = summaryQuery(deps)
    .where('documents.type', '=', type)
    .where('documents.kind', '=', 'entry')
    .where('documents.locale', '=', opts.locale ?? deps.registry.defaultLocale)
  if (!opts.includeDeleted) query = query.where('documents.deleted_at', 'is', null)
  const rows = await query.orderBy('documents.head_rev', 'desc').execute()
  return rows.map((row) => toSummary(deps, row))
}
