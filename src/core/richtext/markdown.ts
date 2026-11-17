import MarkdownIt from 'markdown-it'
import type { Token } from 'markdown-it'
import { Fragment, Mark, type Node as PMNode } from 'prosemirror-model'
import { MarkdownParser, MarkdownSerializerState, type MarkdownSerializer } from 'prosemirror-markdown'
import { z } from 'zod'
import { t, type MessageId } from '../messages/index.js'
import {
  DEFAULT_RICH_TEXT,
  isRichTextHref,
  parseRichText,
  richTextSchema,
  type RichTextDoc,
  type RichTextFeature,
  type RichTextOptions,
} from './schema.js'

export interface RichTextProblem {
  code: 'not_allowed' | 'unsupported' | 'heading_level' | 'image_source' | 'link_url'
  line: number
  message: string
}

const DOCUMENT_PREFIX = 'inlay:document/'
const MEDIA_PREFIX = 'inlay:media/'
const HEX64 = /^[0-9a-f]{64}$/
const UUID = z.uuid()

// ---------------------------------------------------------------------------
// Rich text → Markdown

type MarkSerializerSpec = ConstructorParameters<typeof MarkdownSerializer>[1][string]
type Serializer = (state: State, node: PMNode, parent: PMNode, index: number) => void

/**
 * Private-use stand-ins for bold and italic delimiters. Once a block is written,
 * `placeDelimiters` swaps them for `*` or `_` runs that read back as the same marks.
 */
const OPEN_BOLD = '\uE000'
const CLOSE_BOLD = '\uE001'
const OPEN_ITALIC = '\uE002'
const CLOSE_ITALIC = '\uE003'
/** Stands in for a code span while a block's bold and italic are placed, so they never touch its text. */
const CODE = '\uE004'
const STAND_INS = /[\uE000-\uE004]/g

const STAND_IN: Readonly<Record<string, { count: number; open: boolean }>> = {
  [OPEN_BOLD]: { count: 2, open: true },
  [CLOSE_BOLD]: { count: 2, open: false },
  [OPEN_ITALIC]: { count: 1, open: true },
  [CLOSE_ITALIC]: { count: 1, open: false },
}

const MAX_MARKERS = 512
const MARKER_CHAR = /[ \t>\-*+#0-9.)\uE000-\uE003]/

/**
 * True if the last line of `out` is only block markers (quote, bullet, number of up to
 * nine digits, heading of up to six `#`, emphasis) and spaces: nothing the editor typed.
 * A plain scanner, so long runs of `#` or digits can't make it slow.
 */
function atLineStart(out: string): boolean {
  let start = out.length
  while (start > 0 && out[start - 1] !== '\n') {
    // Markers nested as deep as Markdown is read are far shorter; a longer run includes text.
    if (!MARKER_CHAR.test(out[start - 1]!) || out.length - start > MAX_MARKERS) return false
    start--
  }
  let i = start
  const end = out.length
  const digit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9'
  while (i < end) {
    const c = out[i]!
    if (c === ' ' || c === '\t' || c === '>' || c === '-' || c === '*' || c === '+' || (c >= '\uE000' && c <= '\uE003')) {
      i++
    } else if (c === '#') {
      let j = i
      while (out[j] === '#') j++
      if (j - i > 6) return false
      i = j
    } else if (digit(c)) {
      let j = i
      while (digit(out[j])) j++
      if (j - i > 9 || (out[j] !== '.' && out[j] !== ')')) return false
      i = j + 1
    } else {
      return false
    }
  }
  return true
}

/** Characters as numeric character references, which read back as themselves. */
const encodeChars = (s: string) => Array.from(s, (c) => `&#${c.codePointAt(0)};`).join('')

/**
 * URL as a link destination: `<…>` when it has spaces or brackets, escaped so markdown-it gives it back unchanged.
 * Stand-in characters are written as character references, so they can't be taken for formatting.
 */
export function markdownDestination(url: string): string {
  const entity = /&(?=#?[0-9A-Za-z]+;)/g
  if (/[\s()<>]/.test(url)) return '<' + url.replace(/[\\<>]/g, '\\$&').replace(entity, '\\&').replace(STAND_INS, encodeChars) + '>'
  return url.replace(/\\/g, '\\\\').replace(entity, '\\&').replace(STAND_INS, encodeChars)
}

/**
 * Text as a CommonMark code span: fenced by one more backtick than its longest run of them, and padded with a space
 * on each side where reading it back would otherwise take a backtick for the fence or trim a space.
 */
function codeSpan(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  const fence = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text))
  return pad ? `${fence} ${text} ${fence}` : fence + text + fence
}

/** Text with each line break, and the whitespace around it, turned into one space. */
function oneLine(s: string): string {
  if (!/[\r\n]/.test(s)) return s
  const lines = s.split(/[\r\n]+/)
  const last = lines.length - 1
  return lines
    .map((line, i) => (i === 0 ? line.trimEnd() : i === last ? line.trimStart() : line.trim()))
    .filter((line, i) => line !== '' || i === 0 || i === last)
    .join(' ')
}

/** Count of directly preceding siblings of the same type, so adjacent lists get alternating markers. */
function sameTypeRun(node: PMNode, parent: PMNode, index: number): number {
  let n = 0
  for (let i = index - 1; i >= 0 && parent.child(i).type === node.type; i--) n++
  return n
}

const StateBase = MarkdownSerializerState as unknown as new (
  nodes: Record<string, Serializer>,
  marks: Record<string, MarkSerializerSpec>,
  options: { tightLists: boolean; hardBreakNodeName: string },
) => MarkdownSerializerState & {
  out: string
  closed: PMNode | null
  delim: string
  atBlockStart: boolean
  flushClose(size?: number): void
  atBlank(): boolean
}

/** How much of the end of the output `State` keeps at hand; more than `MAX_MARKERS`. */
const TAIL = 1024

/**
 * How a block writes bold and italic: `minimal` and `strict` differ in when a letter
 * next to a delimiter is written as a character reference (see `placeDelimiters`);
 * `none` leaves bold and italic out.
 */
