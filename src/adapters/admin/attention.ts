import { t } from '../../core/messages/index.js'
import type { AdminContext } from './context.js'
import { missingTranslations, translationRows, type TranslationRow } from './translations.js'
import type { IconName } from './views/icons.js'

export interface AttentionItem {
  icon: IconName
  text: string
  href: string
}

const MAX_ITEMS = 8

/**
 * What an editor should look at: missing translations, images without a description, and links to deleted content.
 * `rows.singletons` saves working out the pages' translations again when the caller already has them.
 */
export async function needsAttention(ctx: AdminContext, rows: { singletons?: TranslationRow[] } = {}): Promise<AttentionItem[]> {
  const { core } = ctx
  const { registry } = core
  const items: AttentionItem[] = []

  if (registry.locales.length > 1) {
    const pages = rows.singletons ?? (await translationRows(ctx, registry.site.singletons))
    for (const [found, href] of [
      [pages, '/admin/pages'],
      [await translationRows(ctx, registry.site.globals), '/admin/globals'],
    ] as const) {
      for (const { def, locale } of missingTranslations(found)) {
        items.push({ icon: 'globe', text: t('admin.attention.untranslated', { title: def.label, locale: locale.toUpperCase() }), href })
      }
    }
  }

  const { imagesWithoutAlt } = await core.mediaStats()
  if (imagesWithoutAlt > 0) items.push({ icon: 'image', text: t('admin.attention.noAlt', { count: imagesWithoutAlt }), href: '/admin/media' })

  for (const doc of await core.brokenReferences()) {
    items.push({
      icon: 'redirect',
      text: t('admin.attention.brokenRef', { title: doc.title }),
      href: `/admin/documents/${encodeURIComponent(doc.id)}`,
    })
  }

  return items.slice(0, MAX_ITEMS)
}
