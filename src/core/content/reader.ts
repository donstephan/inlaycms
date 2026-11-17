import { z } from 'zod'
import { fieldMeta } from '../fields/define.js'
import { isLeaf, ownMeta } from '../fields/walk.js'
import { defOf, innerOf, isRecord, unwrap, type Def, type Schema } from '../fields/zod-internals.js'
import type { Registry } from '../registry/registry.js'
import type { DocumentData, PathSegment } from '../types.js'

export type ReadResult = { data: DocumentData; gaps: PathSegment[][] }

type ReadOpts = { fill: boolean }

/** Wrappers the reader looks through. Pipes and catches are read as a whole, like leaf fields. */
const OPTIONAL = new Set(['optional', 'nullable'])
const DEFAULTED = new Set(['default', 'prefault'])

/** An unfit or missing value: absent if the field may be left out, otherwise a gap (and the empty value when filling). */
function unfit(empty: unknown, required: boolean, opts: ReadOpts, path: PathSegment[], gaps: PathSegment[][]): unknown {
  if (!required) return undefined
  gaps.push(path)
  return opts.fill && empty !== undefined ? structuredClone(empty) : undefined
}

function readNode(
  s: Schema,
  value: unknown,
  opts: ReadOpts,
  path: PathSegment[],
  gaps: PathSegment[][],
  required: boolean,
  inList: boolean,
): unknown {
  const def = defOf(s)
  const inner = innerOf(s)
  const leaf = isLeaf(ownMeta(s))
  if (!leaf && inner) {
    if (def.type === 'nullable' && value === null) return null
    if (def.type === 'optional' && value === undefined) return undefined
    if (OPTIONAL.has(def.type)) return readNode(inner, value, opts, path, gaps, false, inList)
    if (DEFAULTED.has(def.type)) {
      const read = value === undefined ? undefined : readNode(inner, value, opts, path, gaps, false, inList)
      if (read !== undefined) return read
      const fallback = (s as z.ZodType).safeParse(undefined)
      // A default that doesn't fit its own schema is read as if there were none.
      return fallback.success ? fallback.data : readNode(inner, value, opts, path, gaps, required, inList)
    }
    if (def.type === 'readonly') return readNode(inner, value, opts, path, gaps, required, inList)
  }
  if (!leaf && def.type === 'object' && def.shape) {
    // A required object that is missing or isn't one is read as if `{}` were stored.
    if (!isRecord(value) && !required) return undefined
    const stored = isRecord(value) ? value : {}
    const entries: Array<[string, unknown]> = []
    for (const [key, child] of Object.entries(def.shape)) {
      const read = readNode(child, stored[key], opts, [...path, key], gaps, true, inList)
      if (read !== undefined) entries.push([key, read])
    }
    // List items are rebuilt on every save, so unknown keys inside them aren't kept.
    if (!inList) for (const [key, v] of Object.entries(stored)) if (!Object.hasOwn(def.shape, key)) entries.push([key, v])
    return Object.fromEntries(entries)
  }
  if (!leaf && def.type === 'array' && def.element) {
    if (!Array.isArray(value)) return unfit([], required, opts, path, gaps)
    const element = def.element
    const wantsObject = defOf(unwrap(element)).type === 'object'
    const out: unknown[] = []
    for (const item of value) {
      if (wantsObject && !isRecord(item)) continue
      // An item that doesn't fit as a whole is dropped; gaps inside a kept item still count.
      const itemPath = [...path, out.length]
      const itemGaps: PathSegment[][] = []
      const read = readNode(element, item, opts, itemPath, itemGaps, wantsObject, true)
      if (read === undefined || itemGaps.some((g) => g.length === itemPath.length)) continue
      gaps.push(...itemGaps)
      out.push(read)
    }
    return listChecks(s, def).safeParse(out).success ? out : unfit([], required, opts, path, gaps)
  }
  const meta = fieldMeta(s as z.ZodType)
  const result = (s as z.ZodType).safeParse(meta?.readStored ? meta.readStored(value) : value)
  if (result.success) return result.data
  if (OPTIONAL.has(def.type)) return undefined
  if (DEFAULTED.has(def.type)) {
    const fallback = (s as z.ZodType).safeParse(undefined)
    if (fallback.success) return fallback.data
  }
  return unfit(meta?.empty, required, opts, path, gaps)
}

const listCache = new WeakMap<Schema, z.ZodType>()

/** The array's own checks (such as min and max) over items that were already read. */
function listChecks(s: Schema, def: Def): z.ZodType {
  let checked = listCache.get(s)
  if (!checked) {
    checked = z.array(z.unknown()).check(...((def.checks ?? []) as unknown as z.core.$ZodCheck<unknown[]>[]))
    listCache.set(s, checked)
  }
  return checked
}

