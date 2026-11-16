import { isReserved, routeRegExp, singletonPath } from '../site/paths.js'
import type { ContentIssue, CoreDeps } from '../types.js'
import { docLabels } from './schema.js'
import { contentIssue } from './validate.js'

/**
 * A `path_taken` issue if the custom `path` can't be used by a `type` entry in `locale` (a site route, a
 * reserved path or another page has it), else `null`.
 */
export async function pathIssue(
  deps: CoreDeps,
  type: string,
  locale: string,
  path: string,
  excludeDocumentId?: string,
): Promise<ContentIssue | null> {
  const { registry } = deps
  const at = ['path']
  const labels = docLabels(registry, type, at) ?? at
  if (registry.site.routes.some((r) => r.path === path)) return contentIssue(at, labels, 'path_taken', 'issue.pathRoute', { path })
  const first = path.split('/')[1] ?? ''
  let taken = isReserved(path) || registry.locales.includes(first)
  for (const def of registry.types.values()) {
    if (taken) break
    if (def.kind === 'singleton') taken = singletonPath(def, locale, registry.defaultLocale) === path
    else if (def.kind === 'collection' && def.route !== null) taken = routeRegExp(def.route).test(path)
  }
  if (!taken) {
    let query = deps.db
      .selectFrom('documents')
      .select('id')
      .where('locale', '=', locale)
      .where('deleted_at', 'is', null)
      .where((eb) => eb.or([eb('head_path', '=', path), eb('published_path', '=', path)]))
    if (excludeDocumentId !== undefined) query = query.where('id', '!=', excludeDocumentId)
    taken = (await query.executeTakeFirst()) !== undefined
  }
  if (!taken) return null
  return contentIssue(at, labels, 'path_taken', 'issue.pathTaken', { path })
}
