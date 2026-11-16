import { z } from 'zod'
import { t } from '../messages/index.js'
import type { ContentRef, PathSegment } from '../types.js'
import { defineField, fieldMeta, type FieldMeta } from './define.js'
import { defOf, innerOf, isRecord, type Def, type Schema } from './zod-internals.js'

export type { PathSegment } from '../types.js'

const CONTAINERS = new Set(['group', 'list'])

const metaOf = (s: Schema): FieldMeta | undefined => fieldMeta(s as z.ZodType)

/**
 * Meta for this node itself. A wrapper whose inner schema is a field defers to
 * it (fieldMeta unwraps, and lookups may return copies, so identity can't tell).
 */
export function ownMeta(s: Schema): FieldMeta | undefined {
  const inner = innerOf(s)
  if (inner && metaOf(inner)) return undefined
  return metaOf(s)
}

export const isLeaf = (meta: FieldMeta | undefined): boolean =>
  meta !== undefined && !CONTAINERS.has(meta.kind)

/** Copies a def keeping its accessors (e.g. function defaults), with `overrides` as plain values. */
function withDef(def: Def, overrides: Partial<Def>): Def {
  const next = Object.create(
    Object.getPrototypeOf(def) as object | null,
    Object.getOwnPropertyDescriptors(def),
  ) as Def
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(next, key, { value, enumerable: true, configurable: true, writable: true })
  }
  return next
}

function rebuild(s: Schema, overrides: Partial<Def>): Schema {
  return z.clone(s, withDef(defOf(s), overrides) as unknown as Schema['_zod']['def'])
}

const draftCache = new WeakMap<Schema, Schema>()

function draftOf(s: Schema): Schema {
  const cached = draftCache.get(s)
  if (cached) return cached
  const out = buildDraft(s)
  draftCache.set(s, out)
  return out
}

function buildDraft(s: Schema): Schema {
  const meta = ownMeta(s)
  if (isLeaf(meta)) return meta!.draft ?? s
  const def = defOf(s)
  const inner = innerOf(s)
  let out = s
  if (inner) {
    out = rebuild(s, def.type === 'pipe' ? { in: draftOf(inner) } : { innerType: draftOf(inner) })
  } else if (def.type === 'object' && def.shape) {
    const shape: Record<string, Schema> = {}
    for (const [key, value] of Object.entries(def.shape)) {
      const drafted = draftOf(value)
      shape[key] = drafted._zod.optin === undefined ? z.optional(drafted) : drafted
    }
    out = rebuild(s, { shape })
  } else if (def.type === 'array' && def.element) {
    const checks = def.checks?.filter((c) => c._zod.def.check !== 'min_length')
    out = rebuild(s, { element: draftOf(def.element), checks })
  }
  if (meta && out !== s) defineField(out as z.ZodType, meta)
  return out
}

/**
 * The draft-level version of `schema`: object and group keys become optional,
 * lists drop their minimum, leaves use `meta.draft`. Per-value checks and
 * defaults stay.
 */
export function toDraftSchema(schema: z.ZodType): z.ZodType {
  return draftOf(schema) as z.ZodType
}

const looseCache = new WeakMap<Schema, Schema>()

function looseOf(s: Schema): Schema {
  const cached = looseCache.get(s)
  if (cached) return cached
  const out = buildLoose(s)
  looseCache.set(s, out)
  return out
}

function buildLoose(s: Schema): Schema {
  const meta = ownMeta(s)
  if (isLeaf(meta)) return s
  const def = defOf(s)
  const inner = innerOf(s)
  let out = s
  if (inner) {
    const loose = looseOf(inner)
    if (loose !== inner) out = rebuild(s, def.type === 'pipe' ? { in: loose } : { innerType: loose })
  } else if (def.type === 'object' && def.shape) {
    const shape: Record<string, Schema> = {}
    for (const [key, value] of Object.entries(def.shape)) shape[key] = looseOf(value)
    out = rebuild(s, { shape, catchall: z.unknown() } as Partial<Def>)
  } else if (def.type === 'union' && def.options) {
    const options = def.options.map(looseOf)
    if (options.some((o, i) => o !== def.options![i])) out = rebuild(s, { options })
  }
  if (meta && out !== s) defineField(out as z.ZodType, meta)
  return out
}

/**
 * `schema` with every object it reaches (through wrappers and unions, not
 * inside leaf fields or lists) keeping unknown keys instead of stripping them.
 * List items keep stripping them: the admin rebuilds them on every save.
 */
export function toLooseSchema(schema: z.ZodType): z.ZodType {
  return looseOf(schema) as z.ZodType
}

/** A reference found in content: the path of the field holding it (with the index for lists of ids), and that field. */
export interface FoundRef {
  path: PathSegment[]
  meta: FieldMeta
  ref: ContentRef
}

function refsOf(meta: FieldMeta, value: unknown, path: PathSegment[], out: Map<string, FoundRef>): void {
  const next = new Map<string, number>()
  for (const ref of meta.refs!(value)) {
    let at = path
    if (Array.isArray(value)) {
      const i = value.indexOf(ref.id, next.get(ref.id) ?? 0)
      if (i >= 0) {
        at = [...path, i]
        next.set(ref.id, i + 1)
      }
    }
    out.set(JSON.stringify([at, ref.kind, ref.id]), { path: at, meta, ref })
  }
}