/**
 * Reads `value` against `schema`, keeping what fits (spec §6.1). A required
 * value that doesn't fit is recorded in `gaps` at `path` and is absent, or the
 * field's empty value when `fill` is set; an optional one is just absent. A
 * required object that is missing is read as `{}`. Unknown object keys are
 * carried through unchanged, except inside list items.
 */
export function readValue(
  schema: z.ZodType,
  value: unknown,
  opts: ReadOpts,
  path: PathSegment[],
  gaps: PathSegment[][],
): unknown {
  return readNode(schema, value, opts, path, gaps, true, false)
}

/**
 * Stored content of `type` read against the current schema, with the paths of
 * required values that are missing or don't fit. `fill` gives those the
 * field's empty value, for rendering only. Unknown fields and slots are kept;
 * a switched-off slot is read but its gaps don't count.
 */
export function readData(registry: Registry, type: string, raw: unknown, opts: { fill?: boolean } = {}): ReadResult {
  const { template } = registry.getType(type)
  const read: ReadOpts = { fill: opts.fill === true }
  const doc = isRecord(raw) ? raw : {}
  const gaps: PathSegment[][] = []
  const fields = (readValue(template.fields, doc.fields, read, ['fields'], gaps) ?? {}) as Record<string, unknown>
  const stored = isRecord(doc.slots) ? doc.slots : {}
  const entries: Array<[string, unknown]> = []
  for (const [key, slot] of Object.entries(template.slots)) {
    const value = stored[key]
    const enabled = slot.optional ? isRecord(value) && value.enabled === true : true
    const storedData = isRecord(value) ? value.data : undefined
    const data = readValue(slot.block.schema, storedData, read, ['slots', key, 'data'], enabled ? gaps : [])
    entries.push([key, { enabled, data: data ?? {} }])
  }
  for (const [key, v] of Object.entries(stored)) if (!Object.hasOwn(template.slots, key)) entries.push([key, v])
  return {
    data: {
      ...(typeof doc.slug === 'string' && { slug: doc.slug }),
      ...(typeof doc.path === 'string' && { path: doc.path }),
      fields,
      slots: Object.fromEntries(entries) as DocumentData['slots'],
    },
    gaps,
  }
}

/**
 * Copies into `to` each key of `raw` that `to` lacks and that is either
 * unknown to the schema or known but missing from `read` (it didn't fit, so
 * the editor never saw it), at every object the schema reaches. Stops at
 * leaves and lists.
 */
function carryObjects(s: Schema, raw: unknown, read: unknown, to: unknown): void {
  if (!isRecord(raw) || !isRecord(to)) return
  if (isLeaf(ownMeta(s))) return
  const inner = innerOf(s)
  if (inner) return carryObjects(inner, raw, read, to)
  const def = defOf(s)
  if (def.type !== 'object' || !def.shape) return
  const seen = isRecord(read) ? read : {}
  for (const [key, child] of Object.entries(def.shape)) carryObjects(child, raw[key], seen[key], to[key])
  for (const [key, v] of Object.entries(raw)) {
    if (Object.hasOwn(to, key)) continue
    if (!Object.hasOwn(def.shape, key) || !Object.hasOwn(seen, key)) to[key] = structuredClone(v)
  }
}

/**
 * `to` with what the stored head `raw` keeps that `to` doesn't supply
 * (spec §6.1): unknown keys, and known keys whose stored value didn't fit and
 * so is absent from `read` (the head as `readData` returned it). This happens
 * at the fields object, each slot's data object, each group reached through
 * the schema, and the slots map, but never inside list items. A known key the
 * editor saw and cleared stays cleared. Pure.
 */
export function carryUnknown(
  registry: Registry,
  type: string,
  raw: unknown,
  read: DocumentData,
  to: DocumentData,
): DocumentData {
  const { template } = registry.getType(type)
  const doc = isRecord(raw) ? raw : {}
  const out = structuredClone(to)
  carryObjects(template.fields, doc.fields, read.fields, out.fields)
  const rawSlots = isRecord(doc.slots) ? doc.slots : {}
  const slots: Record<string, unknown> = isRecord(out.slots) ? out.slots : {}
  for (const [key, slot] of Object.entries(template.slots)) {
    const a = rawSlots[key]
    const b = slots[key]
    if (isRecord(a) && isRecord(b)) carryObjects(slot.block.schema, a.data, read.slots[key]?.data, b.data)
  }
  for (const [key, v] of Object.entries(rawSlots)) {
    if (!Object.hasOwn(template.slots, key) && !Object.hasOwn(slots, key)) slots[key] = structuredClone(v)
  }
  out.slots = slots as DocumentData['slots']
  return out
}