type Emphasis = 'minimal' | 'strict' | 'none'

/**
 * Adds the escaping prosemirror-markdown's `esc` misses: entity-like `&…;`, `<`,
 * line-start markers after a hard break or a list marker, and leading whitespace.
 *
 * Also keeps the end of the output at hand: reading even one character of a string
 * built up by appending makes V8 copy all of it, which on a long line made writing
 * each piece cost as much as everything before it. So the methods that append
 * (`write`, `text`, `flushClose`, `ensureNewLine`) are redone here to read only `tail`.
 */
class State extends StateBase {
  /** Everything written since `commitLines` last ran. */
  private written = ''
  /** The last `TAIL` to `2 * TAIL` characters of `written`, or `null` until next needed. */
  private tail: string | null = ''

  // @ts-expect-error -- an accessor in place of the base class's `out` field.
  override get out(): string {
    return this.written
  }

  override set out(value: string) {
    this.written = value
    this.tail = null
  }

  /** Appends to the output. */
  append(text: string): void {
    this.written += text
    if (this.tail !== null) {
      this.tail += text
      if (this.tail.length > 2 * TAIL) this.tail = this.tail.slice(-TAIL)
    }
  }

  /** The end of the output: all of it when shorter than `TAIL`. */
  end(): string {
    if (this.tail === null) this.tail = this.written.slice(-TAIL)
    return this.tail
  }

  override flushClose(size = 2): void {
    if (!this.closed) return
    if (!this.atBlank()) this.append('\n')
    if (size > 1) {
      const delimMin = this.delim.trimEnd()
      for (let i = 1; i < size; i++) this.append(delimMin + '\n')
    }
    this.closed = null
  }

  override atBlank(): boolean {
    const end = this.end()
    return end === '' || end.endsWith('\n')
  }

  override ensureNewLine(): void {
    if (!this.atBlank()) this.append('\n')
  }

  override write(content?: string): void {
    this.flushClose()
    if (this.delim && this.atBlank()) this.append(this.delim)
    if (content) this.append(content)
  }

  override text(text: string, escape = true): void {
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      this.write()
      // Escape a `!` that would turn a link into an image.
      if (!escape && line.startsWith('[') && /(^|[^\\])!$/.test(this.end().slice(-2))) {
        this.out = this.out.slice(0, -1) + '\\!'
      }
      this.append(escape ? this.esc(line, this.atBlockStart) : line)
      if (i !== lines.length - 1) this.append('\n')
    })
  }

  /** Set to write every block one way; `null` picks the first way that reads back. */
  emphasis: Emphasis | null = null
  /** The marker each bullet list was written with. */
  bullets = new WeakMap<PMNode, string>()
  /** The index of each block's last child that isn't a line break. */
  lastContent = new WeakMap<PMNode, number>()
  /** Finished lines, moved out of `out` so that rewriting a block's text stays cheap. */
  done: string[] = []
  /** The code spans written as `CODE` in the block being written, in order. */
  codes: string[] = []

  /** Moves every finished line out of `out`; what is still being written stays. */
  commitLines(): void {
    const end = this.out.lastIndexOf('\n') + 1
    if (end === 0) return
    this.done.push(this.out.slice(0, end))
    this.out = this.out.slice(end)
  }

  /** Everything written. */
  result(): string {
    return this.done.join('') + this.out
  }

  override esc(str: string, startOfLine = false): string {
    const lineStart = atLineStart(this.end())
    let lead = ''
    let rest = str
    if (lineStart) {
      lead = /^\s*/.exec(str)?.[0] ?? ''
      rest = str.slice(lead.length)
    }
    let out = super.esc(rest, startOfLine || (lineStart && lead === ''))
    if (lineStart && lead === '') {
      out = out
        .replace(/^(\d{1,9})([.)])(?=[ \t]|$)/, '$1\\$2')
        .replace(/^\+(?=[ \t]|$)/, '\\+')
        .replace(/^=/, '\\=')
        // After a line break, a line starting with these could be read as a table's delimiter row.
        .replace(/^[:|]/, '\\$&')
    }
    // A bare `_` is safe only between two letters or digits; next to anything else it could open or close.
    out = out.replace(/\\[\s\S]|_/g, (m, at: number, all: string) =>
      m === '_' && !(/[A-Za-z0-9]/.test(all[at - 1] ?? '') && /[A-Za-z0-9]/.test(all[at + 1] ?? '')) ? '\\_' : m,
    )
    out = out.replace(/<|&(?=#?[0-9A-Za-z]+;)/g, '\\$&').replace(STAND_INS, encodeChars)
    return encodeChars(lead) + out
  }
}

const isEmphasis = (mark: Mark) => mark.type.name === 'bold' || mark.type.name === 'italic'

/** The block with bold and italic taken off, so text that ends up side by side is escaped as one. */
function withoutEmphasis(node: PMNode): PMNode {
  const children: PMNode[] = []
  node.forEach((child) => children.push(child.mark(child.marks.filter((m) => !isEmphasis(m)))))
  return node.type.create(node.attrs, Fragment.fromArray(children))
}

/**
 * The block with bold and italic kept on a line break only when the nearest visible
 * content after it has them too, and the same link; and on spaces only as the same marks as the content
 * before, all of which go on. Elsewhere they can't be seen, and prosemirror-markdown
 * would write a delimiter where it can't open or close.
 */
