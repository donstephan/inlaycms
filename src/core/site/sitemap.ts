import type { CoreDeps } from '../types.js'
import { liveAlternates, liveEntries, liveSingleton } from './live.js'

export interface SitemapEntry {
  path: string
  updatedAt: string
  alternates: Array<{ locale: string; path: string }>
}

/** One item per published, non-fallback, routable document. */
export async function sitemapEntries(deps: CoreDeps): Promise<SitemapEntry[]> {
  const { registry } = deps
  const out: SitemapEntry[] = []
  for (const locale of registry.locales) {
    for (const def of registry.types.values()) {
      if (def.kind === 'global') continue
      const docs =
        def.kind === 'collection'
          ? await liveEntries(deps, def.name, locale)
          : [await liveSingleton(deps, def.name, locale)]
      for (const doc of docs) {
        if (!doc || doc.fallback || doc.path === null) continue
        const alternates = (await liveAlternates(deps, doc.groupId))
          .filter((a) => !a.fallback)
          .map(({ locale: l, path }) => ({ locale: l, path }))
        out.push({ path: doc.path, updatedAt: doc.updatedAt, alternates })
      }
    }
  }
  return out
}
