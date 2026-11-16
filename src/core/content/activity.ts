import type { Activity, CoreDeps, DocumentSummary, RevisionSource } from '../types.js'
import { summaryQuery, toSummary, whereVisible } from './read.js'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const CHUNK = 400
const HIDDEN_SOURCES = ['system']

/** The visible, not deleted documents among `ids`, by id. */
async function summariesOf(deps: CoreDeps, ids: string[]): Promise<Map<string, DocumentSummary>> {
  const found = new Map<string, DocumentSummary>()
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await summaryQuery(deps)
      .where('documents.id', 'in', ids.slice(i, i + CHUNK))
      .where('documents.deleted_at', 'is', null)
      .execute()
    for (const row of rows) found.set(row.id, toSummary(deps, row))
  }
  return found
}

function publishedItems(json: string): Array<{ documentId: string; action: 'publish' | 'unpublish' }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const items: Array<{ documentId: string; action: 'publish' | 'unpublish' }> = []
  for (const item of parsed as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const { documentId, action } = item as Record<string, unknown>
    if (typeof documentId === 'string' && (action === 'publish' || action === 'unpublish')) items.push({ documentId, action })
  }
  return items
}

/**
 * What happened lately, newest first: edits (a run of edits to one document by one author through one channel counts
 * as one item) and publish events, for documents that are visible and not deleted. System writes are left out.
 */
export async function recentActivity(deps: CoreDeps, opts: { limit?: number } = {}): Promise<Activity[]> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT)))
  const window = limit * 10

  const revisions = await deps.db
    .selectFrom('revisions')
    .innerJoin('documents', 'documents.id', 'revisions.document_id')
    .select(['revisions.id as id', 'revisions.document_id as document_id', 'revisions.author_name as author_name', 'revisions.source as source', 'revisions.created_at as created_at'])
    .where('documents.deleted_at', 'is', null)
    .where('revisions.source', 'not in', HIDDEN_SOURCES)
    .$call(whereVisible(deps.registry))
    .orderBy('revisions.id', 'desc')
    .limit(window)
    .execute()

  const events = await deps.db.selectFrom('publish_events').selectAll().orderBy('id', 'desc').limit(window).execute()
  const eventItems = events.map((event) => publishedItems(event.items))

  const ids = new Set<string>([...revisions.map((r) => r.document_id), ...eventItems.flatMap((items) => items.map((i) => i.documentId))])
  const documents = await summariesOf(deps, [...ids])

  const activity: Activity[] = []
  const open = new Map<string, Extract<Activity, { kind: 'edit' }>>()
  for (const rev of revisions) {
    const document = documents.get(rev.document_id)
    if (!document) continue
    const source = rev.source as RevisionSource
    const run = open.get(rev.document_id)
    if (run && run.authorName === rev.author_name && run.source === source) {
      run.count += 1
      continue
    }
    const item: Extract<Activity, { kind: 'edit' }> = {
      kind: 'edit',
      at: rev.created_at,
      authorName: rev.author_name,
      source,
      document,
      revisionId: rev.id,
      count: 1,
    }
    open.set(rev.document_id, item)
    activity.push(item)
  }

  events.forEach((event, index) => {
    for (const action of ['publish', 'unpublish'] as const) {
      const seen = new Set<string>()
      const listed: DocumentSummary[] = []
      for (const item of eventItems[index] ?? []) {
        const document = documents.get(item.documentId)
        if (item.action !== action || !document || seen.has(item.documentId)) continue
        seen.add(item.documentId)
        listed.push(document)
      }
      if (listed.length > 0) {
        activity.push({ kind: action, at: event.at, authorName: event.user_name, source: event.source as RevisionSource, documents: listed })
      }
    }
  })

  return activity.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit)
}