function tidyInvisible(node: PMNode): PMNode {
  // Spaces at the end of bold or italic text are looked at on their own.
  const children: PMNode[] = []
  node.forEach((child) => {
    const text = child.text ?? ''
    if (!child.isText || !child.marks.some(isEmphasis)) return void children.push(child)
    // prosemirror-markdown looks for trailing spaces in the text where bold or italic ends
    // with a regex that is slow on long runs of spaces, so after one the last word is split off.
    const core = text.trimEnd()
    let word = core.length
    if (/\s{64,}/.test(core)) while (word > 0 && !/\s/.test(core[word - 1]!)) word--
    else word = 0
    for (const part of [core.slice(0, word), core.slice(word), text.slice(core.length)]) {
      if (part) children.push(richTextSchema.text(part, child.marks))
    }
  })
  const blank = (child: PMNode | undefined) => child?.isText === true && !/\S/.test(child.text ?? '')
  const invisible = children.map((child) => child.type.name === 'hardBreak' || blank(child))
  // For bold and italic: whether the mark runs unbroken from each child to the next visible one.
  const unbroken = new Map<string, boolean[]>()
  for (const name of ['bold', 'italic']) {
    const runs = new Array<boolean>(children.length).fill(false)
    for (let i = children.length - 1; i >= 0; i--) {
      const has = children[i]!.marks.some((m) => m.type.name === name)
      runs[i] = invisible[i] ? has && (runs[i + 1] ?? false) : has
    }
    unbroken.set(name, runs)
  }
  const others = (marks: readonly Mark[]) => marks.filter((m) => !isEmphasis(m))
  // Whether the link stays the same from each child to the next visible one.
  const sameLink = new Array<boolean>(children.length).fill(true)
  for (let i = children.length - 2; i >= 0; i--) {
    if (invisible[i]) {
      sameLink[i] = Mark.sameSet(others(children[i]!.marks), others(children[i + 1]!.marks)) && sameLink[i + 1]!
    }
  }
  const tidied: PMNode[] = []
  children.forEach((child, i) => {
    const prev = tidied[i - 1]
    let marks = child.marks
    if (invisible[i] && marks.some(isEmphasis)) {
      const continues = (m: Mark) => sameLink[i] === true && unbroken.get(m.type.name)?.[i] === true
      if (!blank(child)) {
        marks = marks.filter((m) => !isEmphasis(m) || continues(m))
      } else {
        // Spaces take exactly the marks before them, so nothing opens or closes at them,
        // or else no bold or italic at all.
        const same =
          prev !== undefined &&
          Mark.sameSet(others(prev.marks), others(marks)) &&
          prev.marks.every((m) => !isEmphasis(m) || continues(m))
        marks = same ? prev.marks : others(marks)
      }
    }
    tidied.push(marks === child.marks ? child : child.mark(marks))
  })
  // Built without joining neighbors with the same marks, to keep the split above.
  const size = tidied.reduce((sum, child) => sum + child.nodeSize, 0)
  return node.type.create(node.attrs, new (Fragment as unknown as new (content: PMNode[], size: number) => Fragment)(tidied, size))
}

type Piece = { text: string } | { delim: '*' | '_'; count: number; open: boolean }

/** How the emphasis rules see the character a piece starts or ends with next to a delimiter run. */
function charKind(piece: Piece | undefined): 'space' | 'punct' | 'word' {
  if (piece === undefined) return 'space'
  // A code span starts and ends with a backtick.
  if ('delim' in piece || piece.text === CODE) return 'punct'
  const { isWhiteSpace, isMdAsciiPunct, isPunctCharCode } = tokenizer.utils
  const code = piece.text.codePointAt(0) ?? 0x20
  if (isWhiteSpace(code)) return 'space'
  return isMdAsciiPunct(code) || isPunctCharCode(code) ? 'punct' : 'word'
}

/**
 * Swaps the stand-ins in one written block for delimiter runs that CommonMark reads
 * back as the same marks. A run that opens right where another closes uses the other
 * character (`**a*b***_c_`), so the two don't merge into one run; so does one opening
 * inside another (`**a _b_ c**`), so it can't be taken for that one's end. A letter next to a
 * run that couldn't open or close beside it (`said*"hi"*`, or any `_` inside a word)
 * is written as a character reference (`sai&#100;*"hi"*`): it reads back as the same
 * letter but counts as punctuation. `strict` does that next to every run.
 */
function placeDelimiters(written: string, strict: boolean): string {
  const pieces: Piece[] = []
  const open: Array<'*' | '_'> = []
  for (const ch of written) {
    const standIn = STAND_IN[ch]
    if (standIn === undefined) {
      pieces.push({ text: ch })
      continue
    }
    let delim: '*' | '_'
    if (standIn.open) {
      const prev = pieces[pieces.length - 1]
      const run = prev !== undefined && 'delim' in prev ? prev : undefined
      if (run?.open) delim = run.delim
      else delim = (run?.delim ?? open[open.length - 1]) === '*' ? '_' : '*'
      open.push(delim)
    } else {
      delim = open.pop() ?? '*'
    }
    pieces.push({ delim, ...standIn })
  }

  const encode = new Set<number>()
  for (let i = 0; i < pieces.length; ) {
    const piece = pieces[i]
    if (piece === undefined || !('delim' in piece)) {
      i++
      continue
    }
    let j = i + 1
    for (let next = pieces[j]; next !== undefined && 'delim' in next && next.delim === piece.delim; next = pieces[++j]);
    const before = charKind(pieces[i - 1])
    const after = charKind(pieces[j])
    const underscore = piece.delim === '_'
    if (piece.open) {
      if (before === 'word' && (strict || underscore || after === 'punct')) encode.add(i - 1)
    } else if (after === 'word' && (strict || underscore || before === 'punct')) {
      encode.add(j)
    }
    i = j
  }
  // An `_` left unescaped inside a word could open or close once its neighbor is a reference.
  const textAt = (i: number) => {
    const piece = pieces[i]
    return piece !== undefined && 'text' in piece ? piece.text : undefined
  }
  const escape = new Set<number>()
  for (const i of encode) {
    if (textAt(i - 1) === '_' && textAt(i - 2) !== '\\') escape.add(i - 1)
    if (textAt(i + 1) === '_') escape.add(i + 1)
  }
  return pieces
    .map((piece, i) => {
      if ('delim' in piece) return piece.delim.repeat(piece.count)
      if (encode.has(i)) return encodeChars(piece.text)
      return escape.has(i) ? '\\_' : piece.text
    })
    .join('')
}

const SERIALIZER_OPTIONS = { tightLists: true, hardBreakNodeName: 'hardBreak' }

