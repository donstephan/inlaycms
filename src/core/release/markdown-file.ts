import { pathToFileURL } from 'node:url'
import MarkdownIt from 'markdown-it'
import { imageTarget } from '../content/shipped-images.js'
import { markdownDestination } from '../richtext/markdown.js'

/**
 * Where an image sits in the inline content it was read from: `start` is its `!`, and `dest` its target as written
 * (`start` to `end`) and as read (`src`), when it has one. `inline` is false for a reference-style image.
 */
interface ImageMeta {
  start: number
  inline: boolean
  dest: { start: number; end: number; src: string } | null
}

/** Reads the way `markdownToRichText` does, with each image's place in the source kept on its token's `meta`. */
const reader = new MarkdownIt('commonmark', { html: false, linkify: false, typographer: false }).enable('table')
reader.validateLink = () => true
reader.normalizeLink = (url) => url
reader.normalizeLinkText = (url) => url

const imageRule = reader.inline.ruler.getRules('').find((rule) => rule.name === 'image')
if (imageRule) {
  reader.inline.ruler.at('image', (state, silent) => {
    const start = state.pos
    if (silent || state.src.charCodeAt(start) !== 0x21 /* ! */) return imageRule(state, silent)
    const labelEnd = state.md.helpers.parseLinkLabel(state, start + 1, false)
    const inline = labelEnd >= 0 && state.src.charCodeAt(labelEnd + 1) === 0x28 /* ( */
    let dest: ImageMeta['dest'] = null
    if (inline) {
      let pos = labelEnd + 2
      while (pos < state.posMax) {
        const code = state.src.charCodeAt(pos)
        if (!state.md.utils.isSpace(code) && code !== 0x0a) break
        pos++
      }
      const res = state.md.helpers.parseLinkDestination(state.src, pos, state.posMax)
      if (res.ok) dest = { start: pos, end: res.pos, src: res.str }
    }
    if (!imageRule(state, silent)) return false
    const token = state.tokens[state.tokens.length - 1]
    if (token?.type === 'image') token.meta = { start, inline, dest } satisfies ImageMeta
    return true
  })
}

/** True if `src` names a file by a path relative to where it is written, by `imageTarget`'s rules. */
function isRelative(src: string): boolean {
  return src !== '' && !/^file:/i.test(src) && imageTarget(src, null).kind === 'outside'
}

/**
 * The inline content of each block, with the source line (from 0) it starts on and its images. `escapedPipe` is true
 * for a table cell on a line with an escaped pipe (`\|`), which markdown-it reads without its backslash.
 */
function inlineBlocks(text: string): Array<{ line: number; content: string; images: ImageMeta[]; escapedPipe: boolean }> {
  const blocks: Array<{ line: number; content: string; images: ImageMeta[]; escapedPipe: boolean }> = []
  const lines = text.split(/\r\n?|\n/)
  // A table cell's inline content has no lines of its own: it sits on its row's line.
  let line = 0
  let cell = false
  for (const tok of reader.parse(text, {})) {
    if (tok.map) line = tok.map[0]
    if (tok.type === 'td_open' || tok.type === 'th_open') cell = true
    if (tok.type === 'td_close' || tok.type === 'th_close') cell = false
    if (tok.type !== 'inline') continue
    const images = (tok.children ?? []).flatMap((child) => (child.type === 'image' && child.meta ? [child.meta as ImageMeta] : []))
    blocks.push({ line, content: tok.content, images, escapedPipe: cell && (lines[line] ?? '').includes('\\|') })
  }
  return blocks
}

/** How many lines into `content` the offset `at` is. */
function lineIndex(content: string, at: number): number {
  let k = 0
  for (let i = content.indexOf('\n'); i !== -1 && i < at; i = content.indexOf('\n', i + 1)) k++
  return k
}

/**
 * `text` with each inline image target for which `to` gives a new target rewritten to it, everything else, line
 * endings included, left as written, and every line where it was. `references` lists the line (from 1) of each
 * reference-style image (`![alt][name]`, `![alt][]`, `![alt]`), which is never rewritten. `unplaced` lists each
 * image `to` gave a new target for but whose place in the source couldn't be found, so it was left as written.
 */
