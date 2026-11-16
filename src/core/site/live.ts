import type { Selectable } from 'kysely'
import { documentTitle, whereVisible } from '../content/read.js'
import { readData } from '../content/reader.js'
import type { DocumentsTable } from '../db/schema.js'
import type { TypeDef } from '../registry/define.js'
import type { Registry } from '../registry/registry.js'
import type { CoreDeps, LiveDocument, LiveState } from '../types.js'
import { routePath, singletonPath, withLocale } from './paths.js'

export type LiveOpts = { state?: LiveState }

type LiveRow = Selectable<DocumentsTable> & {
  rev_id: number | null
  rev_data: string | null
  rev_created_at: string | null
}

/** Visible, non-deleted documents, each with its live revision (`rev_*` are `null` when it has none). */
export function liveQuery(deps: CoreDeps, state: LiveState) {
  const rev = state === 'preview' ? 'documents.head_rev' : 'documents.published_rev'
  return deps.db
    .selectFrom('documents')
    .leftJoin('revisions', 'revisions.id', rev)
    .selectAll('documents')
    .select(['revisions.id as rev_id', 'revisions.data as rev_data', 'revisions.created_at as rev_created_at'])
    .where('documents.deleted_at', 'is', null)
    .$call(whereVisible(deps.registry))
}

/** The decoded, locale-prefixed site path of a document of `def` shown in `locale`. */
export function sitePath(
  registry: Registry,
  def: TypeDef,
  locale: string,
  slug: string | null,
  custom: string | null,
): string | null {
  let p: string | null = null
  if (def.kind === 'singleton') p = singletonPath(def, locale, registry.defaultLocale)
  else if (def.kind === 'collection') {
    if (def.customPaths && custom !== null) p = custom
    else if (def.route !== null && slug !== null) p = routePath(def.route, slug)
  }
  return p === null ? null : withLocale(registry, locale, p)
}

function toLive(deps: CoreDeps, state: LiveState, locale: string, row: LiveRow, fallback: boolean): LiveDocument {
  const slug = state === 'preview' ? row.head_slug : row.published_slug
  const custom = state === 'preview' ? row.head_path : row.published_path
  // Live documents feed rendering and template queries, so this is the one read that fills empty values.
  const data = readData(deps.registry, row.type, JSON.parse(row.rev_data!), { fill: true }).data
  return {
    documentId: row.id,
    groupId: row.group_id,
    kind: row.kind,
    type: row.type,
    locale,
    contentLocale: row.locale,
    fallback,
    path: sitePath(deps.registry, deps.registry.getType(row.type), locale, slug, custom),
    title: documentTitle(deps, row, data, slug),
    slug,
    revisionId: row.rev_id!,
    updatedAt: row.rev_created_at!,
    data,
  }
}

/** The locales whose documents can be shown in `locale`: itself, then the default locale if fallback is on. */
function sourceLocales(registry: Registry, locale: string): string[] {
  if (locale === registry.defaultLocale || !registry.site.translationFallback) return [locale]
  return [locale, registry.defaultLocale]
}

function byGroup(rows: LiveRow[]): Map<string, Map<string, LiveRow>> {
  const groups = new Map<string, Map<string, LiveRow>>()
  for (const row of rows) {
    let g = groups.get(row.group_id)
    if (!g) groups.set(row.group_id, (g = new Map()))
    g.set(row.locale, row)
  }
  return groups
}

/** The document a group shows in `locale`, falling back to the default locale when allowed. */
function pick(
  deps: CoreDeps,
  state: LiveState,
  locale: string,
  rows: ReadonlyMap<string, LiveRow>,
): LiveDocument | null {
  for (const source of sourceLocales(deps.registry, locale)) {
    const row = rows.get(source)
    if (row && row.rev_id !== null) return toLive(deps, state, locale, row, source !== locale)
  }
  return null
}

export async function liveDocuments(
  deps: CoreDeps,
  groupIds: string[],
  locale: string,
  opts: LiveOpts = {},
): Promise<Map<string, LiveDocument>> {
  const state = opts.state ?? 'published'
  const out = new Map<string, LiveDocument>()
  const ids = [...new Set(groupIds)]
  if (ids.length === 0 || !deps.registry.locales.includes(locale)) return out
  const rows = await liveQuery(deps, state)
    .where('documents.group_id', 'in', ids)
    .where('documents.locale', 'in', sourceLocales(deps.registry, locale))
    .execute()
  const groups = byGroup(rows)
  for (const id of ids) {
    const g = groups.get(id)
    const doc = g ? pick(deps, state, locale, g) : null
    if (doc) out.set(id, doc)
  }
  return out
}

/** The live document of a singleton or global in `locale`. */
export async function liveSingleton(
  deps: CoreDeps,
  type: string,
  locale: string,
  opts: LiveOpts = {},
): Promise<LiveDocument | null> {
  const state = opts.state ?? 'published'
  if (deps.registry.getType(type).kind === 'collection' || !deps.registry.locales.includes(locale)) return null
  const rows = await liveQuery(deps, state)
    .where('documents.type', '=', type)
    .where('documents.kind', 'in', ['singleton', 'global'])
    .where('documents.locale', 'in', sourceLocales(deps.registry, locale))
    .execute()
  for (const g of byGroup(rows).values()) {
    const doc = pick(deps, state, locale, g)
    if (doc) return doc
  }
  return null
}

/** Live entries of `collection` in `locale`, newest group first. */
export async function liveEntries(
  deps: CoreDeps,
  collection: string,
  locale: string,
  opts: LiveOpts = {},
): Promise<LiveDocument[]> {
  const state = opts.state ?? 'published'
  const { registry } = deps
  if (registry.getType(collection).kind !== 'collection' || !registry.locales.includes(locale)) return []
  const rows = await liveQuery(deps, state)
    .where('documents.type', '=', collection)
    .where('documents.kind', '=', 'entry')
    .where('documents.locale', 'in', [...new Set([locale, registry.defaultLocale])])
    .execute()
  const groups = [...byGroup(rows)].map(([groupId, g]) => ({
    groupId,
    createdAt: (g.get(registry.defaultLocale) ?? g.values().next().value!).created_at,
    doc: pick(deps, state, locale, g),
  }))
  groups.sort((a, b) =>
    a.createdAt !== b.createdAt
      ? a.createdAt < b.createdAt ? 1 : -1
      : a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0,
  )
  return groups.flatMap((g) => (g.doc ? [g.doc] : []))
}

/** One item per site locale where the group is live and has a path. */
export async function liveAlternates(
  deps: CoreDeps,
  groupId: string,
  opts: LiveOpts = {},
): Promise<Array<{ locale: string; path: string; fallback: boolean }>> {
  const state = opts.state ?? 'published'
  const rows = await liveQuery(deps, state).where('documents.group_id', '=', groupId).execute()
  const g = byGroup(rows).get(groupId)
  if (!g) return []
  const out: Array<{ locale: string; path: string; fallback: boolean }> = []
  for (const locale of deps.registry.locales) {
    const doc = pick(deps, state, locale, g)
    if (doc && doc.path !== null) out.push({ locale, path: doc.path, fallback: doc.fallback })
  }
  return out
}
