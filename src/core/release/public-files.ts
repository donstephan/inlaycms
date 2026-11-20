import type { Registry } from '../registry/registry.js'
import { InlayError } from '../errors.js'
import { t, type MessageId } from '../messages/index.js'
import { isReserved, singletonPath } from '../site/paths.js'
import { listFiles } from './pack.js'

/** A `public/` file whose root address is taken. `file` is relative to `public/`; `path` is `'/' + file`. */
export interface PublicClash {
  file: string
  path: string
  kind: 'reserved' | 'route' | 'redirect' | 'page'
}

const MESSAGES: Record<PublicClash['kind'], MessageId> = {
  reserved: 'error.publicReserved',
  route: 'error.publicRoute',
  redirect: 'error.publicRedirect',
  page: 'error.publicPage',
}

/** The `public/` files that would be served at a root address Inlay or the site already uses. */
export async function publicClashes(
  publicDir: string,
  registry: Pick<Registry, 'getRoutePaths' | 'redirects' | 'locales' | 'defaultLocale'> & { site: Pick<Registry['site'], 'singletons'> },
): Promise<PublicClash[]> {
  const pages = new Set<string>()
  for (const def of registry.site.singletons) {
    for (const locale of registry.locales) {
      const p = singletonPath(def, locale, registry.defaultLocale)
      if (p !== null) pages.add(p)
    }
  }
  const redirects = new Set(registry.redirects.map((r) => r.from))
  const out: PublicClash[] = []
  for (const file of await listFiles(publicDir, true)) {
    if (!(file.split('/').at(-1) ?? '').includes('.')) continue
    const path = `/${file}`
    if (isReserved(path)) out.push({ file, path, kind: 'reserved' })
    else if (registry.getRoutePaths.has(path)) out.push({ file, path, kind: 'route' })
    else if (redirects.has(path)) out.push({ file, path, kind: 'redirect' })
    else if (pages.has(path)) out.push({ file, path, kind: 'page' })
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

export function publicClashMessage(clash: PublicClash): string {
  return t(MESSAGES[clash.kind], { file: clash.file, path: clash.path })
}

export function publicClashError(clash: PublicClash): InlayError {
  return new InlayError('release', MESSAGES[clash.kind], { file: clash.file, path: clash.path })
}