/**
 * The block's content as one entry per character or inline node. `all` keeps every
 * mark, `text` all but bold and italic, `emphasis` only bold and italic and only on
 * what can be seen. Marks on whitespace and line breaks, which the writer moves out of
 * links and emphasis, and trailing line breaks, which it drops, are left out.
 */
function signature(node: PMNode, kind: 'all' | 'text' | 'emphasis'): string {
  const out: string[] = []
  let end = node.childCount
  while (end > 0 && node.child(end - 1).type.name === 'hardBreak') end--
  const marksOf = (marks: readonly Mark[]) =>
    JSON.stringify(
      marks.filter((m) => (kind === 'all' ? true : kind === 'text' ? !isEmphasis(m) : isEmphasis(m))).map((m) => m.toJSON() as unknown),
    )
  node.forEach((child, _, i) => {
    if (i >= end) return
    if (child.isText) {
      for (const c of child.text ?? '') {
        const visible = /\S/.test(c)
        if (visible || kind !== 'emphasis') out.push(c + (visible ? marksOf(child.marks) : ''))
      }
    } else if (child.type.name === 'hardBreak') {
      if (kind !== 'emphasis') out.push('hardBreak')
    } else {
      out.push(child.type.name + JSON.stringify(child.attrs) + marksOf(child.marks))
    }
  })
  return JSON.stringify(out)
}

/** The block's content written with `emphasis` and read back, or `null` if it isn't one paragraph. */
function readBack(node: PMNode, emphasis: Emphasis): PMNode | null {
  const para = richTextSchema.nodes.paragraph!.create(null, node.content)
  const state = new State(nodes, marks, SERIALIZER_OPTIONS)
  state.emphasis = emphasis
  state.renderContent(richTextSchema.nodes.doc!.create(null, para))
  try {
    const back = parser.parse(state.result())
    return back.childCount === 1 && back.firstChild?.type === para.type ? back.firstChild : null
  } catch {
    return null
  }
}

/** Above this many bold and italic runs, a block that doesn't read back loses all of them. */
const MAX_RUNS_TO_TRY = 32

/**
 * The block with only the bold and italic runs that read back the same, added one by
 * one in order, or `null` if it has too many runs to try.
 */
function keepWhatReadsBack(node: PMNode, fits: (back: PMNode | null, target: PMNode) => boolean): PMNode | null {
  const children: PMNode[] = []
  node.forEach((child) => children.push(child))
  const runs: { mark: Mark; from: number; to: number }[] = []
  for (const name of ['bold', 'italic']) {
    let from = -1
    children.forEach((child, i) => {
      const mark = child.marks.find((m) => m.type.name === name)
      if (mark && from < 0) from = i
      const next = children[i + 1]
      if (mark && from >= 0 && !next?.marks.some((m) => m.type.name === name)) {
        runs.push({ mark, from, to: i })
        from = -1
      }
    })
  }
  if (runs.length > MAX_RUNS_TO_TRY) return null
  runs.sort((a, b) => a.from - b.from)
  let marksAt: (readonly Mark[])[] = children.map((child) => child.marks.filter((m) => !isEmphasis(m)))
  const build = () => node.type.create(node.attrs, Fragment.fromArray(children.map((child, i) => child.mark(marksAt[i]!))))
  for (const run of runs) {
    const before = marksAt
    marksAt = marksAt.map((set, i) => (i >= run.from && i <= run.to ? run.mark.addToSet(set) : set))
    const candidate = build()
    if (!fits(readBack(candidate, 'strict'), candidate)) marksAt = before
  }
  return build()
}

/**
 * How to write the block's bold and italic, and the block to write. The first way that
 * reads back the same; failing that (because something else in the block doesn't), the
 * first way that adds no text and keeps the bold and italic on what can be seen. Failing
 * both, only the runs that read back are kept, and the rest are left out rather than
 * written as stray `*` or `_` text.
 */
function chooseWriting(node: PMNode): { emphasis: Emphasis; node: PMNode } {
  let marked = false
  node.forEach((child) => {
    if (child.marks.some(isEmphasis)) marked = true
  })
  if (!marked) return { emphasis: 'minimal', node }
  const tries = (['minimal', 'strict'] as const).map((emphasis) => ({ emphasis, back: readBack(node, emphasis) }))
  const want = signature(node, 'all')
  for (const { emphasis, back } of tries) if (back && signature(back, 'all') === want) return { emphasis, node }
  const plain = readBack(node, 'none')
  const text = plain && signature(plain, 'text')
  const fits = (back: PMNode | null, target: PMNode) =>
    back !== null && signature(back, 'text') === text && signature(back, 'emphasis') === signature(target, 'emphasis')
  for (const { emphasis, back } of tries) if (fits(back, node)) return { emphasis, node }
  const kept = text === null ? null : keepWhatReadsBack(node, fits)
  return kept ? { emphasis: 'strict', node: kept } : { emphasis: 'none', node }
}

/** Writes a paragraph's or heading's content. Trailing whitespace is encoded, or it would be trimmed. */
function renderTextblock(state: State, node: PMNode, fromBlockStart: boolean): void {
  const writing = state.emphasis ? { emphasis: state.emphasis, node } : chooseWriting(node)
  state.commitLines()
  const start = state.out.length
  state.renderInline(writing.emphasis === 'none' ? withoutEmphasis(writing.node) : tidyInvisible(writing.node), fromBlockStart)
  const codes = state.codes
  state.codes = []
  const written = placeDelimiters(state.out.slice(start), writing.emphasis === 'strict').replace(/\uE004/g, () => codes.shift() ?? '')
  const kept = written.trimEnd()
  state.out = state.out.slice(0, start) + kept + encodeChars(written.slice(kept.length))
}

/** True for a block with nothing but line breaks, which are dropped at the end of a block. */
function writesNothing(node: PMNode | null): boolean {
  let nothing = node !== null
  node?.forEach((child) => {
    if (child.type.name !== 'hardBreak') nothing = false
  })
  return nothing
}

