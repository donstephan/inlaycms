import type { GlobalDef, SingletonDef } from '../../core/registry/define.js'
import type { DocumentSummary } from '../../core/types.js'
import type { AdminContext } from './context.js'

export interface TranslationRow {
  def: SingletonDef | GlobalDef
  /** Every configured language is a key, the default language first; `null` where that language does not exist yet. */
  docs: ReadonlyMap<string, DocumentSummary | null>
}

/** For each page or site-wide item, its document in every configured language. */
export async function translationRows(ctx: AdminContext, defs: ReadonlyArray<SingletonDef | GlobalDef>): Promise<TranslationRow[]> {
  const { core } = ctx
  const { locales, defaultLocale } = core.registry
  const ordered = [defaultLocale, ...locales.filter((l) => l !== defaultLocale)]
  return Promise.all(
    defs.map(async (def) => {
      const found = await Promise.all(ordered.map(async (locale) => [locale, await core.findSingleton(def.name, locale)] as const))
      return { def, docs: new Map<string, DocumentSummary | null>(found) }
    }),
  )
}

/** Every language an item still lacks, with the document a translation would be made from. */
export function missingTranslations(rows: readonly TranslationRow[]): Array<{ def: SingletonDef | GlobalDef; locale: string; from: DocumentSummary }> {
  const out: Array<{ def: SingletonDef | GlobalDef; locale: string; from: DocumentSummary }> = []
  for (const { def, docs } of rows) {
    const from = [...docs.values()].find((d): d is DocumentSummary => d !== null)
    if (!from) continue
    for (const [locale, doc] of docs) if (!doc) out.push({ def, locale, from })
  }
  return out
}
