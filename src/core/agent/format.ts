import type { z } from 'zod'
import { docLabels, documentRefs } from '../content/schema.js'
import { contentIssue } from '../content/validate.js'
import { fieldMeta, type AgentCodec, type AgentRefs } from '../fields/define.js'
import { fieldValues } from '../fields/walk.js'
import { defOf, innerOf, isRecord, type Schema } from '../fields/zod-internals.js'
import { missingMediaLabel } from '../media/library.js'
import { t } from '../messages/index.js'
import type { Registry } from '../registry/registry.js'
import { richTextRefs, type RichTextDoc } from '../richtext/schema.js'
import type { ContentInput, ContentIssue, DocumentData, PathSegment } from '../types.js'

export type { AgentCodec, AgentRefs } from '../fields/define.js'

/** A document as an assistant reads and writes it: the stored shape with agent-format values. */
export type AgentDocument = {
  slug?: string
  path?: string
  fields: Record<string, unknown>
  slots: Record<string, { enabled: boolean; data: Record<string, unknown> }>
}

export type AgentLink = { uri: string; title?: string; url?: string | null; filename?: string; missing?: string }

export type AgentInput = Partial<Omit<AgentDocument, 'slots'>> & {
  slots?: Record<string, { enabled?: boolean; data?: Record<string, unknown> }>
}

const codecOf = (s: Schema): AgentCodec | undefined => fieldMeta(s as z.ZodType)?.agent

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

/**
 * Rebuilds `value` through groups and lists, passing each codec field's value to `leaf`.
 * Keys the schema doesn't know are kept as they are.
 */
function convert(
  s: Schema,
  value: unknown,
  path: PathSegment[],
  leaf: (codec: AgentCodec, value: unknown, path: PathSegment[]) => unknown,
): unknown {
  if (value === undefined || value === null) return value
  const codec = codecOf(s)
  if (codec) return leaf(codec, value, path)
  const { shape, element } = structure(s)
  if (shape && isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      out[key] = Object.hasOwn(shape, key) ? convert(shape[key]!, child, [...path, key], leaf) : child
    }
    return out
  }
  if (element && Array.isArray(value)) return value.map((item, i) => convert(element, item, [...path, i], leaf))
  return value
}

const readValue = (s: Schema, value: unknown, refs: AgentRefs): unknown =>
  convert(s, value, [], (codec, v) => codec.read(v, refs))

/** Every document (`groupId`) and media id `toAgent` will look up through `AgentRefs`. */
export function agentRefsNeeded(
  registry: Registry,
  type: string,
  data: DocumentData,
): { documents: string[]; media: string[] } {
  const documents: string[] = []
  const media: string[] = []
  for (const ref of documentRefs(registry, type, data)) (ref.kind === 'document' ? documents : media).push(ref.id)
  return { documents, media }
}

/** The stored document as the assistant reads it. */
export function toAgent(registry: Registry, type: string, data: DocumentData, refs: AgentRefs): AgentDocument {
  const { template } = registry.getType(type)
  const slots: AgentDocument['slots'] = {}
  for (const [key, slot] of Object.entries(data.slots)) {
    const def = template.slots[key]
    if (!def) continue
    slots[key] = { enabled: slot.enabled, data: readValue(def.block.schema, slot.data, refs) as Record<string, unknown> }
  }
  return {
    ...(data.slug !== undefined && { slug: data.slug }),
    ...(data.path !== undefined && { path: data.path }),
    fields: readValue(template.fields, data.fields, refs) as Record<string, unknown>,
    slots,
  }
}

const RICH_TEXT: ReadonlySet<string> = new Set(['richText', 'inlineText'])

/** Every `inlay:` link and image target in the document's rich text, with what it points to. */
export function agentLinks(registry: Registry, type: string, data: DocumentData, refs: AgentRefs): AgentLink[] {
  const { template } = registry.getType(type)
  const found = fieldValues(template.fields, data.fields, RICH_TEXT)
  for (const [key, slot] of Object.entries(template.slots)) {
    found.push(...fieldValues(slot.block.schema, data.slots[key]?.data, RICH_TEXT))
  }
  const out = new Map<string, AgentLink>()
  for (const { value } of found) {
    if (!isRecord(value)) continue
    for (const ref of richTextRefs(value as RichTextDoc)) {
      const uri = `inlay:${ref.kind}/${ref.id}`
      if (out.has(uri)) continue
      if (ref.kind === 'document') {
        const doc = refs.document(ref.id)
        out.set(uri, doc ? { uri, title: doc.title, url: doc.url } : { uri, missing: t('agent.documentMissing') })
        continue
      }
      const status = refs.media(ref.id)
      out.set(
        uri,
        status.status === 'present'
          ? { uri, filename: status.media.filename, url: refs.mediaUrl(ref.id) }
          : status.status === 'deleted'
            ? { uri, filename: status.filename, missing: missingMediaLabel(status) }
            : { uri, missing: t('agent.mediaUnknown') },
      )
    }
  }
  return [...out.values()]
}

