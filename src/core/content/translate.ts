import { assertCan } from '../auth/roles.js'
import { InlayError } from '../errors.js'
import type { CoreDeps, Ctx, DocumentView } from '../types.js'
import { getDocument, parseData, summaryQuery, toSummary } from './read.js'
import { syncRefs } from './refs.js'
import { uniqueSlug } from './slug.js'
import { insertRevision } from './write.js'
import { withTransaction } from './dry-run.js'

/** Copies the default-locale document of `groupId` into `locale` as an unpublished draft. */
export async function createTranslation(
  deps: CoreDeps,
  groupId: string,
  locale: string,
  ctx: Ctx,
): Promise<DocumentView> {
  assertCan(ctx, 'content.write')
  const { registry } = deps
  if (locale === registry.defaultLocale) throw new InlayError('invalid_operation', 'error.translateDefault', { locale })
  if (!registry.locales.includes(locale)) {
    const locales = registry.locales.filter((l) => l !== registry.defaultLocale).join(', ')
    throw new InlayError('invalid_operation', 'error.translateLocale', { locale, locales })
  }

  const id = crypto.randomUUID()
  await withTransaction(deps, async (tx) => {
    const trx = tx.db
    const source = await summaryQuery(tx)
      .where('documents.group_id', '=', groupId)
      .where('documents.locale', '=', registry.defaultLocale)
      .executeTakeFirst()
    if (!source) throw new InlayError('not_found', 'error.notFound', { name: groupId })
    if (source.deleted_at !== null) {
      throw new InlayError('invalid_operation', 'error.translateDeleted', { title: toSummary(tx, source).title })
    }
    const existing = await trx
      .selectFrom('documents')
      .select('id')
      .where('group_id', '=', groupId)
      .where('locale', '=', locale)
      .executeTakeFirst()
    if (existing) throw new InlayError('invalid_operation', 'error.translationExists', { locale })

    const data = parseData(tx, source.type, source.head_data)
    const def = registry.getType(source.type)
    if (def.kind === 'collection' && def.route !== null && data.slug !== undefined) {
      data.slug = await uniqueSlug(tx, source.type, locale, data.slug)
    }

    const at = deps.now().toISOString()
    await trx
      .insertInto('documents')
      .values({
        id,
        kind: source.kind,
        type: source.type,
        group_id: groupId,
        locale,
        head_rev: null,
        published_rev: null,
        head_slug: data.slug ?? null,
        published_slug: null,
        head_path: data.path ?? null,
        published_path: null,
        deleted_at: null,
        created_at: at,
        key: source.key,
      })
      .execute()
    const revId = await insertRevision(tx, id, data, ctx, null, at)
    await trx.updateTable('documents').set({ head_rev: revId }).where('id', '=', id).execute()
    await syncRefs(tx, id)
  })

  return (await getDocument(deps, id))!
}