/**
 * A list that can't interrupt a paragraph (a numbered list not starting at 1, or one
 * whose first item is empty) would read back as part of the text above it in a tight
 * list, so it gets a blank line first.
 */
function separateList(state: State, node: PMNode): void {
  const first = node.firstChild
  let empty = first !== null
  first?.forEach((child) => {
    if (!writesNothing(child)) empty = false
  })
  const start = node.type.name === 'orderedList' ? Number(node.attrs.start ?? 1) : 1
  if ((empty || start !== 1) && state.closed && state.closed.type !== node.type) state.flushClose(2)
}

/** A table cell's content on one line, written as any paragraph is, with each `|` escaped. */
function cellMarkdown(cell: PMNode): string {
  const state = new State(nodes, marks, SERIALIZER_OPTIONS)
  state.renderContent(richTextSchema.nodes.doc!.create(null, cell.content))
  return oneLine(state.result()).trim().replace(/\|/g, '\\|')
}

const nodes: Record<string, Serializer> = {
  table(state, node) {
    node.forEach((row, _, r) => {
      const cells: string[] = []
      row.forEach((cell) => cells.push(cellMarkdown(cell)))
      state.write(`| ${cells.join(' | ')} |`)
      state.ensureNewLine()
      if (r === 0) {
        state.write(`| ${cells.map(() => '---').join(' | ')} |`)
        state.ensureNewLine()
      }
    })
    state.closeBlock(node)
  },
  blockquote(state, node) {
    state.wrapBlock('> ', null, node, () => state.renderContent(node))
  },
  heading(state, node) {
    state.write('#'.repeat(Number(node.attrs.level)) + ' ')
    renderTextblock(state, node, false)
    // A trailing run of `#` would be read as the heading's closing sequence.
    const end = state.end()
    let run = end.length
    while (run > 0 && end[run - 1] === '#') run--
    if (run === 0 && end.length < state.out.length) {
      // A run of `#` longer than the tail: look at the whole output.
      const out = state.out
      run = out.length
      while (run > 0 && out[run - 1] === '#') run--
      if (run > 0 && out[run - 1] !== '\\') state.out = out.slice(0, run) + '\\' + out.slice(run)
    } else if (run > 0 && run < end.length && end[run - 1] !== '\\') {
      const at = state.out.length - (end.length - run)
      state.out = state.out.slice(0, at) + '\\' + state.out.slice(at)
    }
    state.closeBlock(node)
  },
  bulletList(state, node, parent, index) {
    // A list takes the other marker from a list right before it, which it would otherwise
    // join, and from one it starts on the same line as, since `- - -` is a rule.
    const out = state.end()
    const marker = out[out.length - 2]
    const lead = out[out.length - 3]
    const onMarker =
      !state.closed && out.endsWith(' ') && (marker === '-' || marker === '*') && (lead === undefined || lead === '\n' || lead === ' ' || lead === '\t')
    const before = index > 0 ? state.bullets.get(parent.child(index - 1)) : undefined
    const outer = before ?? (onMarker ? marker : undefined)
    const bullet = outer === '-' ? '* ' : '- '
    state.bullets.set(node, bullet.charAt(0))
    separateList(state, node)
    state.renderList(node, '  ', () => bullet)
  },
  orderedList(state, node, parent, index) {
    const start = Number(node.attrs.start ?? 1)
    const sep = sameTypeRun(node, parent, index) % 2 ? ') ' : '. '
    // Numbers are padded after, not before, so every item's text starts in the same column
    // even when the list starts on its parent item's first line.
    const width = String(start + node.childCount - 1).length
    separateList(state, node)
    state.renderList(node, ' '.repeat(width + 2), (i) => (String(start + i) + sep).padEnd(width + 2, ' '))
  },
  listItem(state, node) {
    // `- > x` reads back as an empty first paragraph followed by the quote; writing the
    // empty paragraph would leave a blank line that ends the item.
    const skipFirst = node.childCount > 1 && writesNothing(node.firstChild)
    node.forEach((child, _, i) => {
      if (!(skipFirst && i === 0)) state.render(child, node, i)
    })
  },
  paragraph(state, node) {
    renderTextblock(state, node, true)
    state.closeBlock(node)
  },
  image(state, node) {
    const alt = typeof node.attrs.alt === 'string' ? oneLine(node.attrs.alt) : ''
    state.write('![')
    state.append(state.esc(alt))
    state.append(`](${MEDIA_PREFIX}${String(node.attrs.media)})`)
  },
  hardBreak(state, node, parent, index) {
    // Only breaks with something after them are written; a trailing one would be text.
    let last = state.lastContent.get(parent)
    if (last === undefined) {
      last = -1
      parent.forEach((child, _, i) => {
        if (child.type !== node.type) last = i
      })
      state.lastContent.set(parent, last)
    }
    if (index < last) state.write('\\\n')
  },
  text(state, node, parent, index) {
    if (node.marks.some((m) => m.type.name === 'code')) {
      state.codes.push(codeSpan(node.text ?? ''))
      state.write()
      state.append(CODE)
      return
    }
    // A `!` right before a link would make it an image. prosemirror-markdown checks for
    // this, but rewrites the whole output each time and misreads `\\!`, so it is escaped here.
    const text = node.text ?? ''
    const linkOf = (n: PMNode) => n.marks.find((m) => m.type.name === 'link')
    const next = index + 1 < parent.childCount ? parent.child(index + 1) : null
    const link = next && linkOf(next)
    if (text.endsWith('!') && link && !link.eq(linkOf(node) ?? link.type.create())) {
      state.text(text.slice(0, -1))
      state.append('\\!')
    } else {
      state.text(text)
    }
  },
}

const marks: Record<string, MarkSerializerSpec> = {
  link: {
    open: '[',
    close: (_state, mark) => {
      const href =
        typeof mark.attrs.document === 'string' ? DOCUMENT_PREFIX + mark.attrs.document : String(mark.attrs.href)
      return `](${markdownDestination(href)})`
    },
    mixable: true,
  },
  bold: { open: OPEN_BOLD, close: CLOSE_BOLD, mixable: true, expelEnclosingWhitespace: true },
  italic: { open: OPEN_ITALIC, close: CLOSE_ITALIC, mixable: true, expelEnclosingWhitespace: true },
  // Written by the text serializer, which sees the whole text the mark is on.
  code: { open: '', close: '' },
}

