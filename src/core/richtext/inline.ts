import { t } from '../messages/index.js'
import { richTextInlineHtml, type RichTextResolver } from './html.js'
import { blockLines, markdownToRichText, type RichTextProblem } from './markdown.js'
import { parseRichText, type RichTextDoc, type RichTextOptions } from './schema.js'

/** What an inline-text field allows: one paragraph of bold, italic and linked text. */
export const INLINE_TEXT: RichTextOptions = { features: ['bold', 'italic', 'link'], headings: [] }

/** `value` as a normalized inline-text doc: at most one block, and that a paragraph. */
export function parseInlineText(value: unknown): { ok: true; doc: RichTextDoc } | { ok: false } {
  const parsed = parseRichText(value, INLINE_TEXT)
  if (!parsed.ok) return parsed
  const [first, ...rest] = parsed.doc.content
  return rest.length === 0 && (first === undefined || first.type === 'paragraph') ? parsed : { ok: false }
}

/** Reads one line of Markdown into an inline-text doc; a second paragraph is reported at the line it starts on. */
export function markdownToInlineText(
  markdown: string,
): { ok: true; doc: RichTextDoc } | { ok: false; problems: RichTextProblem[] } {
  const result = markdownToRichText(markdown, INLINE_TEXT)
  const second = blockLines(markdown)[1] ?? (result.ok && result.doc.content.length > 1 ? 1 : undefined)
  if (second === undefined) return result
  const paragraphs: RichTextProblem = {
    code: 'not_allowed',
    line: second,
    message: t('richtext.inlineParagraphs', { line: second }),
  }
  const problems = result.ok ? [paragraphs] : [...result.problems, paragraphs].sort((a, b) => a.line - b.line)
  return { ok: false, problems }
}

/** The first top-level paragraph's inline HTML, without its `<p>`; `''` when there is none. */
export function inlineTextToHtml(doc: RichTextDoc, resolve: RichTextResolver): string {
  const first = doc.content.find((node) => node.type === 'paragraph')
  return first?.type === 'paragraph' ? richTextInlineHtml(first.content ?? [], resolve) : ''
}
