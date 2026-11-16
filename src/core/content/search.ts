import { fieldValues } from '../fields/walk.js'
import { richTextText, type RichTextDoc } from '../richtext/schema.js'
import type { CoreDeps, DocumentSummary } from '../types.js'
import { documentSchema } from './schema.js'
import { parseData, summaryQuery, toSummary } from './read.js'

const KINDS: ReadonlySet<string> = new Set(['text', 'textarea', 'richText'])
const SNIPPET = 160

/** Lower-cased text without accents, with each normalized character's index in the original. */
function fold(text: string): { text: string; index: number[] } {
  let out = ''
  const index: number[] = []
  let i = 0
  for (const ch of text) {
    for (const c of ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()) {
      out += c
      index.push(i)
    }
    i += ch.length
  }
  return { text: out, index }
}

const normalize = (text: string) => fold(text).text

function snippetOf(body: string, words: string[]): string {
  if (words.length === 0) return ''
  const folded = fold(body)
  let at = -1
  for (const word of words) {
    const pos = folded.text.indexOf(word)
    if (pos !== -1 && (at === -1 || pos < at)) at = pos
  }
  if (at === -1) return ''
  const center = folded.index[at] ?? 0
  const start = Math.max(0, center - Math.floor(SNIPPET / 2))
  return body.slice(start, start + SNIPPET).trim()
}

export async function findEntry(
  deps: CoreDeps,
  type: string,
  slug: string,
  locale?: string,
): Promise<DocumentSummary | null> {
  deps.registry.getType(type)
  const row = await summaryQuery(deps)
    .where('documents.type', '=', type)
    .where('documents.kind', '=', 'entry')
    .where('documents.locale', '=', locale ?? deps.registry.defaultLocale)
    .where('documents.head_slug', '=', slug)
    .where('documents.deleted_at', 'is', null)
    .executeTakeFirst()
  return row ? toSummary(deps, row) : null
}

export async function searchEntries(
  deps: CoreDeps,
  type: string,
  query: string,
  opts: { locale?: string; limit?: number } = {},
): Promise<Array<DocumentSummary & { snippet: string }>> {
  deps.registry.getType(type)
  const limit = Math.min(50, Math.max(1, Math.trunc(opts.limit ?? 10)))
  const words = normalize(query).split(/\s+/).filter((w) => w !== '')
  const rows = await summaryQuery(deps)
    .where('documents.type', '=', type)
    .where('documents.kind', '=', 'entry')
    .where('documents.locale', '=', opts.locale ?? deps.registry.defaultLocale)
    .where('documents.deleted_at', 'is', null)
    .orderBy('documents.head_rev', 'desc')
    .execute()
  const schema = documentSchema(deps.registry, type, 'strict')
  const hits: Array<{ doc: DocumentSummary; titleHit: boolean; snippet: string }> = []
  for (const row of rows) {
    const doc = toSummary(deps, row)
    if (words.length === 0) {
      hits.push({ doc, titleHit: false, snippet: '' })
      continue
    }
    const data = parseData(deps, row.type, row.head_data)
    const parts: string[] = []
    for (const found of fieldValues(schema, data, KINDS)) {
      if (found.meta.kind === 'richText') {
        if (typeof found.value === 'object' && found.value !== null) parts.push(richTextText(found.value as RichTextDoc))
      } else if (typeof found.value === 'string') {
        parts.push(found.value)
      }
    }
    const body = parts.join('\n')
    const title = normalize(doc.title)
    const haystack = `${title}\n${normalize(body)}`
    if (!words.every((w) => haystack.includes(w))) continue
    hits.push({ doc, titleHit: words.some((w) => title.includes(w)), snippet: snippetOf(body, words) })
  }
  // Rows are already newest first and the sort is stable.
  hits.sort((a, b) => Number(b.titleHit) - Number(a.titleHit))
  return hits.slice(0, limit).map((h) => ({ ...h.doc, snippet: h.snippet }))
}
