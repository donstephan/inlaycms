import type { z } from 'zod'
import { assertCan } from '../auth/roles.js'
import { InlayError } from '../errors.js'
import { fieldMeta } from '../fields/define.js'
import { defOf, innerOf, isRecord, type Schema } from '../fields/zod-internals.js'
import type { MessageId } from '../messages/index.js'
import type { Registry } from '../registry/registry.js'
import type { ContentIssue, CoreDeps, Ctx, DocumentData, PathSegment } from '../types.js'
import { whereVisible } from './read.js'
import { writeDraft, type DraftInput, type SaveResult } from './save.js'
import { docLabels } from './schema.js'
import { contentIssue, mergeIssues, validateContent } from './validate.js'
import { validationError } from './write.js'

/** Sets the value at `path`; an omitted `value` removes the key (optional fields only). */
export type PatchOp = { path: PathSegment[]; value?: unknown }

export type PatchResult = { ok: true; data: DocumentData } | { ok: false; issues: ContentIssue[] }

type Container = Record<PathSegment, unknown>

/** The object shape or list element behind any wrappers and pipes, merging union options. */
function structure(schema: Schema): { shape?: Record<string, Schema>; element?: Schema } {
  const inner = innerOf(schema)
  if (inner) return structure(inner)
  const def = defOf(schema)
  if (def.type === 'object' && def.shape) return { shape: def.shape }
  if (def.type === 'array' && def.element) return { element: def.element }
  if (def.type === 'union' && def.options) {
    const shape: Record<string, Schema> = {}
    for (const option of def.options) Object.assign(shape, structure(option).shape)
    return Object.keys(shape).length > 0 ? { shape } : {}
  }
  return {}
}

class Rejected extends Error {
  constructor(readonly issues: ContentIssue[]) {
    super(issues[0]?.message)
  }
}

const labelsOf = (registry: Registry, type: string, p: PathSegment[]) => docLabels(registry, type, p) ?? p.map(String)

/** `segment` under `parent` isn't one of `valid` (key and label pairs). */
function unknownIssue(
  registry: Registry,
  type: string,
  parent: PathSegment[],
  segment: PathSegment,
  valid: Array<[string, string]>,
): ContentIssue {
  const at = [...parent, segment]
  const labels = labelsOf(registry, type, parent)
  const name = String(segment)
  const names = valid.map(([key, label]) => (label === key ? key : `${key} (${label})`)).join(', ')
  const slots = parent.length === 1 && parent[0] === 'slots'
  const messageId: MessageId =
    valid.length === 0 ? (slots ? 'issue.noSlots' : 'issue.noFields') : slots ? 'issue.unknownSlot' : 'issue.unknownField'
  return contentIssue(at, labels, 'unknown_field', messageId, { name, valid: names })
}

const shapeNames = (shape: Record<string, Schema>): Array<[string, string]> =>
  Object.entries(shape).map(([key, child]) => [key, fieldMeta(child as z.ZodType)?.label ?? key])

const slotNames = (registry: Registry, type: string): Array<[string, string]> =>
  Object.entries(registry.getType(type).template.slots).map(([k, s]): [string, string] => [k, s.label ?? s.block.label])

const topNames = (registry: Registry, type: string): Array<[string, string]> =>
  (['slug', 'path', 'fields', 'slots'] as const).flatMap((k): Array<[string, string]> => {
    const labels = docLabels(registry, type, [k])
    return labels === null ? [] : [[k, labels.at(-1) ?? k]]
  })

/** Every key of `value` that isn't in the schema, down through groups, objects and lists (not into leaf fields). */
function unknownKeys(registry: Registry, type: string, sch: Schema, value: unknown, at: PathSegment[]): ContentIssue[] {
  const meta = fieldMeta(sch as z.ZodType)
  if (meta && meta.kind !== 'group' && meta.kind !== 'list') return []
  const { shape, element } = structure(sch)
  if (shape && isRecord(value)) {
    return Object.entries(value).flatMap(([key, child]) =>
      Object.hasOwn(shape, key)
        ? unknownKeys(registry, type, shape[key]!, child, [...at, key])
        : [unknownIssue(registry, type, at, key, shapeNames(shape))],
    )
  }
  if (element && Array.isArray(value)) return value.flatMap((item, i) => unknownKeys(registry, type, element, item, [...at, i]))
  return []
}

