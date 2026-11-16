import type { ContentIssue, CoreDeps, DocumentSummary } from '../types.js'
import { readData } from './reader.js'
import { summarizeRevision, summaryBase } from './read.js'
import { docLabels } from './schema.js'
import { contentIssue } from './validate.js'

export interface Gap {
  document: DocumentSummary
  issues: ContentIssue[]
}

export interface GapSummary {
  type: string
  label: string
  documents: number
  /** The gapped documents of the type, by locale. */
  locales: Record<string, number>
}

/** Which documents `listGaps` looks at: of `type`, of one of `types`, with one of `ids`; all of them when none is given. */
export interface GapFilter {
  type?: string
  types?: readonly string[]
  ids?: readonly string[]
}

/**
 * Visible, non-deleted documents whose published revision has required fields with no
 * value under the current schema. Computed on read, never stored.
 */
export async function listGaps(deps: CoreDeps, opts: GapFilter = {}): Promise<Gap[]> {
  const { registry } = deps
  if (opts.types?.length === 0 || opts.ids?.length === 0) return []
  let query = summaryBase(deps).where('documents.deleted_at', 'is', null)
  if (opts.type !== undefined) query = query.where('documents.type', '=', opts.type)
  if (opts.types !== undefined) query = query.where('documents.type', 'in', [...opts.types])
  if (opts.ids !== undefined) query = query.where('documents.id', 'in', [...opts.ids])
  const rows = await query
    .orderBy('documents.type', 'asc')
    .orderBy('documents.created_at', 'asc')
    .orderBy('documents.id', 'asc')
    .execute()
  const gaps: Gap[] = []
  for (const row of rows) {
    const found = readData(registry, row.type, JSON.parse(row.published_data)).gaps
    if (found.length === 0) continue
    gaps.push({
      document: summarizeRevision(deps, row, row.published_data, row.published_created_at),
      issues: found.map((path) =>
        contentIssue(path, docLabels(registry, row.type, path) ?? path.map(String), 'required', 'issue.required'),
      ),
    })
  }
  return gaps
}

/** One row per type with at least one gapped document. */
export async function gapSummary(deps: CoreDeps): Promise<GapSummary[]> {
  const rows = new Map<string, GapSummary>()
  for (const { document } of await listGaps(deps)) {
    let row = rows.get(document.type)
    if (row === undefined) {
      row = { type: document.type, label: deps.registry.getType(document.type).label, documents: 0, locales: {} }
      rows.set(document.type, row)
    }
    row.documents++
    row.locales[document.locale] = (row.locales[document.locale] ?? 0) + 1
  }
  return [...rows.values()]
}
