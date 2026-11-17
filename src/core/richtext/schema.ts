import { Schema } from 'prosemirror-model'
import { z } from 'zod'
import { isSafeUrl } from '../fields/define.js'
import { isRecord } from '../fields/zod-internals.js'
import type { ContentRef } from '../types.js'

export const RICH_TEXT_FEATURES = [
  'heading',
  'bold',
  'italic',
  'link',
  'bulletList',
  'orderedList',
  'blockquote',
  'image',
  'hardBreak',
  'table',
] as const

export type RichTextFeature = (typeof RICH_TEXT_FEATURES)[number]

export interface RichTextOptions {
  features: readonly RichTextFeature[]
  headings: readonly number[]
}

export const DEFAULT_RICH_TEXT: RichTextOptions = { features: RICH_TEXT_FEATURES, headings: [2, 3, 4] }

export type RichTextMark =
  | { type: 'link'; attrs: { href: string } | { document: string } }
  | { type: 'bold' }
  | { type: 'italic' }

export type RichTextText = { type: 'text'; text: string; marks?: RichTextMark[] }
export type RichTextHardBreak = { type: 'hardBreak'; marks?: RichTextMark[] }
export type RichTextImage = { type: 'image'; attrs: { media: string; alt?: string }; marks?: RichTextMark[] }
export type RichTextInline = RichTextText | RichTextHardBreak | RichTextImage

export type RichTextParagraph = { type: 'paragraph'; content?: RichTextInline[] }
export type RichTextHeading = { type: 'heading'; attrs: { level: number }; content?: RichTextText[] }
export type RichTextListItem = { type: 'listItem'; content: [RichTextParagraph, ...RichTextBlock[]] }
export type RichTextBulletList = { type: 'bulletList'; content: RichTextListItem[] }
export type RichTextOrderedList = { type: 'orderedList'; attrs?: { start: number }; content: RichTextListItem[] }
export type RichTextBlockquote = { type: 'blockquote'; content: RichTextBlock[] }
export type RichTextTableCell = { type: 'tableHeader' | 'tableCell'; content: [RichTextParagraph] }
export type RichTextTableRow = { type: 'tableRow'; content: RichTextTableCell[] }
export type RichTextTable = { type: 'table'; content: RichTextTableRow[] }
export type RichTextBlock =
  | RichTextParagraph
  | RichTextHeading
  | RichTextBulletList
  | RichTextOrderedList
  | RichTextBlockquote
  | RichTextTable

export type RichTextNode =
  | RichTextBlock
  | RichTextListItem
  | RichTextTableRow
  | RichTextTableCell
  | RichTextInline

export type RichTextDoc = { type: 'doc'; content: RichTextNode[] }

/** Tiptap's node and mark names. The mark order is the canonical order of marks on a node. */
export const richTextSchema = new Schema({
  nodes: {
    doc: { content: 'block*' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'text*', attrs: { level: {} } },
    bulletList: { group: 'block', content: 'listItem+' },
    orderedList: { group: 'block', content: 'listItem+', attrs: { start: { default: 1 } } },
    listItem: { content: 'paragraph block*' },
    blockquote: { group: 'block', content: 'block+' },
    table: { group: 'block', content: 'tableRow+' },
    tableRow: { content: '(tableHeader | tableCell)+' },
    tableHeader: { content: 'paragraph' },
    tableCell: { content: 'paragraph' },
    text: { group: 'inline' },
    hardBreak: { group: 'inline', inline: true },
    image: { group: 'inline', inline: true, attrs: { media: {}, alt: { default: null } } },
  },
  marks: {
    link: { attrs: { href: { default: null }, document: { default: null } }, inclusive: false },
    bold: {},
    italic: {},
  },
})

const NODE_FEATURE: Readonly<Record<string, RichTextFeature>> = {
  heading: 'heading',
  bulletList: 'bulletList',
  orderedList: 'orderedList',
  blockquote: 'blockquote',
  image: 'image',
  hardBreak: 'hardBreak',
  table: 'table',
}
const LEAVES = new Set(['text', 'hardBreak', 'image'])
const HEX64 = /^[0-9a-f]{64}$/
const UUID = z.uuid()

type Json = Record<string, unknown>

class Rejected extends Error {}

function reject(): never {
  throw new Rejected()
}

const absent = (v: unknown): v is null | undefined => v === undefined || v === null

function attrsOf(raw: Json): Json {
  if (absent(raw.attrs)) return {}
  return isRecord(raw.attrs) ? raw.attrs : reject()
}

/**
 * A link address rich text can hold: a safe URL without control characters, which
 * Markdown can't carry and so wouldn't read back.
 */
export function isRichTextHref(href: string): boolean {
  // eslint-disable-next-line no-control-regex
  return isSafeUrl(href) && !/[\u0000-\u001f\u007f]/.test(href)
}

