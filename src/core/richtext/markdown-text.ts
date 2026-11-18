import { richTextHeadings, type RichTextHeading } from './headings.js'
import { markdownImages, markdownToRichText, type RichTextProblem } from './markdown.js'
import { RICH_TEXT_FEATURES, type RichTextDoc, type RichTextOptions } from './schema.js'

export const MARKDOWN_TEXT_OPTIONS: RichTextOptions = { features: RICH_TEXT_FEATURES, headings: [1, 2, 3, 4, 5, 6] }

/** Stands in for an image whose source isn't known, so parsing never fails on it. */
const PLACEHOLDER_IMAGE = '0'.repeat(64)
/** The start of a Markdown link target `](inlay:key/<type>` or `](inlay:key/<type>/<key>`; text elsewhere is left alone. */
export const KEY_HREF = /\]\(inlay:key\/([\w-]+)(?:\/([\w-]+))?(?=[\s)])/g

/** A document that never resolves: a link to it shows as plain text. */
export const NO_DOCUMENT = '00000000-0000-0000-0000-000000000000'
const MEDIA_TARGET = /^inlay:media\/[0-9a-f]{64}$/

/** The picture files Markdown in templates may name, by extension, with the type each must hold. No SVG. */
export const MARKDOWN_IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
}

/** True if `src` names a media library image (`inlay:media/<id>`). */
export function isMediaTarget(src: string): boolean {
  return MEDIA_TARGET.test(src)
}

/** Reads a template's Markdown text with every rich text feature and heading levels 1 to 6. */
export function parseMarkdownText(
  text: string,
  images: ReadonlyMap<string, string> = new Map(),
): { ok: true; doc: RichTextDoc } | { ok: false; problems: RichTextProblem[] } {
  const mapped = new Map(images)
  for (const { src } of markdownImages(text)) {
    if (!mapped.has(src) && !isMediaTarget(src)) mapped.set(src, PLACEHOLDER_IMAGE)
  }
  return markdownToRichText(text.replace(KEY_HREF, `](inlay:document/${NO_DOCUMENT}`), MARKDOWN_TEXT_OPTIONS, { images: mapped })
}

/** The headings of Markdown text, with the ids `ctx.markdown` gives them, or none when it doesn't read. */
export function markdownHeadings(text: string, opts: { prefix?: string } = {}): RichTextHeading[] {
  const parsed = parseMarkdownText(text)
  return parsed.ok ? richTextHeadings(parsed.doc, opts) : []
}
