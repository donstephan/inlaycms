import { escapeHtml, SafeHtml } from '../../jsx/html.js'
import { richTextHeadings } from './headings.js'
import { isRichTextHref, type RichTextDoc, type RichTextInline, type RichTextMark, type RichTextNode, type RichTextTableRow } from './schema.js'

export interface RichTextImageHtml {
  src: string
  srcset: string
  alt: string
  width: number | null
  height: number | null
}

export interface RichTextResolver {
  /** The encoded `href` of a document's page, or `null` if it has none. */
  link(groupId: string): string | null
  image(id: string, alt: string | undefined): RichTextImageHtml | null
}

/** Highlights code: the inside of `<code>` as `SafeHtml`, or `null` to leave it plain. */
export type CodeHighlighter = (code: string, language: string | undefined) => SafeHtml | null

export interface RichTextRenderOptions {
  highlight?: CodeHighlighter
  headingIds?: boolean | { prefix: string }
}

type OpenMark = { key: string; open: string; close: string }

function attr(name: string, value: string | number | null): string {
  return value === null || value === '' ? '' : ` ${name}="${escapeHtml(String(value))}"`
}

/** The marks as tags, in stored (canonical) order; internal links that can't be resolved are dropped. */
function marksOf(marks: RichTextMark[] | undefined, resolve: RichTextResolver): OpenMark[] {
  const out: OpenMark[] = []
  for (const mark of marks ?? []) {
    if (mark.type === 'bold') out.push({ key: 'b', open: '<strong>', close: '</strong>' })
    else if (mark.type === 'italic') out.push({ key: 'i', open: '<em>', close: '</em>' })
    else if (mark.type === 'code') out.push({ key: 'c', open: '<code>', close: '</code>' })
    else {
      const href = 'href' in mark.attrs ? mark.attrs.href : resolve.link(mark.attrs.document)
      if (href === null || ('href' in mark.attrs && !isRichTextHref(href))) continue
      out.push({ key: `a:${href}`, open: `<a href="${escapeHtml(href)}">`, close: '</a>' })
    }
  }
  return out
}

function leaf(node: RichTextInline, resolve: RichTextResolver): string {
  if (node.type === 'text') return escapeHtml(node.text)
  if (node.type === 'hardBreak') return '<br>'
  const img = resolve.image(node.attrs.media, node.attrs.alt)
  if (!img) return ''
  return (
    `<img${attr('src', img.src)}${attr('srcset', img.srcset)} alt="${escapeHtml(img.alt)}"` +
    `${attr('width', img.width)}${attr('height', img.height)} loading="lazy">`
  )
}

/** Inline content, keeping a mark open across neighbors that share it. */
export function richTextInlineHtml(nodes: RichTextInline[], resolve: RichTextResolver): string {
  let out = ''
  let open: OpenMark[] = []
  for (const node of nodes) {
    const marks = marksOf(node.marks, resolve)
    let keep = 0
    while (keep < open.length && keep < marks.length && open[keep]!.key === marks[keep]!.key) keep++
    for (let i = open.length - 1; i >= keep; i--) out += open[i]!.close
    for (let i = keep; i < marks.length; i++) out += marks[i]!.open
    open = marks
    out += leaf(node, resolve)
  }
  for (let i = open.length - 1; i >= 0; i--) out += open[i]!.close
  return out
}

type HeadingIds = { ids: string[]; next: number }

function block(node: RichTextNode, resolve: RichTextResolver, opts: RichTextRenderOptions, headings: HeadingIds | null): string {
  const children = (nodes: RichTextNode[] | undefined) => (nodes ?? []).map((n) => block(n, resolve, opts, headings)).join('')
  switch (node.type) {
    case 'paragraph':
      return `<p>${richTextInlineHtml(node.content ?? [], resolve)}</p>`
    case 'heading': {
      const level = node.attrs.level
      const tag = Number.isInteger(level) && level >= 1 && level <= 6 ? `h${level}` : 'p'
      const id = headings ? headings.ids[headings.next++] ?? null : null
      return `<${tag}${attr('id', id)}>${richTextInlineHtml(node.content ?? [], resolve)}</${tag}>`
    }
    case 'bulletList':
      return `<ul>${children(node.content)}</ul>`
    case 'orderedList': {
      const start = node.attrs?.start ?? 1
      return `<ol${start === 1 ? '' : attr('start', start)}>${children(node.content)}</ol>`
    }
    case 'listItem':
      return `<li>${children(node.content)}</li>`
    case 'blockquote':
      return `<blockquote>${children(node.content)}</blockquote>`
    case 'table': {
      const cells = (row: RichTextTableRow, tag: string) =>
        `<tr>${row.content.map((c) => `<${tag}>${richTextInlineHtml(c.content[0].content ?? [], resolve)}</${tag}>`).join('')}</tr>`
      const [head, ...body] = node.content
      return (
        '<table>' +
        (head ? `<thead>${cells(head, 'th')}</thead>` : '') +
        (body.length > 0 ? `<tbody>${body.map((r) => cells(r, 'td')).join('')}</tbody>` : '') +
        '</table>'
      )
    }
    case 'codeBlock': {
      const code = node.content?.[0]?.text ?? ''
      const language = node.attrs?.language
      const out = opts.highlight?.(code, language)
      const inside = out instanceof SafeHtml ? out.value : escapeHtml(out === null || out === undefined ? code : String(out))
      return `<pre><code${attr('class', language ? `language-${language}` : null)}>${inside}</code></pre>`
    }
    case 'tableRow':
    case 'tableHeader':
    case 'tableCell':
      return ''
    default:
      return richTextInlineHtml([node], resolve)
  }
}

/** The doc as HTML. Every text and attribute is escaped; only Inlay's own tags are emitted. */
export function richTextToHtml(doc: RichTextDoc, resolve: RichTextResolver, opts: RichTextRenderOptions = {}): string {
  const ids = opts.headingIds
  const headings = ids ? { ids: richTextHeadings(doc, { prefix: typeof ids === 'object' ? ids.prefix : '' }).map((h) => h.id), next: 0 } : null
  return doc.content.map((node) => block(node, resolve, opts, headings)).join('')
}