/** A dotted field path; all-digit segments are list indexes. `null` if any segment is empty. */
export function parsePath(path: string): PathSegment[] | null {
  const segments = path.split('.')
  if (segments.some((s) => s === '')) return null
  return segments.map((s) => (/^\d+$/.test(s) ? Number(s) : s))
}

export type FromAgentResult = { ok: true; value: unknown } | { ok: false; issues: ContentIssue[] }

/**
 * Turns a value the assistant wrote at `path` into the stored form. A path that
 * isn't in the schema leaves `value` unchanged, so the patch reports it.
 */
export function fromAgent(registry: Registry, type: string, path: PathSegment[], value: unknown): FromAgentResult {
  const { template } = registry.getType(type)
  const issues: ContentIssue[] = []
  const write = (codec: AgentCodec, v: unknown, at: PathSegment[]): unknown => {
    const result = codec.write(v)
    if (result.ok) return result.value
    const labels = docLabels(registry, type, at) ?? at.map(String)
    for (const problem of result.problems) issues.push(contentIssue(at, labels, 'invalid', 'agent.problem', { problem }))
    return v
  }
  const at = (s: Schema, rest: PathSegment[], base: PathSegment[], v: unknown): unknown => {
    let current = s
    for (const [i, segment] of rest.entries()) {
      const codec = codecOf(current)
      if (codec) {
        // One item of a list-valued field (refs with `many`) is written as a list of one.
        if (i !== rest.length - 1 || typeof segment !== 'number' || codec.schema.type !== 'array') return v
        const one = write(codec, [v], [...base, ...rest])
        return Array.isArray(one) ? one[0] : v
      }
      const { shape, element } = structure(current)
      if (shape && typeof segment === 'string' && Object.hasOwn(shape, segment)) current = shape[segment]!
      else if (element && typeof segment === 'number') current = element
      else return v
    }
    return convert(current, v, [...base, ...rest], write)
  }
  const slot = (key: string, v: unknown): unknown => {
    const def = template.slots[key]
    if (!def || !isRecord(v) || v.data === undefined) return v
    return { ...v, data: at(def.block.schema, [], ['slots', key, 'data'], v.data) }
  }
  const slots = (v: unknown): unknown =>
    isRecord(v) ? Object.fromEntries(Object.entries(v).map(([key, s]) => [key, slot(key, s)])) : v

  const [head, ...rest] = path
  let out = value
  if (head === undefined) {
    if (isRecord(value)) {
      out = {
        ...value,
        ...(value.fields !== undefined && { fields: at(template.fields, [], ['fields'], value.fields) }),
        ...(value.slots !== undefined && { slots: slots(value.slots) }),
      }
    }
  } else if (head === 'fields') {
    out = at(template.fields, rest, ['fields'], value)
  } else if (head === 'slots') {
    const [key, part, ...more] = rest
    const def = typeof key === 'string' && Object.hasOwn(template.slots, key) ? template.slots[key] : undefined
    if (key === undefined) out = slots(value)
    else if (def && part === undefined) out = slot(key as string, value)
    else if (def && part === 'data') out = at(def.block.schema, more, ['slots', key, 'data'], value)
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: out }
}

/**
 * Turns a document the assistant wrote into content for creating it. A slot `{ enabled: false }` becomes `false`.
 * On failure `content` keeps each value that couldn't be converted as it was written.
 */
export function contentFromAgent(
  registry: Registry,
  type: string,
  input: AgentInput,
): { ok: true; content: ContentInput } | { ok: false; issues: ContentIssue[]; content: ContentInput } {
  const issues: ContentIssue[] = []
  const take = (path: PathSegment[], value: unknown): unknown => {
    const result = fromAgent(registry, type, path, value)
    if (result.ok) return result.value
    issues.push(...result.issues)
    return value
  }
  const content: ContentInput = {
    ...(input.slug !== undefined && { slug: input.slug }),
    ...(input.path !== undefined && { path: input.path }),
  }
  if (input.fields !== undefined) content.fields = take(['fields'], input.fields) as Record<string, unknown>
  if (input.slots !== undefined) {
    const slots: NonNullable<ContentInput['slots']> = {}
    for (const [key, slot] of Object.entries(input.slots)) {
      slots[key] = slot.enabled === false ? false : (take(['slots', key, 'data'], slot.data ?? {}) as Record<string, unknown>)
    }
    content.slots = slots
  }
  return issues.length > 0 ? { ok: false, issues, content } : { ok: true, content }
}
