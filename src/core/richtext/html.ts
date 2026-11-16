import { escapeHtml } from '../../jsx/html.js'
import { isRichTextHref, type RichTextDoc, type RichTextInline, type RichTextMark, type RichTextNode } from './schema.js'

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
function inline(nodes: RichTextInline[], resolve: RichTextResolver): string {
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

function block(node: RichTextNode, resolve: RichTextResolver): string {
  const children = (nodes: RichTextNode[] | undefined) => (nodes ?? []).map((n) => block(n, resolve)).join('')
  switch (node.type) {
    case 'paragraph':
      return `<p>${inline(node.content ?? [], resolve)}</p>`
    case 'heading': {
      const level = node.attrs.level
      const tag = Number.isInteger(level) && level >= 1 && level <= 6 ? `h${level}` : 'p'
      return `<${tag}>${inline(node.content ?? [], resolve)}</${tag}>`
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
    default:
      return inline([node], resolve)
  }
}

/** The doc as HTML. Every text and attribute is escaped; only Inlay's own tags are emitted. */
export function richTextToHtml(doc: RichTextDoc, resolve: RichTextResolver): string {
  return doc.content.map((node) => block(node, resolve)).join('')
}