function cleanMark(raw: unknown, opts: RichTextOptions): Json {
  if (!isRecord(raw) || typeof raw.type !== 'string') reject()
  const type = raw.type
  if (!Object.hasOwn(richTextSchema.marks, type)) reject()
  if (!opts.features.includes(type as RichTextFeature)) reject()
  if (type !== 'link') return { type }
  const { href, document } = attrsOf(raw)
  if (absent(href) === absent(document)) reject()
  if (!absent(href)) {
    if (typeof href !== 'string' || !isRichTextHref(href)) reject()
    return { type, attrs: { href } }
  }
  if (typeof document !== 'string' || !UUID.safeParse(document).success) reject()
  return { type, attrs: { document } }
}

function cleanAttrs(type: string, raw: Json, opts: RichTextOptions): Json | undefined {
  const attrs = attrsOf(raw)
  if (type === 'heading') {
    if (typeof attrs.level !== 'number' || !opts.headings.includes(attrs.level)) reject()
    return { level: attrs.level }
  }
  if (type === 'orderedList') {
    const start = attrs.start ?? 1
    if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) reject()
    return start === 1 ? undefined : { start }
  }
  if (type === 'image') {
    const { media, alt } = attrs
    if (typeof media !== 'string' || !HEX64.test(media)) reject()
    if (!absent(alt) && typeof alt !== 'string') reject()
    return typeof alt === 'string' && alt !== '' ? { media, alt } : { media }
  }
  return undefined
}

/** The node with its attrs, marks and text cleaned, or `null` if it is dropped. */
function cleanNode(raw: unknown, opts: RichTextOptions): Json | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') reject()
  const type = raw.type
  if (type === 'doc' || !Object.hasOwn(richTextSchema.nodes, type)) reject()
  const feature = NODE_FEATURE[type]
  if (feature !== undefined && !opts.features.includes(feature)) reject()
  const out: Json = { type }
  const attrs = cleanAttrs(type, raw, opts)
  if (attrs) out.attrs = attrs
  if (!absent(raw.marks)) {
    if (!Array.isArray(raw.marks)) reject()
    if (raw.marks.length > 0) out.marks = raw.marks.map((m) => cleanMark(m, opts))
  }
  if (type === 'text') {
    if (typeof raw.text !== 'string') reject()
    const text = raw.text.replace(/\r\n?|\n/g, ' ')
    if (text === '') return null
    out.text = text
    return out
  }
  if (LEAVES.has(type)) {
    if (!absent(raw.content) && !(Array.isArray(raw.content) && raw.content.length === 0)) reject()
    return out
  }
  const content = cleanContent(raw.content, type, opts)
  // A line break at the end of a paragraph shows nothing, and Markdown can't hold one.
  if (type === 'paragraph') while (content.length > 0 && content[content.length - 1]?.type === 'hardBreak') content.pop()
  if (content.length > 0) out.content = content
  return out
}

/** A cell: one paragraph, several joined with a space; no image or line break. */
function cleanCell(raw: unknown, type: string, opts: RichTextOptions): Json {
  if (!isRecord(raw) || (raw.type !== 'tableHeader' && raw.type !== 'tableCell')) reject()
  if (absent(raw.content)) return { type, content: [{ type: 'paragraph' }] }
  if (!Array.isArray(raw.content)) reject()
  const inline: Json[] = []
  for (const child of raw.content) {
    if (!isRecord(child) || child.type !== 'paragraph') reject()
    if (!absent(child.marks)) reject()
    if (absent(child.content)) continue
    if (!Array.isArray(child.content)) reject()
    const part: Json[] = []
    for (const item of child.content) {
      if (isRecord(item) && (item.type === 'image' || item.type === 'hardBreak')) reject()
      const node = cleanNode(item, opts)
      if (node !== null) part.push(node)
    }
    if (part.length === 0) continue
    if (inline.length > 0) inline.push({ type: 'text', text: ' ' })
    inline.push(...part)
  }
  return { type, content: [inline.length > 0 ? { type: 'paragraph', content: inline } : { type: 'paragraph' }] }
}

/** A table whose first row is its header and whose rows all have the header's width, or `null` if it has no cells. */
function cleanTable(raw: Json, parent: string, opts: RichTextOptions): Json | null {
  if (parent !== 'doc' || !opts.features.includes('table')) reject()
  if (absent(raw.content)) return null
  if (!Array.isArray(raw.content)) reject()
  const rows: unknown[][] = raw.content.map((row) => {
    if (!isRecord(row) || row.type !== 'tableRow') reject()
    if (absent(row.content)) return []
    return Array.isArray(row.content) ? row.content : reject()
  })
  const width = rows[0]?.length ?? 0
  if (width === 0) return null
  const content = rows.map((cells, r) => {
    const type = r === 0 ? 'tableHeader' : 'tableCell'
    const padded: Json[] = cells.slice(0, width).map((c) => cleanCell(c, type, opts))
    while (padded.length < width) padded.push({ type, content: [{ type: 'paragraph' }] })
    return { type: 'tableRow', content: padded }
  })
  return { type: 'table', content }
}