/** The doc as CommonMark: tight lists, `- ` bullets, `inlay:` URIs for internal links and images. */
export function richTextToMarkdown(doc: RichTextDoc): string {
  const node = richTextSchema.nodeFromJSON(doc)
  const state = new State(nodes, marks, SERIALIZER_OPTIONS)
  state.renderContent(node)
  return state.result()
}

// ---------------------------------------------------------------------------
// Markdown → rich text

const tokenizer = new MarkdownIt('commonmark', { html: false, linkify: false, typographer: false })
tokenizer.validateLink = () => true
tokenizer.normalizeLink = (url) => url
tokenizer.normalizeLinkText = (url) => url
tokenizer.enable('table')

/**
 * Reads the syntax that CommonMark keeps as plain text but writers mean as formatting rich text can't hold:
 * HTML and strikethrough. Used only to refuse it, so it isn't silently stored as literal characters.
 * Tables are read here too, so syntax inside a cell is found as it is anywhere else.
 */
const detector = new MarkdownIt('commonmark', { html: true, linkify: false, typographer: false }).enable([
  'table',
  'strikethrough',
])
detector.validateLink = () => true

/** markdown-it stops reading blocks nested this deep and drops the rest of the input. */
const MAX_NESTING = (tokenizer.options as { maxNesting?: number }).maxNesting ?? 20

/** What `markdownToRichText` passes to the tokenizer to learn about link reference definitions. */
interface ParseEnv {
  references?: Record<string, unknown>
  /** Each definition's line and text, and the label it added (`null` if an earlier one had it). */
  definitions?: { line: number; text: string; label: string | null }[]
  /** Labels a link or image looked up once the blocks were read. */
  used?: Set<string>
  /** The label the last definition added. */
  added?: string | null
  /** True once the blocks are read and links are being looked up. */
  inline?: boolean
  /** Image targets as written, and the library image (a media id) each one stands for. */
  images?: ReadonlyMap<string, string>
}

/** An env whose `references` note each label added and, later, each one looked up. */
function trackingEnv(): ParseEnv {
  const env: ParseEnv = { definitions: [], used: new Set(), added: null, inline: false }
  env.references = new Proxy({} as Record<string, unknown>, {
    set(target, key, value) {
      if (typeof key === 'string') env.added = key
      return Reflect.set(target, key, value)
    },
    get(target, key, receiver) {
      if (env.inline && typeof key === 'string' && Object.hasOwn(target, key)) env.used?.add(key)
      return Reflect.get(target, key, receiver) as unknown
    },
  })
  return env
}

type BlockRule = ReturnType<typeof tokenizer.block.ruler.getRules>[number]
const referenceRule: BlockRule | undefined = tokenizer.block.ruler.getRules('').find((rule) => rule.name === 'reference')
if (referenceRule) {
  tokenizer.block.ruler.at('reference', (state, startLine, endLine, silent) => {
    const env = state.env as ParseEnv
    if (!env.definitions) return referenceRule(state, startLine, endLine, silent)
    env.added = null
    if (!referenceRule(state, startLine, endLine, silent)) return false
    if (!silent) {
      const from = (state.bMarks[startLine] ?? 0) + (state.tShift[startLine] ?? 0)
      const text = state.src.slice(from, state.eMarks[startLine]).trim()
      env.definitions.push({ line: startLine + 1, text, label: env.added })
    }
    return true
  })
} else {
  // Without a way to see definitions, read them as text rather than lose them.
  tokenizer.block.ruler.disable('reference')
}

// Once the blocks are read, lookups in `references` come from links and images.
tokenizer.core.ruler.after('block', 'inlay_used_references', (state) => {
  const env = state.env as ParseEnv
  if (env.definitions) env.inline = true
})

// Table cells hold a paragraph, as the schema requires: each cell's inline content gets one.
tokenizer.core.ruler.after('inline', 'inlay_table_cells', (state) => {
  const out: Token[] = []
  let cell = false
  for (const tok of state.tokens) {
    if (cell && tok.type === 'inline') {
      const open = new state.Token('paragraph_open', 'p', 1)
      const close = new state.Token('paragraph_close', 'p', -1)
      open.level = close.level = tok.level
      tok.level++
      out.push(open, tok, close)
    } else {
      out.push(tok)
    }
    cell = tok.type === 'th_open' || tok.type === 'td_open'
  }
  state.tokens = out
})

/** Image tokens, at any depth, whose target is named in `env.images` point at that library image instead. */
tokenizer.core.ruler.push('inlay_images', (state) => {
  const images = (state.env as ParseEnv).images
  if (!images || images.size === 0) return
  const rewrite = (tokens: Token[]) => {
    for (const tok of tokens) {
      if (tok.type === 'image') {
        const id = images.get(tok.attrGet('src') ?? '')
        if (id !== undefined) tok.attrSet('src', MEDIA_PREFIX + id)
      }
      if (tok.children) rewrite(tok.children)
    }
  }
  rewrite(state.tokens)
})

/** An image's alt as plain text, the way a browser shows it. */
function altText(children: Token[] | null): string {
  return (children ?? [])
    .map((c) => {
      if (c.type === 'text' || c.type === 'text_special' || c.type === 'code_inline') return c.content
      if (c.type === 'softbreak' || c.type === 'hardbreak') return ' '
      if (c.type === 'image') return altText(c.children)
      return ''
    })
    .join('')
}

