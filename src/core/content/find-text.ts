import { fieldValues, type FoundValue, type PathSegment } from '../fields/walk.js'
import { isRecord } from '../fields/zod-internals.js'
import type { RichTextDoc } from '../richtext/schema.js'
import { textRuns } from '../richtext/runs.js'
import { designedInCode } from '../registry/designed.js'
import type { CoreDeps, DocumentData, DocumentSummary } from '../types.js'
import { documentSchema } from './schema.js'
import { parseData, summaryQuery, toSummary } from './read.js'
import { findPhrase, snippetAround } from './text-match.js'

const KINDS: ReadonlySet<string> = new Set(['text', 'textarea', 'richText', 'inlineText', 'link'])
const SNIPPET = 100
const MAX_OCCURRENCES = 20

export interface TextOccurrence {
  n: number
  snippet: string
  spansFormatting?: true
}

export interface FieldMatch {
  path: PathSegment[]
  text: string
  count: number
  occurrences: TextOccurrence[]
  hidden?: true
}

export interface FindTextResult {
  total: number
  documents: Array<{ document: DocumentSummary; matches: FieldMatch[] }>
  designedInCode: Array<{ type: string; title: string }>
}

function hiddenSlot(data: DocumentData, path: PathSegment[]): boolean {
  if (path[0] !== 'slots' || typeof path[1] !== 'string') return false
  const slot = (data.slots as Record<string, unknown>)[path[1]]
  return isRecord(slot) && slot.enabled === false
}

/**
 * The fields of a document's values in schema order, including those in switched-off slots,
 * whose draft schema carries no field kinds: those are walked with their block's schema instead.
 */
function foundFields(deps: CoreDeps, type: string, data: DocumentData): FoundValue[] {
  const { slots } = deps.registry.getType(type).template
  const keys = Object.keys(slots)
  const off = new Map<string, FoundValue[]>()
  for (const [key, slot] of Object.entries(slots)) {
    const value = (data.slots as Record<string, unknown>)[key]
    if (!isRecord(value) || value.enabled !== false) continue
    const found = fieldValues(slot.block.schema, value.data, KINDS)
    off.set(key, found.map((v) => ({ ...v, path: ['slots', key, 'data', ...v.path] })))
  }
  const slotOf = (v: FoundValue) => (v.path[0] === 'slots' && typeof v.path[1] === 'string' ? v.path[1] : undefined)
  const rank = (v: FoundValue) => {
    const key = slotOf(v)
    if (key === undefined) return -1
    const i = keys.indexOf(key)
    return i === -1 ? keys.length : i
  }
  return fieldValues(documentSchema(deps.registry, type, 'strict'), data, KINDS)
    .filter((v) => {
      const key = slotOf(v)
      return key === undefined || !off.has(key)
    })
    .concat(...off.values())
    .sort((a, b) => rank(a) - rank(b))
}

function fieldMatches(fields: FoundValue[], data: DocumentData, phrase: string): FieldMatch[] {
  const matches: FieldMatch[] = []
  for (const found of fields) {
    let path = found.path
    const runs: Array<{ text: string; pieces: Array<{ start: number; end: number }> }> = []
    if (found.meta.kind === 'link') {
      if (!isRecord(found.value) || typeof found.value.text !== 'string') continue
      path = [...path, 'text']
      runs.push({ text: found.value.text, pieces: [] })
    } else if (found.meta.kind === 'richText' || found.meta.kind === 'inlineText') {
      if (!isRecord(found.value) || !Array.isArray(found.value.content)) continue
      runs.push(...textRuns(found.value as unknown as RichTextDoc))
    } else if (typeof found.value === 'string') {
      runs.push({ text: found.value, pieces: [] })
    }
    const groups = new Map<string, FieldMatch>()
    for (const run of runs) {
      for (const hit of findPhrase(run.text, phrase, 'loose')) {
        let group = groups.get(hit.text)
        if (!group) {
          group = { path, text: hit.text, count: 0, occurrences: [] }
          if (hiddenSlot(data, path)) group.hidden = true
          groups.set(hit.text, group)
        }
        group.count += 1
        if (group.occurrences.length < MAX_OCCURRENCES) {
          const occurrence: TextOccurrence = { n: group.count, snippet: snippetAround(run.text, hit, SNIPPET) }
          if (run.pieces.length > 0 && !run.pieces.some((p) => hit.start >= p.start && hit.end <= p.end)) {
            occurrence.spansFormatting = true
          }
          group.occurrences.push(occurrence)
        }
      }
    }
    matches.push(...groups.values())
  }
  return matches
}

export async function findText(
  deps: CoreDeps,
  text: string,
  opts: { type?: string; locale?: string; limit?: number; offset?: number } = {},
): Promise<FindTextResult> {
  const { registry } = deps
  if (opts.type !== undefined) registry.getType(opts.type)
  const designed = (): FindTextResult['designedInCode'] =>
    [...registry.site.singletons, ...registry.site.globals]
      .filter((def) => (opts.type === undefined || def.name === opts.type) && designedInCode(def.template))
      .map((def) => ({ type: def.name, title: def.label }))
  if (text.trim() === '') return { total: 0, documents: [], designedInCode: [] }
  const limit = Math.min(100, Math.max(1, Math.trunc(opts.limit ?? 20)))
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0))
  let query = summaryQuery(deps).where('documents.deleted_at', 'is', null)
  if (opts.type !== undefined) query = query.where('documents.type', '=', opts.type)
  if (opts.locale !== undefined) query = query.where('documents.locale', '=', opts.locale)
  const rows = await query.execute()
  const typeOrder = [...registry.site.singletons, ...registry.site.globals, ...registry.site.collections].map((d) => d.name)
  const rank = (type: string) => {
    const i = typeOrder.indexOf(type)
    return i === -1 ? typeOrder.length : i
  }
  const found: Array<{ document: DocumentSummary; matches: FieldMatch[] }> = []
  for (const row of rows) {
    const data = parseData(deps, row.type, row.head_data)
    const matches = fieldMatches(foundFields(deps, row.type, data), data, text)
    if (matches.length > 0) found.push({ document: toSummary(deps, row), matches })
  }
  found.sort(
    (a, b) =>
      rank(a.document.type) - rank(b.document.type) ||
      registry.locales.indexOf(a.document.locale) - registry.locales.indexOf(b.document.locale) ||
      b.document.headRev - a.document.headRev,
  )
  return { total: found.length, documents: found.slice(offset, offset + limit), designedInCode: designed() }
}