/**
 * Every key of whole content (as `createEntry` takes it, with `{ enabled, data }` slots) that `type` doesn't have:
 * slug or path where they don't apply, fields, slots and slot parts. Saving would drop them silently.
 */
export function unknownContentKeys(
  registry: Registry,
  type: string,
  content: { slug?: unknown; path?: unknown; fields?: unknown; slots?: unknown },
): ContentIssue[] {
  const { template } = registry.getType(type)
  const top = topNames(registry, type)
  const issues: ContentIssue[] = []
  for (const key of ['slug', 'path'] as const) {
    if (content[key] !== undefined && !top.some(([k]) => k === key)) issues.push(unknownIssue(registry, type, [], key, top))
  }
  issues.push(...unknownKeys(registry, type, template.fields, content.fields, ['fields']))
  if (!isRecord(content.slots)) return issues
  for (const [key, slot] of Object.entries(content.slots)) {
    const def = template.slots[key]
    if (!def) {
      issues.push(unknownIssue(registry, type, ['slots'], key, slotNames(registry, type)))
      continue
    }
    if (isRecord(slot)) issues.push(...unknownKeys(registry, type, def.block.schema, slot.data, ['slots', key, 'data']))
  }
  return issues
}

function applyOp(registry: Registry, type: string, data: DocumentData, op: PatchOp): void {
  const { path } = op
  const def = registry.getType(type)

  const invalid = (at: PathSegment[]): never => {
    throw new Rejected([contentIssue(at, labelsOf(registry, type, at), 'invalid', 'issue.invalid')])
  }
  const unknown = (parent: PathSegment[], segment: PathSegment, valid: Array<[string, string]>): never => {
    throw new Rejected([unknownIssue(registry, type, parent, segment, valid)])
  }
  /** Rejects every key of `value` that isn't in the schema. */
  const checkValue = (sch: Schema, value: unknown, at: PathSegment[]): void => {
    const found = unknownKeys(registry, type, sch, value, at)
    if (found.length > 0) throw new Rejected(found)
  }

  const top = topNames(registry, type)
  const [head, ...rest] = path
  if (head === undefined) return invalid([])
  if (typeof head !== 'string' || !top.some(([k]) => k === head)) return unknown([], head, top)

  const root = data as unknown as Container
  if (head === 'slug' || head === 'path') {
    if (rest.length > 0) return invalid(path)
    setKey(root, head, op.value)
    return
  }
  if (head === 'fields') {
    const schema = def.template.fields
    if (rest.length === 0) {
      if (op.value === undefined) return invalid(['fields'])
      checkValue(schema, op.value, ['fields'])
      root.fields = op.value
      return
    }
    root.fields = isRecord(root.fields) ? root.fields : {}
    descend(schema, root.fields, ['fields'], rest)
    return
  }
  const [key, part, ...more] = rest
  if (key === undefined) return invalid(['slots'])
  if (typeof key !== 'string' || !Object.hasOwn(def.template.slots, key)) {
    return unknown(['slots'], key, slotNames(registry, type))
  }
  const schema = def.template.slots[key]!.block.schema
  const partNames: Array<[string, string]> = [
    ['enabled', docLabels(registry, type, ['slots', key, 'enabled'])!.at(-1)!],
    ['data', 'data'],
  ]
  const slots = (root.slots = isRecord(root.slots) ? root.slots : {}) as Container
  if (part === undefined) {
    if (op.value === undefined) return invalid(['slots', key])
    if (isRecord(op.value)) {
      const parts = Object.keys(op.value).filter((k) => k !== 'enabled' && k !== 'data')
      const found = [
        ...parts.map((k) => unknownIssue(registry, type, ['slots', key], k, partNames)),
        ...unknownKeys(registry, type, schema, op.value.data, ['slots', key, 'data']),
      ]
      if (found.length > 0) throw new Rejected(found)
    }
    slots[key] = op.value
    return
  }
  if (part !== 'enabled' && part !== 'data') return unknown(['slots', key], part, partNames)
  const slot = (slots[key] = isRecord(slots[key]) ? slots[key] : { enabled: true, data: {} }) as Container
  if (part === 'enabled') {
    if (more.length > 0 || op.value === undefined) return invalid(['slots', key, 'enabled'])
    slot.enabled = op.value
    return
  }
  const base: PathSegment[] = ['slots', key, 'data']
  if (more.length === 0) {
    if (op.value === undefined) return invalid(base)
    checkValue(schema, op.value, base)
    slot.data = op.value
    return
  }
  slot.data = isRecord(slot.data) ? slot.data : {}
  descend(schema, slot.data, base, more)

  function setKey(target: Container, key: PathSegment, value: unknown): void {
    if (value === undefined) delete target[key]
    else target[key] = value
  }

  function descend(sch: Schema, node: unknown, at: PathSegment[], remaining: PathSegment[]): void {
    const [segment, ...after] = remaining
    if (segment === undefined) return
    const { shape, element } = structure(sch)
    if (shape) {
      if (typeof segment !== 'string') return invalid([...at, segment])
      if (!Object.hasOwn(shape, segment)) return unknown(at, segment, shapeNames(shape))
      const target = node as Container
      const here = [...at, segment]
      const child = shape[segment]!
      if (after.length === 0) {
        checkValue(child, op.value, here)
        return setKey(target, segment, op.value)
      }
      const next = structure(child)
      if (target[segment] === undefined || target[segment] === null) {
        if (op.value === undefined) return invalid(here)
        target[segment] = next.element ? [] : {}
      }
      return descend(child, target[segment], here, after)
    }
    if (element) {
      const list = node as unknown[]
      if (typeof segment !== 'number' || !Number.isInteger(segment) || segment < 0 || segment > list.length) {
        return invalid([...at, segment])
      }
      const here = [...at, segment]
      if (after.length === 0) {
        if (op.value === undefined) return invalid(here)
        checkValue(element, op.value, here)
        list[segment] = op.value
        return
      }
      if (segment === list.length) return invalid(here)
      const next = structure(element)
      if (list[segment] === undefined || list[segment] === null) list[segment] = next.element ? [] : {}
      return descend(element, list[segment], here, after)
    }
    return invalid(at)
  }
}

