import { sql } from 'kysely'
import type { CoreDeps } from '../types.js'
import { whereVisible } from './read.js'

/**
 * Per collection: visible, non-deleted entries in the default language, and how many of
 * them have a head revision made at or after `changedSince` (0 when it is omitted).
 */
export async function countEntries(
  deps: CoreDeps,
  opts: { changedSince?: string } = {},
): Promise<Record<string, { total: number; changed: number }>> {
  const result: Record<string, { total: number; changed: number }> = {}
  for (const collection of deps.registry.site.collections) result[collection.name] = { total: 0, changed: 0 }

  const changed =
    opts.changedSince === undefined
      ? sql<number>`0`
      : sql<number>`sum(case when revisions.created_at >= ${opts.changedSince} then 1 else 0 end)`
  const rows = await deps.db
    .selectFrom('documents')
    .innerJoin('revisions', 'revisions.id', 'documents.head_rev')
    .$call(whereVisible(deps.registry))
    .where('documents.kind', '=', 'entry')
    .where('documents.deleted_at', 'is', null)
    .where('documents.locale', '=', deps.registry.defaultLocale)
    .select(['documents.type'])
    .select((eb) => [eb.fn.countAll<number>().as('total'), changed.as('changed')])
    .groupBy('documents.type')
    .execute()

  for (const row of rows) {
    if (result[row.type]) result[row.type] = { total: Number(row.total), changed: Number(row.changed) }
  }
  return result
}