const parser = new MarkdownParser(richTextSchema, tokenizer, {
  blockquote: { block: 'blockquote' },
  paragraph: { block: 'paragraph' },
  list_item: { block: 'listItem' },
  bullet_list: { block: 'bulletList' },
  ordered_list: { block: 'orderedList', getAttrs: (tok) => ({ start: Number(tok.attrGet('start') ?? 1) }) },
  heading: { block: 'heading', getAttrs: (tok) => ({ level: Number(tok.tag.slice(1)) }) },
  image: {
    node: 'image',
    getAttrs: (tok) => ({
      media: (tok.attrGet('src') ?? '').slice(MEDIA_PREFIX.length),
      alt: altText(tok.children) || null,
    }),
  },
  hardbreak: { node: 'hardBreak' },
  table: { block: 'table' },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: 'tableRow' },
  th: { block: 'tableHeader' },
  td: { block: 'tableCell' },
  em: { mark: 'italic' },
  strong: { mark: 'bold' },
  code_inline: { mark: 'code', noCloseToken: true },
  link: {
    mark: 'link',
    getAttrs: (tok) => {
      const href = tok.attrGet('href') ?? ''
      return href.startsWith(DOCUMENT_PREFIX) ? { document: href.slice(DOCUMENT_PREFIX.length) } : { href }
    },
  },
})

type FeatureName = RichTextFeature | 'code' | 'codeBlock' | 'rule' | 'html' | 'strike' | 'other'

const FEATURE_MESSAGE: Readonly<Record<FeatureName, MessageId>> = {
  heading: 'richtext.feature.heading',
  bold: 'richtext.feature.bold',
  italic: 'richtext.feature.italic',
  link: 'richtext.feature.link',
  bulletList: 'richtext.feature.bulletList',
  orderedList: 'richtext.feature.orderedList',
  blockquote: 'richtext.feature.blockquote',
  image: 'richtext.feature.image',
  hardBreak: 'richtext.feature.hardBreak',
  code: 'richtext.feature.code',
  codeBlock: 'richtext.feature.codeBlock',
  rule: 'richtext.feature.rule',
  html: 'richtext.feature.html',
  table: 'richtext.feature.table',
  strike: 'richtext.feature.strike',
  other: 'richtext.feature.other',
}

/** Token types that map to a feature a field may switch off. */
const TOKEN_FEATURE: Readonly<Record<string, RichTextFeature>> = {
  bullet_list_open: 'bulletList',
  ordered_list_open: 'orderedList',
  blockquote_open: 'blockquote',
  strong_open: 'bold',
  em_open: 'italic',
  code_inline: 'code',
  link_open: 'link',
  image: 'image',
  hardbreak: 'hardBreak',
  table_open: 'table',
}

const TOKEN_UNSUPPORTED: Readonly<Record<string, FeatureName>> = {
  code_block: 'codeBlock',
  fence: 'codeBlock',
  hr: 'rule',
}

/** Token types the parser turns into rich text without any check. */
const PLAIN_TOKENS = new Set([
  'paragraph_open',
  'paragraph_close',
  'list_item_open',
  'list_item_close',
  'bullet_list_close',
  'ordered_list_close',
  'blockquote_close',
  'heading_close',
  'strong_close',
  'em_close',
  'link_close',
  'inline',
  'text',
  'text_special',
  'softbreak',
  'table_close',
  'thead_open',
  'thead_close',
  'tbody_open',
  'tbody_close',
  'tr_open',
  'tr_close',
  'th_open',
  'th_close',
  'td_open',
  'td_close',
])

/** Token types of `detector` for syntax that would otherwise be kept as literal text. */
const TOKEN_LITERAL: Readonly<Record<string, FeatureName>> = {
  html_block: 'html',
  html_inline: 'html',
  s_open: 'strike',
}

/** One problem per line and kind for HTML and strikethrough in `markdown`. */
function literalSyntaxProblems(markdown: string): RichTextProblem[] {
  const problems: RichTextProblem[] = []
  const seen = new Set<string>()
  const add = (name: FeatureName | undefined, line: number) => {
    if (name === undefined || seen.has(`${line}:${name}`)) return
    seen.add(`${line}:${name}`)
    problems.push({
      code: 'unsupported',
      line,
      message: t('richtext.unsupported', { line, feature: t(FEATURE_MESSAGE[name]) }),
    })
  }
  let line = 1
  for (const tok of detector.parse(markdown, {})) {
    if (tok.map) line = tok.map[0] + 1
    add(TOKEN_LITERAL[tok.type], line)
    let inline = line
    for (const child of tok.children ?? []) {
      add(TOKEN_LITERAL[child.type], inline)
      if (child.type === 'softbreak' || child.type === 'hardbreak') inline++
    }
  }
  return problems
}

const isSafeHref = (href: string) =>
  href.startsWith(DOCUMENT_PREFIX) ? UUID.safeParse(href.slice(DOCUMENT_PREFIX.length)).success : isRichTextHref(href)

const isLibraryImage = (src: string) => src.startsWith(MEDIA_PREFIX) && HEX64.test(src.slice(MEDIA_PREFIX.length))

