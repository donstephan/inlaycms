import { z } from 'zod'
import { findRefs, labelsAt, toDraftSchema, toLooseSchema, type FoundRef } from '../fields/walk.js'
import { t } from '../messages/index.js'
import type { CollectionDef, TemplateDef, TypeDef } from '../registry/define.js'
import type { Registry } from '../registry/registry.js'
import { normalizePath } from '../site/paths.js'
import type { ContentInput, ContentRef, DocumentData, PathSegment } from '../types.js'

export type Level = 'draft' | 'strict'

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const isRouted = (type: TypeDef): type is CollectionDef =>
  type.kind === 'collection' && type.route !== null

const allowsPath = (type: TypeDef): boolean => type.kind === 'collection' && type.customPaths

function atLevel(schema: z.ZodType, level: Level): z.ZodType {
  return level === 'strict' ? schema : toDraftSchema(schema)
}

function slotSchema(template: TemplateDef, key: string, level: Level): z.ZodType {
  const slot = template.slots[key]!
  const data = (l: Level) => toLooseSchema(atLevel(slot.block.schema, l)).prefault({})
  if (!slot.optional) {
    return z.object({ enabled: z.literal(true), data: data(level) }).prefault({ enabled: true })
  }
  return z
    .discriminatedUnion('enabled', [
      z.object({ enabled: z.literal(true), data: data(level) }),
      z.object({ enabled: z.literal(false), data: data('draft') }),
    ])
    .prefault({ enabled: false })
}

function buildSchema(type: TypeDef, level: Level): z.ZodType {
  const { template } = type
  const shape: Record<string, z.ZodType> = {}
  if (isRouted(type)) {
    const slug = z.string().regex(SLUG)
    shape.slug = level === 'strict' ? slug : slug.optional()
  }
  if (allowsPath(type)) shape.path = z.string().refine((p) => normalizePath(p) === p && !/[?#]/.test(p)).optional()
  shape.fields = toLooseSchema(atLevel(template.fields, level)).prefault({})
  const slots: Record<string, z.ZodType> = {}
  for (const key of Object.keys(template.slots)) slots[key] = slotSchema(template, key, level)
  shape.slots = z.looseObject(slots).prefault({})
  return z.object(shape)
}

const cache = new WeakMap<Registry, Map<string, z.ZodType<DocumentData>>>()

/**
 * The schema a document of `type` must satisfy at `level`. Unknown keys in the
 * fields, in slot data (and the groups within) and unknown slot keys are kept;
 * unknown keys at the top level, in a slot's `{ enabled, data }` and inside
 * list items are stripped. Missing slots default to
 * `{ enabled: !optional, data: {} }`.
 */
export function documentSchema(
  registry: Registry,
  type: string,
  level: Level,
): z.ZodType<DocumentData> {
  let byType = cache.get(registry)
  if (!byType) cache.set(registry, (byType = new Map()))
  const key = `${type}:${level}`
  let schema = byType.get(key)
  if (!schema) {
    schema = buildSchema(registry.getType(type), level) as unknown as z.ZodType<DocumentData>
    byType.set(key, schema)
  }
  return schema
}

/** Turns developer-written content into the stored shape, without validating it. */
export function normalizeContent(registry: Registry, type: string, input: ContentInput): DocumentData {
  const { template } = registry.getType(type)
  const slots: DocumentData['slots'] = {}
  for (const [key, slot] of Object.entries(template.slots)) {
    const given = input.slots?.[key]
    slots[key] =
      given === false
        ? { enabled: false, data: {} }
        : given === undefined
          ? { enabled: !slot.optional, data: {} }
          : { enabled: true, data: given }
  }
  return {
    ...(input.slug !== undefined && { slug: input.slug }),
    ...(input.path !== undefined && { path: input.path }),
    fields: input.fields ?? {},
    slots,
  }
}

/** Labels for a document path, or `null` if the path doesn't exist for `type`. */
export function docLabels(registry: Registry, type: string, path: PathSegment[]): string[] | null {
  const def = registry.getType(type)
  const [head, ...rest] = path
  if (head === undefined) return []
  if (head === 'slug') return isRouted(def) && rest.length === 0 ? [t('label.slug')] : null
  if (head === 'path') return allowsPath(def) && rest.length === 0 ? [t('label.path')] : null
  if (head === 'fields') return labelsAt(def.template.fields, rest)
  if (head !== 'slots') return null
  const [key, part, ...tail] = rest
  if (key === undefined) return []
  if (typeof key !== 'string' || !Object.hasOwn(def.template.slots, key)) return null
  const slot = def.template.slots[key]!
  const label = slot.label ?? slot.block.label
  if (part === undefined) return [label]
  if (part === 'enabled') return tail.length === 0 ? [label, t('label.slotShown')] : null
  if (part !== 'data') return null
  const labels = labelsAt(slot.block.schema, tail)
  return labels && [label, ...labels]
}

/** Every reference in the document's fields and slots (switched-off slots included), with its document path. */
export function documentRefsWithPaths(registry: Registry, type: string, data: DocumentData): FoundRef[] {
  const { template } = registry.getType(type)
  const found = findRefs(template.fields, data.fields).map((r) => ({ ...r, path: ['fields', ...r.path] }))
  for (const [key, slot] of Object.entries(template.slots)) {
    for (const r of findRefs(slot.block.schema, data.slots[key]?.data)) {
      found.push({ ...r, path: ['slots', key, 'data', ...r.path] })
    }
  }
  return found
}

/** Every reference in the document's fields and slots, including switched-off slots. */
export function documentRefs(registry: Registry, type: string, data: DocumentData): ContentRef[] {
  const out = new Map<string, ContentRef>()
  for (const { ref } of documentRefsWithPaths(registry, type, data)) out.set(`${ref.kind}:${ref.id}`, ref)
  return [...out.values()]
}