function rewriteTargets(
  text: string,
  to: (src: string) => string | null,
): { text: string; references: number[]; unplaced: Array<{ line: number; escapedPipe: boolean }> } {
  const blocks = inlineBlocks(text)
  // Lines at even indexes, each followed by the line ending it had.
  const parts = text.split(/(\r\n?|\n)/)
  const references: number[] = []
  const unplaced: Array<{ line: number; escapedPipe: boolean }> = []
  for (const block of blocks) {
    for (const image of block.images) {
      if (!image.inline) references.push(block.line + lineIndex(block.content, image.start) + 1)
    }
  }

  // Cells of one table row share a line: going right to left, each is looked for before the one after it.
  const bound = new Map<number, number>()
  const edits = new Map<number, Array<{ from: number; to: number; text: string }>>()
  for (let b = blocks.length - 1; b >= 0; b--) {
    const block = blocks[b]
    if (block === undefined) continue
    const contentLines = block.content.split('\n')
    // Where each line of the content starts in the source line, as an offset; null when it isn't found. A tab past a
    // list item's indent reaches the content as spaces, so a line not found as it is is looked for without them.
    const columns = contentLines.map((contentLine, k): number | null => {
      const n = block.line + k
      const source = parts[2 * n]
      if (source === undefined) return null
      const limit = bound.get(n)
      const find = (s: string) =>
        limit === undefined ? source.lastIndexOf(s) : limit < s.length ? -1 : source.lastIndexOf(s, limit - s.length)
      let at = find(contentLine)
      let stripped = 0
      if (at === -1) {
        const trimmed = contentLine.trimStart()
        stripped = contentLine.length - trimmed.length
        if (stripped > 0 && trimmed !== '') at = find(trimmed)
      }
      if (at === -1) return null
      bound.set(n, at)
      return at - stripped
    })
    for (const image of block.images) {
      const dest = image.dest
      const target = dest === null ? null : to(dest.src)
      if (dest === null || target === null) continue
      const k = lineIndex(block.content, dest.start)
      const n = block.line + k
      const column = columns[k] ?? null
      const lineStart = k === 0 ? 0 : block.content.lastIndexOf('\n', dest.start - 1) + 1
      const from = column === null ? -1 : column + dest.start - lineStart
      const end = column === null ? -1 : column + dest.end - lineStart
      if (from < 0 || parts[2 * n]?.slice(from, end) !== block.content.slice(dest.start, dest.end)) {
        unplaced.push({ line: block.line + lineIndex(block.content, image.start) + 1, escapedPipe: block.escapedPipe })
        continue
      }
      const list = edits.get(n) ?? []
      list.push({ from, to: end, text: markdownDestination(target) })
      edits.set(n, list)
    }
  }

  for (const [n, list] of edits) {
    let source = parts[2 * n] ?? ''
    for (const edit of list.sort((a, b) => b.from - a.from)) {
      source = source.slice(0, edit.from) + edit.text + source.slice(edit.to)
    }
    parts[2 * n] = source
  }
  return { text: parts.join(''), references, unplaced: unplaced.sort((a, b) => a.line - b.line) }
}

/**
 * The Markdown file `text`, read from `file`, with each relative inline image target rewritten to the `file:` URL it
 * names from the file's own folder, so the image resolves the same once the text is bundled. Everything else, line
 * endings included, is left as written, and every line stays where it was. `references` lists the line (from 1) of
 * each reference-style image, which is never resolved. `unplaced` lists the line (from 1) of each relative image
 * whose place in the source can't be found (a line with a NUL character, say), left as written; one in a table cell
 * with an escaped pipe isn't listed, since such a cell is refused when the text is read as rich text.
 */
export function rewriteImageTargets(text: string, file: string): { text: string; references: number[]; unplaced: number[] } {
  const base = pathToFileURL(file)
  const result = rewriteTargets(text, (src) => (isRelative(src) ? new URL(src, base).href : null))
  const unplaced = result.unplaced.filter((u) => !u.escapedPipe).map((u) => u.line)
  return { text: result.text, references: result.references, unplaced }
}

/**
 * `markdown` with each inline image target for which `to` gives a new target rewritten to it, the way
 * `rewriteImageTargets` rewrites them. `complete` is false if one of them couldn't be placed and was left as written.
 */
export function replaceImageTargets(markdown: string, to: (src: string) => string | null): { text: string; complete: boolean } {
  const result = rewriteTargets(markdown, to)
  return { text: result.text, complete: result.unplaced.length === 0 }
}
