import type { RichTextDoc, RichTextNode } from './schema.js'

export interface RichTextHeading {
  level: number
  text: string
  id: string
}

function slug(text: string): string {
  const s = text
    .normalize('NFC')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{M}\p{N}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return s === '' ? 'section' : s
}

/** The doc's headings in document order, with the ids `ctx.richText(doc, { headingIds })` gives them. */
export function richTextHeadings(doc: RichTextDoc | null | undefined, opts: { prefix?: string } = {}): RichTextHeading[] {
  const out: RichTextHeading[] = []
  if (!doc) return out
  const prefix = opts.prefix ?? ''
  const used = new Set<string>()
  const walk = (nodes: readonly RichTextNode[] | undefined) => {
    for (const node of nodes ?? []) {
      if (node.type === 'heading') {
        const text = (node.content ?? []).map((n) => (n.type === 'text' ? n.text : '')).join('')
        const base = prefix + slug(text)
        let id = base
        for (let n = 2; used.has(id); n++) id = `${base}-${n}`
        used.add(id)
        out.push({ level: node.attrs.level, text, id })
      } else if (node.type === 'blockquote' || node.type === 'bulletList' || node.type === 'orderedList' || node.type === 'listItem') {
        walk(node.content)
      }
    }
  }
  walk(doc.content)
  return out
}
