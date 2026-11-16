import { isLeaf, ownMeta } from '../fields/walk.js'
import { defOf, innerOf, isRecord, type Schema } from '../fields/zod-internals.js'
import type { Registry } from '../registry/registry.js'
import type { CoreDeps } from '../types.js'
import { whereVisible } from './read.js'

/**
 * Content the site no longer shows (spec §6.4): documents (not deleted) of types and in
 * locales it doesn't have, and in visible documents, stored slots and fields the schema
 * doesn't have. Each count is of documents.
 */
export interface HiddenContent {
  types: Array<{ type: string; documents: number }>
  locales: Array<{ locale: string; documents: number }>
  slots: Array<{ type: string; slot: string; documents: number }>
  /** `path` is where the key is stored, joined with dots, such as `slots.hero.data.headline`. */
  fields: Array<{ type: string; path: string; documents: number }>
}

/**
 * Adds to `out` the path of each key of `raw` the schema doesn't have, at every object the
 * schema reaches, the way `carryObjects` in `reader.ts` walks. Stops at leaves and lists.
 */
function unknownKeys(s: Schema, raw: unknown, path: string[], out: Set<string>): void {
  if (!isRecord(raw) || isLeaf(ownMeta(s))) return
  const inner = innerOf(s)
  if (inner) return unknownKeys(inner, raw, path, out)
  const def = defOf(s)
  if (def.type !== 'object' || !def.shape) return
  for (const [key, value] of Object.entries(raw)) {
    const child = Object.hasOwn(def.shape, key) ? def.shape[key] : undefined
    if (child) unknownKeys(child, value, [...path, key], out)
    else out.add([...path, key].join('.'))
  }
}

/** Unknown slot keys and unknown field paths in one stored revision of `type`. */
function scan(registry: Registry, type: string, json: string, slots: Set<string>, fields: Set<string>): void {
  const { template } = registry.getType(type)
  const raw: unknown = JSON.parse(json)
  const doc = isRecord(raw) ? raw : {}
  unknownKeys(template.fields, doc.fields, ['fields'], fields)
  const stored = isRecord(doc.slots) ? doc.slots : {}
  for (const [key, value] of Object.entries(stored)) {
    const slot = Object.hasOwn(template.slots, key) ? template.slots[key] : undefined
    if (!slot) slots.add(key)
    else if (isRecord(value)) unknownKeys(slot.block.schema, value.data, ['slots', key, 'data'], fields)
  }
}

const bump = <K>(counts: Map<K, number>, key: K) => counts.set(key, (counts.get(key) ?? 0) + 1)

/** Documents (not deleted) of types and in locales the current site doesn't have, by type and by locale. */
export type HiddenDocuments = Pick<HiddenContent, 'types' | 'locales'>

/** The documents the current site hides by type and by locale (spec §6.4), counted without reading any content. */
export async function hiddenDocuments(deps: CoreDeps): Promise<HiddenDocuments> {
  const { db, registry } = deps
  const types = [...registry.types.keys()]
  const locales = [...registry.locales]
  let byType = db
    .selectFrom('documents')
    .select((eb) => ['type', eb.fn.countAll<number>().as('documents')])
    .where('deleted_at', 'is', null)
  if (types.length > 0) byType = byType.where('type', 'not in', types)
  let byLocale = db
    .selectFrom('documents')
    .select((eb) => ['locale', eb.fn.countAll<number>().as('documents')])
    .where('deleted_at', 'is', null)
  if (locales.length > 0) byLocale = byLocale.where('locale', 'not in', locales)
  const [typeRows, localeRows] = await Promise.all([
    byType.groupBy('type').orderBy('type').execute(),
    byLocale.groupBy('locale').orderBy('locale').execute(),
  ])
  return {
    types: typeRows.map((r) => ({ type: r.type, documents: Number(r.documents) })),
    locales: localeRows.map((r) => ({ locale: r.locale, documents: Number(r.documents) })),
  }
}

/** What the current site hides, with counts (spec §6.4). Computed on read, never stored. */
export async function hiddenContent(deps: CoreDeps): Promise<HiddenContent> {
  const { db, registry } = deps
  const [byDocument, rows] = await Promise.all([
    hiddenDocuments(deps),
    db
      .selectFrom('documents')
      .innerJoin('revisions as head', 'head.id', 'documents.head_rev')
      .leftJoin('revisions as pub', 'pub.id', 'documents.published_rev')
      .select(['documents.type', 'documents.head_rev', 'documents.published_rev', 'head.data as head_data', 'pub.data as published_data'])
      .where('documents.deleted_at', 'is', null)
      .$call(whereVisible(registry))
      .execute(),
  ])

  const slotCounts = new Map<string, number>()
  const fieldCounts = new Map<string, number>()
  for (const row of rows) {
    const slots = new Set<string>()
    const fields = new Set<string>()
    scan(registry, row.type, row.head_data, slots, fields)
    if (row.published_data !== null && row.published_rev !== row.head_rev) {
      scan(registry, row.type, row.published_data, slots, fields)
    }
    for (const slot of slots) bump(slotCounts, JSON.stringify([row.type, slot]))
    for (const path of fields) bump(fieldCounts, JSON.stringify([row.type, path]))
  }
  const entries = (counts: Map<string, number>) =>
    [...counts]
      .map(([key, documents]) => [...(JSON.parse(key) as [string, string]), documents] as const)
      .sort(([t1, k1], [t2, k2]) => (t1 === t2 ? (k1 < k2 ? -1 : k1 > k2 ? 1 : 0) : t1 < t2 ? -1 : 1))

  return {
    ...byDocument,
    slots: entries(slotCounts).map(([type, slot, documents]) => ({ type, slot, documents })),
    fields: entries(fieldCounts).map(([type, path, documents]) => ({ type, path, documents })),
  }
}