function collectRefs(s: Schema, value: unknown, path: PathSegment[], out: Map<string, FoundRef>): void {
  if (value === undefined || value === null) return
  const meta = ownMeta(s)
  if (meta?.refs) refsOf(meta, value, path, out)
  if (isLeaf(meta)) return
  const def = defOf(s)
  const inner = innerOf(s)
  if (inner) {
    collectRefs(inner, value, path, out)
  } else if (def.type === 'object' && def.shape) {
    if (!isRecord(value)) return
    for (const [key, child] of Object.entries(def.shape)) collectRefs(child, value[key], [...path, key], out)
  } else if (def.type === 'array' && def.element) {
    if (!Array.isArray(value)) return
    value.forEach((item, i) => collectRefs(def.element!, item, [...path, i], out))
  } else if (def.type === 'union' && def.options) {
    for (const option of unionCandidates(def, value)) collectRefs(option, value, path, out)
  }
}

/** For a discriminated union, the options whose discriminator matches; otherwise all options. */
function unionCandidates(def: Def, value: unknown): readonly Schema[] {
  const options = def.options ?? []
  const disc = def.discriminator
  if (disc === undefined || !isRecord(value)) return options
  return options.filter((option) => {
    const field = defOf(option).shape?.[disc]
    const values = field?._zod.values
    return values === undefined || values.has(value[disc] as never)
  })
}

/** Every document and media reference in `value`, with the field it sits in, in document order. */
export function findRefs(schema: z.ZodType, value: unknown): FoundRef[] {
  const out = new Map<string, FoundRef>()
  collectRefs(schema, value, [], out)
  return [...out.values()]
}

/** Every document and media reference in `value`, deduplicated by `kind:id`. */
export function extractRefs(schema: z.ZodType, value: unknown): ContentRef[] {
  const out = new Map<string, ContentRef>()
  for (const { ref } of findRefs(schema, value)) out.set(`${ref.kind}:${ref.id}`, ref)
  return [...out.values()]
}

/** A field value found by `fieldValues`: where it sits, its field, and the value. */
export interface FoundValue {
  path: PathSegment[]
  meta: FieldMeta
  value: unknown
}

function collectValues(
  s: Schema,
  value: unknown,
  path: PathSegment[],
  kinds: ReadonlySet<string>,
  out: FoundValue[],
): void {
  if (value === undefined) return
  const meta = ownMeta(s)
  if (meta && kinds.has(meta.kind)) out.push({ path, meta, value })
  if (isLeaf(meta) || value === null) return
  const def = defOf(s)
  const inner = innerOf(s)
  if (inner) {
    collectValues(inner, value, path, kinds, out)
  } else if (def.type === 'object' && def.shape) {
    if (!isRecord(value)) return
    for (const [key, child] of Object.entries(def.shape)) collectValues(child, value[key], [...path, key], kinds, out)
  } else if (def.type === 'array' && def.element) {
    if (!Array.isArray(value)) return
    value.forEach((item, i) => collectValues(def.element!, item, [...path, i], kinds, out))
  } else if (def.type === 'union' && def.options) {
    const [option] = unionCandidates(def, value)
    if (option) collectValues(option, value, path, kinds, out)
  }
}

/**
 * The values of fields of the given `kinds` in `value`, in document order,
 * descending through groups and lists. Absent (`undefined`) values are skipped.
 */
export function fieldValues(schema: z.ZodType, value: unknown, kinds: ReadonlySet<string>): FoundValue[] {
  const out: FoundValue[] = []
  collectValues(schema, value, [], kinds, out)
  return out
}

function labelsFrom(s: Schema, path: PathSegment[], inLeaf: boolean): string[] | null {
  if (path.length === 0) return []
  const meta = ownMeta(s)
  const leaf = inLeaf || isLeaf(meta)
  const def = defOf(s)
  const inner = innerOf(s)
  if (inner) return labelsFrom(inner, path, leaf)
  if (def.type === 'union' && def.options) {
    for (const option of def.options) {
      const found = labelsFrom(option, path, leaf)
      if (found) return found
    }
    return null
  }
  const [segment, ...rest] = path
  if (def.type === 'object' && def.shape) {
    if (typeof segment !== 'string' || !Object.hasOwn(def.shape, segment)) return null
    const child = def.shape[segment]!
    const tail = labelsFrom(child, rest, leaf)
    if (!tail) return null
    return leaf ? tail : [metaOf(child)?.label ?? segment, ...tail]
  }
  if (def.type === 'array' && def.element) {
    if (typeof segment !== 'number' || !Number.isInteger(segment) || segment < 0) return null
    const tail = labelsFrom(def.element, rest, leaf)
    if (!tail) return null
    if (leaf) return tail
    const n = segment + 1
    const label = meta?.itemLabel !== undefined ? `${meta.itemLabel} ${n}` : t('label.item', { n })
    return [label, ...tail]
  }
  return null
}

/**
 * One label per field segment of `path`, or `null` if the path isn't in the
 * schema. List indexes become "Item n" (or the list's `itemLabel` and n).
 */
export function labelsAt(schema: z.ZodType, path: PathSegment[]): string[] | null {
  return labelsFrom(schema, path, false)
}
