import { isDeepStrictEqual } from 'node:util'
import type { z } from 'zod'
import { fieldMeta } from '../fields/define.js'
import { defOf, isRecord, unwrap, type Def, type Schema } from '../fields/zod-internals.js'
import { t } from '../messages/index.js'
import type { Registry } from '../registry/registry.js'
import { richTextIsBlank, richTextText, type RichTextDoc } from '../richtext/schema.js'
import type { DiffEntry, DocumentData, PathSegment } from '../types.js'
import { docLabels, documentSchema } from './schema.js'

const MAX_LENGTH = 80

/** The object or array schema under any wrappers, if there is one. */
function structure(s: Schema | undefined): Def | undefined {
  if (!s) return undefined
  const def = defOf(unwrap(s))
  return def.type === 'object' || def.type === 'array' ? def : undefined
}

function isLeafSchema(s: Schema | undefined): boolean {
  if (!s) return false
  const kind = fieldMeta(s as z.ZodType)?.kind
  return kind !== undefined && kind !== 'group' && kind !== 'list'
}

/** Fallback labels for a path that isn't in the schema: the keys without the structural ones. */
const rawKeys = (path: PathSegment[]): string[] =>
  path.filter((s, i) => !(i === 0 && (s === 'fields' || s === 'slots')) && !(i === 2 && s === 'data' && path[0] === 'slots')).map(String)

/** Leaf-level changes from `before` (or empty) to `after`, in document schema order. */
export function diffData(
  registry: Registry,
  type: string,
  before: DocumentData | null,
  after: DocumentData,
): DiffEntry[] {
  const { template } = registry.getType(type)
  const schema = documentSchema(registry, type, 'draft')
  const normalize = (data: DocumentData): DocumentData => {
    const parsed = schema.safeParse(data)
    return parsed.success ? parsed.data : data
  }
  before = before && normalize(before)
  after = normalize(after)
  const out: DiffEntry[] = []
  const push = (path: PathSegment[], change: DiffEntry['change'], b?: unknown, a?: unknown) => {
    const entry: DiffEntry = { path, labels: docLabels(registry, type, path) ?? rawKeys(path), change }
    if (change !== 'added') entry.before = b
    if (change !== 'removed') entry.after = a
    out.push(entry)
  }

  const walk = (schema: Schema | undefined, path: PathSegment[], b: unknown, a: unknown): void => {
    if (isDeepStrictEqual(b, a)) return
    if (b === undefined || b === null) {
      if (a !== undefined && a !== null) push(path, 'added', undefined, a)
      return
    }
    if (a === undefined || a === null) return push(path, 'removed', b)
    if (!isLeafSchema(schema)) {
      const struct = structure(schema)
      if (isRecord(b) && isRecord(a) && (struct === undefined || struct.type === 'object')) {
        const shape = struct?.shape ?? {}
        const keys = [...new Set([...Object.keys(shape), ...Object.keys(b), ...Object.keys(a)])]
        for (const key of keys) walk(shape[key], [...path, key], b[key], a[key])
        return
      }
      if (Array.isArray(b) && Array.isArray(a) && (struct === undefined || struct.type === 'array')) {
        for (let i = 0; i < Math.max(b.length, a.length); i++) {
          if (i >= b.length) push([...path, i], 'added', undefined, a[i])
          else if (i >= a.length) push([...path, i], 'removed', b[i])
          else walk(struct?.element, [...path, i], b[i], a[i])
        }
        return
      }
    }
    push(path, 'changed', b, a)
  }

  walk(undefined, ['slug'], before?.slug, after.slug)
  walk(undefined, ['path'], before?.path, after.path)
  walk(template.fields, ['fields'], before?.fields ?? {}, after.fields)
  for (const [key, slot] of Object.entries(template.slots)) {
    const b = before?.slots[key]
    const a = after.slots[key]
    if (!a) continue
    if ((b?.enabled ?? false) !== a.enabled) {
      push(['slots', key, 'enabled'], 'changed', b?.enabled ?? false, a.enabled)
    }
    walk(slot.block.schema, ['slots', key, 'data'], b?.data ?? {}, a.data)
  }
  return out
}

function cut(s: string): string {
  return s.length > MAX_LENGTH ? `${s.slice(0, MAX_LENGTH - 1)}…` : s
}

function short(value: unknown): string {
  if (typeof value === 'string') return cut(value)
  if (typeof value === 'boolean') return t(value ? 'diff.yes' : 'diff.no')
  if (value === undefined || value === null) return t('diff.empty')
  if (Array.isArray(value)) return t('diff.items', { n: value.length })
  if (isRecord(value) && value.type === 'doc') {
    const doc = value as RichTextDoc
    return richTextIsBlank(doc) ? t('diff.empty') : cut(richTextText(doc).replace(/\s+/g, ' ').trim())
  }
  if (isRecord(value)) {
    if (typeof value.text === 'string' && value.text !== '') return cut(value.text)
    if (typeof value.url === 'string') return cut(value.url)
    if (typeof value.document === 'string') return cut(value.document)
    if (typeof value.media === 'string') return t('diff.media', { id: value.media.slice(0, 8) })
    return cut(JSON.stringify(value))
  }
  return cut(String(value))
}

/** One readable line per entry. */
export function formatDiff(entries: DiffEntry[]): string[] {
  return entries.map((e) => {
    const labels = e.labels.join(' → ')
    if (e.change === 'changed') return t('diff.changed', { labels, before: short(e.before), after: short(e.after) })
    if (e.change === 'added') return t('diff.added', { labels, value: short(e.after) })
    return t('diff.removed', { labels, value: short(e.before) })
  })
}