/**
 * Empty paragraphs (including ones left empty once trailing line breaks are dropped) are
 * dropped, except a list item's first; so are blockquotes left empty.
 */
function cleanContent(raw: unknown, parent: string, opts: RichTextOptions): Json[] {
  if (absent(raw)) return []
  if (!Array.isArray(raw)) reject()
  const out: Json[] = []
  for (const child of raw) {
    const node = isRecord(child) && child.type === 'table' ? cleanTable(child, parent, opts) : cleanNode(child, opts)
    if (node === null) continue
    const empty = node.content === undefined
    if (empty && node.type === 'paragraph' && !(parent === 'listItem' && out.length === 0)) continue
    if (empty && node.type === 'blockquote') continue
    out.push(node)
  }
  return out
}

/** ProseMirror's JSON without `null` and default attrs, in fresh objects. */
function stripDefaults(json: Json): Json {
  const out: Json = { type: json.type }
  if (isRecord(json.attrs)) {
    const attrs: Json = {}
    for (const [key, value] of Object.entries(json.attrs)) {
      if (value === null || (json.type === 'orderedList' && key === 'start' && value === 1)) continue
      attrs[key] = value
    }
    if (Object.keys(attrs).length > 0) out.attrs = attrs
  }
  if (Array.isArray(json.content)) out.content = json.content.map((c) => stripDefaults(c as Json))
  if (typeof json.text === 'string') out.text = json.text
  if (Array.isArray(json.marks)) out.marks = json.marks.map((m) => stripDefaults(m as Json))
  return out
}

/**
 * Validates `value` as a rich text doc allowed by `opts` and returns it
 * normalized (see Decision 7 of the Phase 3 plan), or `{ ok: false }`.
 */
export function parseRichText(
  value: unknown,
  opts: RichTextOptions,
): { ok: true; doc: RichTextDoc } | { ok: false } {
  try {
    if (!isRecord(value) || value.type !== 'doc') return { ok: false }
    const content = cleanContent(value.content, 'doc', opts)
    const node = richTextSchema.nodeFromJSON({ type: 'doc', content })
    node.check()
    const json = stripDefaults(node.toJSON() as Json)
    return { ok: true, doc: { type: 'doc', content: (json.content ?? []) as RichTextNode[] } }
  } catch (e) {
    if (e instanceof Rejected || e instanceof RangeError) return { ok: false }
    throw e
  }
}

const childrenOf = (node: unknown): unknown[] =>
  isRecord(node) && Array.isArray(node.content) ? node.content : []

function inlineText(node: unknown): string {
  return childrenOf(node)
    .map((c) => {
      if (!isRecord(c)) return ''
      if (c.type === 'text' && typeof c.text === 'string') return c.text
      return c.type === 'hardBreak' ? '\n' : ''
    })
    .join('')
}

const inlineCell = (cell: unknown): string => inlineText(childrenOf(cell)[0])

function blockTexts(node: unknown, out: string[]): string[] {
  for (const child of childrenOf(node)) {
    if (!isRecord(child)) continue
    if (child.type === 'paragraph' || child.type === 'heading') out.push(inlineText(child))
    else if (child.type === 'tableRow') out.push(childrenOf(child).map(inlineCell).join('\t'))
    else blockTexts(child, out)
  }
  return out
}

/** The doc's text: blocks joined by `\n`, a hard break as `\n`, images left out. */
export function richTextText(doc: RichTextDoc): string {
  return blockTexts(doc, []).join('\n')
}

/** True if the doc has no non-whitespace text and no image. */
export function richTextIsBlank(doc: RichTextDoc): boolean {
  const filled = (node: unknown): boolean =>
    isRecord(node) &&
    ((node.type === 'text' && typeof node.text === 'string' && node.text.trim() !== '') ||
      node.type === 'image' ||
      childrenOf(node).some(filled))
  return !filled(doc)
}

/** `media` refs for images and `document` refs for internal links, in document order. */
export function richTextRefs(doc: RichTextDoc): ContentRef[] {
  const out = new Map<string, ContentRef>()
  const add = (ref: ContentRef) => out.set(`${ref.kind}:${ref.id}`, ref)
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (isRecord(mark) && mark.type === 'link' && isRecord(mark.attrs) && typeof mark.attrs.document === 'string') {
          add({ kind: 'document', id: mark.attrs.document })
        }
      }
    }
    if (node.type === 'image' && isRecord(node.attrs) && typeof node.attrs.media === 'string') {
      add({ kind: 'media', id: node.attrs.media })
    }
    childrenOf(node).forEach(visit)
  }
  visit(doc)
  return [...out.values()]
}
