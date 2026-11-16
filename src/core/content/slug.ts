import type { Registry } from '../registry/registry.js'
import { isReserved, routePath, routeRegExp, singletonPath } from '../site/paths.js'
import type { CoreDeps, ContentIssue, DocumentSummary } from '../types.js'
import { summaryQuery, toSummary } from './read.js'
import { docLabels } from './schema.js'
import { contentIssue } from './validate.js'

const MAX = 80
const FALLBACK = 'entry'

/** Letters NFKD leaves alone but that have a common ASCII spelling. */
const LETTERS: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  þ: 'th',
  ı: 'i',
}

/** A readable ASCII slug for `text`; never empty (falls back to `entry`). */
export function slugify(text: string): string {
  let slug = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[ßæœøđðłþı]/g, (c) => LETTERS[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length > MAX) {
    const cut = slug.slice(0, MAX + 1)
    const boundary = cut.lastIndexOf('-')
    slug = (boundary > 0 ? cut.slice(0, boundary) : slug.slice(0, MAX)).replace(/-+$/, '')
  }
  return slug === '' ? FALLBACK : slug
}

/** Head and published slugs of non-deleted documents of `type` in `locale` that are `base` or `base-…`. */
async function takenSlugs(
  deps: CoreDeps,
  type: string,
  locale: string,
  base: string,
  excludeDocumentId?: string,
): Promise<Set<string>> {
  let query = deps.db
    .selectFrom('documents')
    .select(['head_slug', 'published_slug'])
    .where('type', '=', type)
    .where('locale', '=', locale)
    .where('deleted_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb('head_slug', '=', base),
        eb('head_slug', 'like', `${base}-%`),
        eb('published_slug', '=', base),
        eb('published_slug', 'like', `${base}-%`),
      ]),
    )
  if (excludeDocumentId !== undefined) query = query.where('id', '!=', excludeDocumentId)
  const rows = await query.execute()
  const taken = new Set<string>()
  for (const row of rows) {
    if (row.head_slug !== null) taken.add(row.head_slug)
    if (row.published_slug !== null) taken.add(row.published_slug)
  }
  return taken
}

/**
 * The page path `slug` would get in `type`'s route if a reserved path, a
 * locale root or a singleton page would hide it, else `null`.
 */
function shadowedPath(registry: Registry, type: string, locale: string, slug: string): string | null {
  const def = registry.types.get(type)
  if (def?.kind !== 'collection' || def.route === null) return null
  const path = routePath(def.route, slug)
  // Outside the default locale the page sits under `/<locale>`, where neither of these can hide it.
  const first = path.split('/')[1] ?? ''
  if (locale === registry.defaultLocale && (isReserved(path) || registry.locales.includes(first))) return path
  for (const other of registry.types.values()) {
    if (other.kind === 'singleton' && singletonPath(other, locale, registry.defaultLocale) === path) return path
  }
  return null
}

/**
 * The page path `slug` would get in `type`'s route if a non-deleted entry of
 * another routed collection has (or had in draft) a slug giving that same
 * page, else `null`. A default-language entry also answers under the other
 * languages, so those clash with it too. With `earlierOnly`, only collections
 * the site lists before `type` count: they are tried first, so they hide it.
 */
async function siblingPath(
  deps: CoreDeps,
  type: string,
  locale: string,
  slug: string,
  earlierOnly = false,
): Promise<string | null> {
  const { registry } = deps
  const def = registry.types.get(type)
  if (def?.kind !== 'collection' || def.route === null) return null
  const path = routePath(def.route, slug)
  for (const other of registry.types.values()) {
    if (other.name === type) {
      if (earlierOnly) break
      continue
    }
    if (other.kind !== 'collection' || other.route === null) continue
    const otherSlug = routeRegExp(other.route).exec(path)?.[1]
    if (otherSlug === undefined) continue
    let query = deps.db
      .selectFrom('documents')
      .select('id')
      .where('type', '=', other.name)
      .where('deleted_at', 'is', null)
      .where((eb) => eb.or([eb('head_slug', '=', otherSlug), eb('published_slug', '=', otherSlug)]))
    if (earlierOnly || locale !== registry.defaultLocale) {
      query = query.where('locale', 'in', [...new Set([locale, registry.defaultLocale])])
    }
    if ((await query.executeTakeFirst()) !== undefined) return path
  }
  return null
}

/**
 * `base`, or `base-2`, `base-3`… — the first not used by another non-deleted document of `type` in `locale`
 * whose page nothing else hides or has.
 */
export async function uniqueSlug(
  deps: CoreDeps,
  type: string,
  locale: string,
  base: string,
  excludeDocumentId?: string,
): Promise<string> {
  const taken = await takenSlugs(deps, type, locale, base, excludeDocumentId)
  const free = async (s: string) =>
    !taken.has(s) &&
    shadowedPath(deps.registry, type, locale, s) === null &&
    (await siblingPath(deps, type, locale, s)) === null
  if (await free(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (await free(candidate)) return candidate
  }
}

/**
 * A `path_taken` issue if `slug`'s page would be hidden by, or clash with, another path, a
 * `duplicate_slug` issue if it is already used in `type` + `locale`, else `null`.
 */
export async function slugIssue(
  deps: CoreDeps,
  type: string,
  locale: string,
  slug: string,
  excludeDocumentId?: string,
): Promise<ContentIssue | null> {
  const path = ['slug']
  const labels = docLabels(deps.registry, type, path) ?? path
  const shadowed = shadowedPath(deps.registry, type, locale, slug) ?? (await siblingPath(deps, type, locale, slug))
  if (shadowed !== null) return contentIssue(path, labels, 'path_taken', 'issue.pathTaken', { path: shadowed })
  const taken = await takenSlugs(deps, type, locale, slug, excludeDocumentId)
  if (!taken.has(slug)) return null
  return contentIssue(path, labels, 'duplicate_slug', 'issue.duplicateSlug', { slug })
}

/**
 * Non-deleted entries whose draft or published slug gives them a page that
 * another path or an earlier collection's entry hides, so editors can't save them until the slug changes.
 * `inlaycms check` reports these as warnings.
 */
export async function shadowedEntries(deps: CoreDeps): Promise<Array<{ document: DocumentSummary; slug: string; path: string }>> {
  const routed = [...deps.registry.types.values()]
    .filter((def) => def.kind === 'collection' && def.route !== null)
    .map((def) => def.name)
  if (routed.length === 0) return []
  const rows = await summaryQuery(deps)
    .where('documents.type', 'in', routed)
    .where('documents.deleted_at', 'is', null)
    .orderBy('documents.type')
    .orderBy('documents.locale')
    .orderBy('documents.id')
    .execute()
  const found: Array<{ document: DocumentSummary; slug: string; path: string }> = []
  for (const row of rows) {
    for (const slug of new Set([row.head_slug, row.published_slug])) {
      const path =
        slug === null
          ? null
          : (shadowedPath(deps.registry, row.type, row.locale, slug) ??
            (await siblingPath(deps, row.type, row.locale, slug, true)))
      if (slug === null || path === null) continue
      found.push({ document: toSummary(deps, row), slug, path })
      break
    }
  }
  return found
}
