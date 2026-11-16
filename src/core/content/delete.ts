import { assertCan } from '../auth/roles.js'
import { InlayError } from '../errors.js'
import { t } from '../messages/index.js'
import type { CoreDeps, Ctx, DocumentView } from '../types.js'
import { getDocument, headQuery, parseData, summaryQuery, toSummary } from './read.js'
import { recordEvent, type PublishResult } from './publish.js'
import { carryUnknown } from './reader.js'
import { syncRefs } from './refs.js'
import { uniqueSlug } from './slug.js'
import { findUsages } from './usages.js'
import { insertRevision } from './write.js'
import { withTransaction } from './dry-run.js'

async function groupRows(deps: CoreDeps, groupId: string) {
  const rows = await summaryQuery(deps).where('documents.group_id', '=', groupId).execute()
  if (rows.length === 0) throw new InlayError('not_found', 'error.notFound', { name: groupId })
  if (rows.some((r) => r.kind !== 'entry')) {
    throw new InlayError('invalid_operation', 'error.deleteNotEntry', { name: toSummary(deps, rows[0]!).title })
  }
  return rows
}

/** Deletes every locale of an entry, unless something else still uses it. */
export async function deleteEntry(deps: CoreDeps, groupId: string, ctx: Ctx): Promise<void> {
  assertCan(ctx, 'entry.delete')
  await withTransaction(deps, async (tx) => {
    const trx = tx.db
    const rows = await groupRows(tx, groupId)
    const live = rows.filter((r) => r.deleted_at === null)
    if (live.length === 0) return
    const main = live.find((r) => r.locale === deps.registry.defaultLocale) ?? live[0]!

    const usages = await findUsages(tx, { kind: 'document', id: groupId })
    if (usages.length > 0) {
      throw new InlayError(
        'in_use',
        'error.entryInUse',
        { title: toSummary(tx, main).title, count: usages.length },
        { usages },
      )
    }

    // Documents in hidden locales go too, so they can't outlive their entry.
    const targets = await trx
      .selectFrom('documents')
      .select(['id', 'published_rev'])
      .where('group_id', '=', groupId)
      .where('deleted_at', 'is', null)
      .execute()
    const items: PublishResult['items'] = targets
      .filter((r) => r.published_rev !== null)
      .map((r) => ({ documentId: r.id, revisionId: null, action: 'unpublish' }))
    await trx
      .updateTable('documents')
      .set({
        deleted_at: deps.now().toISOString(),
        published_rev: null,
        published_slug: null,
        published_path: null,
      })
      .where('id', 'in', targets.map((r) => r.id))
      .execute()
    for (const r of targets) await syncRefs(tx, r.id)
    await recordEvent(tx, ctx, null, items)
  })
}

/** Brings a deleted entry back as unpublished drafts; a slug taken meanwhile gets the next free one. */
export async function restoreEntry(deps: CoreDeps, groupId: string, ctx: Ctx): Promise<DocumentView[]> {
  assertCan(ctx, 'entry.restore')
  const ids = await withTransaction(deps, async (tx) => {
    const trx = tx.db
    const rows = await groupRows(tx, groupId)
    // Documents in hidden locales come back too, as deleting took them.
    const all = await headQuery(tx).where('documents.group_id', '=', groupId).execute()
    const deleted = all.filter((r) => r.deleted_at !== null)
    if (deleted.length > 0) {
      await trx
        .updateTable('documents')
        .set({ deleted_at: null })
        .where('id', 'in', deleted.map((r) => r.id))
        .execute()
    }
    for (const row of deleted) {
      // Hidden-locale documents keep their stored data untouched: nobody can take their slug meanwhile.
      if (row.head_slug !== null && deps.registry.locales.includes(row.locale)) {
        const slug = await uniqueSlug(tx, row.type, row.locale, row.head_slug, row.id)
        if (slug !== row.head_slug) {
          const head = await trx
            .selectFrom('revisions')
            .select('data')
            .where('id', '=', row.head_rev)
            .executeTakeFirstOrThrow()
          // Carry from the raw head so a value that no longer fits the schema survives the new revision.
          const read = parseData(tx, row.type, head.data)
          const data = carryUnknown(deps.registry, row.type, JSON.parse(head.data), read, { ...read, slug })
          const at = deps.now().toISOString()
          const revId = await insertRevision(
            tx,
            row.id,
            data,
            { ...ctx, source: 'restore' },
            t('message.restoreSlug', { slug }),
            at,
          )
          await trx.updateTable('documents').set({ head_rev: revId, head_slug: slug }).where('id', '=', row.id).execute()
        }
      }
      await syncRefs(tx, row.id)
    }
    return rows.map((r) => r.id)
  })
  const views = await Promise.all(ids.map((id) => getDocument(deps, id)))
  return views.filter((v): v is DocumentView => v !== null)
}