/** Every problem in the token stream and `env`, in line order, before anything is built. */
function findProblems(tokens: Token[], opts: RichTextOptions, env: ParseEnv): RichTextProblem[] {
  const problems: RichTextProblem[] = []
  const feature = (name: FeatureName) => t(FEATURE_MESSAGE[name])
  const add = (code: RichTextProblem['code'], line: number, id: MessageId, params: Record<string, string | number>) => {
    problems.push({ code, line, message: t(id, { line, ...params }) })
  }
  const allowed = (f: RichTextFeature) => opts.features.includes(f)

  const check = (tok: Token, line: number, inHeading: boolean, inCell: boolean) => {
    const unsupported = TOKEN_UNSUPPORTED[tok.type]
    if (unsupported) return add('unsupported', line, 'richtext.unsupported', { feature: feature(unsupported) })
    if (tok.type === 'heading_open') {
      const level = Number(tok.tag.slice(1))
      if (!allowed('heading') || opts.headings.length === 0) {
        return add('not_allowed', line, 'richtext.notAllowed', { feature: feature('heading') })
      }
      if (!opts.headings.includes(level)) {
        return add('heading_level', line, 'richtext.headingLevel', { level, levels: opts.headings.join(', ') })
      }
      return
    }
    const name = TOKEN_FEATURE[tok.type]
    if (name === undefined) {
      if (!PLAIN_TOKENS.has(tok.type)) add('unsupported', line, 'richtext.unsupported', { feature: feature('other') })
      return
    }
    if (inHeading && (name === 'image' || name === 'hardBreak')) {
      return add('unsupported', line, 'richtext.headingContent', { feature: feature(name) })
    }
    if (inCell && (name === 'image' || name === 'hardBreak')) {
      return add('unsupported', line, 'richtext.tableCell', { feature: feature(name) })
    }
    if (!allowed(name)) return add('not_allowed', line, 'richtext.notAllowed', { feature: feature(name) })
    if (name === 'link' || name === 'image') {
      if (tok.attrGet('title')) add('unsupported', line, 'richtext.title', { feature: feature(name) })
    }
    if (name === 'link') {
      const href = tok.attrGet('href') ?? ''
      if (!isSafeHref(href)) add('link_url', line, 'richtext.linkUrl', { href })
    }
    if (name === 'image') {
      const src = tok.attrGet('src') ?? ''
      if (!isLibraryImage(src)) add('image_source', line, 'richtext.imageSource', { src })
    }
  }

  /**
   * Walks inline tokens; line breaks move the line on, including those inside an image's alt. Code inside bold or
   * italic is refused, since rich text can't hold both on the same text.
   */
  const walkInline = (children: Token[], line: number, inHeading: boolean, inCell: boolean, inAlt: boolean): number => {
    let emphasis = 0
    for (const child of children) {
      if (!inAlt) check(child, line, inHeading, inCell)
      if (child.type === 'strong_open' || child.type === 'em_open') emphasis++
      if (child.type === 'strong_close' || child.type === 'em_close') emphasis--
      if (!inAlt && child.type === 'code_inline' && emphasis > 0 && allowed('code')) {
        add('unsupported', line, 'richtext.codeEmphasis', {})
      }
      if (child.type === 'softbreak' || child.type === 'hardbreak') line++
      if (child.type === 'image' && child.children) line = walkInline(child.children, line, inHeading, inCell, true)
    }
    return line
  }

  let line = 1
  let inHeading = false
  let inCell = false
  for (const tok of tokens) {
    if (tok.map) line = tok.map[0] + 1
    if (tok.type === 'inline') {
      walkInline(tok.children ?? [], line, inHeading, inCell, false)
      continue
    }
    if (tok.type === 'heading_open') inHeading = true
    if (tok.type === 'heading_close') inHeading = false
    if (tok.type === 'th_open' || tok.type === 'td_open') inCell = true
    if (tok.type === 'th_close' || tok.type === 'td_close') inCell = false
    if ((tok.type === 'blockquote_open' || tok.type === 'list_item_open') && tok.level + 1 >= MAX_NESTING) {
      add('unsupported', line, 'richtext.tooDeep', {})
    }
    if (tok.type === 'table_open' && tok.level > 0) add('unsupported', line, 'richtext.tableNested', {})
    check(tok, line, false, false)
  }
  // A definition no link uses would vanish; one that is used ends up in its links.
  for (const def of env.definitions ?? []) {
    if (def.label === null || !env.used?.has(def.label)) {
      add('unsupported', def.line, 'richtext.unusedDefinition', { text: def.text })
    }
  }
  return problems.sort((a, b) => a.line - b.line)
}

/** The line (from 1) each top-level block of `markdown` starts on. */
export function blockLines(markdown: string): number[] {
  return tokenizer
    .parse(markdown, {})
    .flatMap((tok) => (tok.level === 0 && tok.nesting !== -1 && tok.map ? [tok.map[0] + 1] : []))
}

/**
 * Every image target in `markdown`, in order, as markdown-it reads it (escapes and `<…>` undone), with its line,
 * counted the way problems are. Images inside another image's alt, which become alt text, aren't listed.
 */
export function markdownImages(markdown: string): Array<{ src: string; line: number }> {
  const found: Array<{ src: string; line: number }> = []
  const walk = (children: Token[], line: number, inAlt: boolean): number => {
    for (const child of children) {
      if (child.type === 'image' && !inAlt) found.push({ src: child.attrGet('src') ?? '', line })
      if (child.type === 'softbreak' || child.type === 'hardbreak') line++
      if (child.type === 'image' && child.children) line = walk(child.children, line, true)
    }
    return line
  }
  let line = 1
  for (const tok of tokenizer.parse(markdown, {})) {
    if (tok.map) line = tok.map[0] + 1
    if (tok.type === 'inline') walk(tok.children ?? [], line, false)
  }
  return found
}

/**
 * Reads CommonMark into a normalized rich text doc allowed by `opts`. Anything the
 * format or the field can't hold is reported as a line-numbered problem. Never throws.
 * An image whose target is a key of `extra.images` reads as the library image it maps to.
 */
export function markdownToRichText(
  markdown: string,
  opts?: Partial<RichTextOptions>,
  extra: { images?: ReadonlyMap<string, string> } = {},
): { ok: true; doc: RichTextDoc } | { ok: false; problems: RichTextProblem[] } {
  const options: RichTextOptions = { ...DEFAULT_RICH_TEXT, ...opts }
  const unreadable = (): { ok: false; problems: RichTextProblem[] } => ({
    ok: false,
    problems: [{ code: 'unsupported', line: 1, message: t('richtext.unreadable', { line: 1 }) }],
  })
  try {
    const env = trackingEnv()
    if (extra.images) env.images = extra.images
    const tokens = tokenizer.parse(markdown, env)
    const problems = [...findProblems(tokens, options, env), ...literalSyntaxProblems(markdown)]
    if (problems.length > 0) return { ok: false, problems: problems.sort((a, b) => a.line - b.line) }
    const parseEnv: ParseEnv = extra.images ? { images: extra.images } : {}
    const node = parser.parse(markdown, parseEnv)
    const parsed = parseRichText(node.toJSON(), options)
    return parsed.ok ? parsed : unreadable()
  } catch {
    return unreadable()
  }
}