/** Applies each op of `ops` that it can to a copy of `data`, collecting the problems of those it can't. */
function applyEach(registry: Registry, type: string, data: DocumentData, ops: PatchOp[]) {
  let next = structuredClone(data)
  const issues: ContentIssue[] = []
  for (const op of ops) {
    const attempt = structuredClone(next)
    try {
      applyOp(registry, type, attempt, op)
      next = attempt
    } catch (e) {
      if (!(e instanceof Rejected)) throw e
      issues.push(...e.issues)
    }
  }
  return { next, issues }
}

/**
 * Applies `ops` in order to a copy of `data`. Every path must exist in the
 * document's schema; each op that doesn't is rejected with the valid names at
 * that level. The result is not yet validated against the schema.
 */
export function applyPatch(registry: Registry, type: string, data: DocumentData, ops: PatchOp[]): PatchResult {
  const { next, issues } = applyEach(registry, type, data, ops)
  return issues.length > 0 ? { ok: false, issues } : { ok: true, data: next }
}

/**
 * Every problem `ops` have on `data`: the ops that can't be applied, then what checking the rest as a draft
 * finds, leaving out what falls under a path already reported. Empty when the patch would save.
 */
export function patchProblems(registry: Registry, type: string, data: DocumentData, ops: PatchOp[]): ContentIssue[] {
  const { next, issues } = applyEach(registry, type, data, ops)
  const validated = validateContent(registry, type, next, 'draft')
  return mergeIssues(issues, validated.ok ? [] : validated.issues)
}

/** Applies field-path patch operations to the head draft, with the same rules as `saveDraft`. */
export async function patchDraft(
  deps: CoreDeps,
  documentId: string,
  input: DraftInput & { ops: PatchOp[] },
  ctx: Ctx,
): Promise<SaveResult> {
  assertCan(ctx, 'content.write')
  const doc = await deps.db
    .selectFrom('documents')
    .select('type')
    .where('id', '=', documentId)
    .$call(whereVisible(deps.registry))
    .executeTakeFirst()
  if (!doc) throw new InlayError('not_found', 'error.notFound', { name: documentId })
  return writeDraft(deps, documentId, input, ctx, (head) => {
    const result = applyPatch(deps.registry, doc.type, head, input.ops)
    if (!result.ok) throw validationError(patchProblems(deps.registry, doc.type, head, input.ops))
    return result.data
  })
}
