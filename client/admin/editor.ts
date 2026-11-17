import './preview.js'
import { Editor, Extension, Mark, Node, getSchema, type AnyExtension, type Attributes, type JSONContent } from '@tiptap/core'
import { Blockquote } from '@tiptap/extension-blockquote'
import { Bold } from '@tiptap/extension-bold'
import { Code } from '@tiptap/extension-code'
import { Document } from '@tiptap/extension-document'
import { HardBreak } from '@tiptap/extension-hard-break'
import { Heading, type Level } from '@tiptap/extension-heading'
import { Italic } from '@tiptap/extension-italic'
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list'
import { Paragraph } from '@tiptap/extension-paragraph'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { Text } from '@tiptap/extension-text'
import { UndoRedo } from '@tiptap/extensions'
import { Fragment, Slice, type Node as ProseMirrorNode, type Schema } from '@tiptap/pm/model'
import type { Pick } from './picker.js'

/**
 * The rich text island. Node and mark names and attrs mirror `richTextSchema` in the core, so `editor.getJSON()`
 * passes `parseRichText`. Every label comes from the server in `data-labels`.
 */

/** The core's `RICH_TEXT_FEATURES`, in toolbar order. */
const FEATURES = ['heading', 'bold', 'italic', 'code', 'link', 'bulletList', 'orderedList', 'blockquote', 'image', 'hardBreak', 'table'] as const
type Feature = (typeof FEATURES)[number]

const HEX64 = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const URL_PICK = 'url:'

/** Mirrors the core's `isRichTextHref`: an address on this site, or an http(s), mailto or tel URL, without control characters. */
function isLinkAddress(href: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(href)) return false
  if (href.startsWith('/')) return !href.startsWith('//') && !href.startsWith('/\\')
  try {
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(new URL(href).protocol)
  } catch {
    return false
  }
}

/** An inline image from the media library: `{ media, alt }`. */
const InlayImage = Node.create({
  name: 'image',
  inline: true,
  group: 'inline',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      media: { default: null, parseHTML: (el) => el.getAttribute('data-media'), renderHTML: () => ({}) },
      alt: { default: null, parseHTML: (el) => el.getAttribute('alt') || null, renderHTML: () => ({}) },
    }
  },
  parseHTML() {
    return [{ tag: 'img[data-media]', getAttrs: (el) => (HEX64.test(el.getAttribute('data-media') ?? '') ? null : false) }]
  },
  renderHTML({ node }) {
    const media = typeof node.attrs.media === 'string' && HEX64.test(node.attrs.media) ? node.attrs.media : null
    return [
      'img',
      { src: media === null ? null : `/media/${media}/640.webp`, alt: typeof node.attrs.alt === 'string' ? node.attrs.alt : '', 'data-media': media },
    ]
  },
})

/** A link to a web address (`href`) or to a page of this site (`document`, its group id). */
const InlayLink = Mark.create({
  name: 'link',
  inclusive: false,
  addAttributes() {
    return {
      href: {
        default: null,
        parseHTML: (el) => {
          const href = el.getAttribute('href')
          return el.hasAttribute('data-document') || href === null || !isLinkAddress(href) ? null : href
        },
        renderHTML: () => ({}),
      },
      document: {
        default: null,
        parseHTML: (el) => {
          const id = el.getAttribute('data-document')
          return id !== null && UUID.test(id) ? id : null
        },
        renderHTML: () => ({}),
      },
    }
  },
  parseHTML() {
    return [
      { tag: 'a[data-document]', getAttrs: (el) => (UUID.test(el.getAttribute('data-document') ?? '') ? null : false) },
      { tag: 'a[href]', getAttrs: (el) => (isLinkAddress(el.getAttribute('href') ?? '') ? null : false) },
    ]
  },
  renderHTML({ mark }) {
    const { href, document } = mark.attrs
    if (typeof document === 'string') return ['a', { 'data-document': document }, 0]
    return ['a', { href: typeof href === 'string' && isLinkAddress(href) ? href : null, rel: 'noopener noreferrer nofollow' }, 0]
  },
})

/** Code goes inside a link but never with bold or italic, as in the core. */
const InlayCode = Code.extend({ excludes: 'bold italic code' })

/** Headings hold text only, as in the core. */
const InlayHeading = Heading.extend({ content: 'text*' })

/** Numbered lists keep only where they start (Tiptap's list style `type` isn't stored). */
const InlayOrderedList = OrderedList.extend({
  addAttributes() {
    const { start } = (this.parent?.() ?? {}) as Attributes
    return start === undefined ? {} : { start }
  },
})

/** A cell holds one paragraph, as in the core. Tiptap's cell attrs stay: its table commands need them. */
const InlayTableHeader = TableHeader.extend({ content: 'paragraph' })
const InlayTableCell = TableCell.extend({ content: 'paragraph' })

/** Enter would split the cell's one paragraph, and a line break isn't allowed in a cell. */
const TableKeys = Extension.create({
  name: 'inlayTableKeys',
  priority: 1000,
  addKeyboardShortcuts() {
    const inTable = () => this.editor.isActive('table')
    return { Enter: inTable, 'Shift-Enter': inTable, 'Mod-Enter': inTable }
  },
})

/** Inline text holds one paragraph, as `parseInlineText` in the core. */
const InlineDocument = Document.extend({ content: 'paragraph' })

/** Inline text has no second line: Enter and its variants are claimed and do nothing. */
const InlineKeys = Extension.create({
  name: 'inlayInlineKeys',
  priority: 1000,
  addKeyboardShortcuts() {
    const refuse = () => true
    return { Enter: refuse, 'Shift-Enter': refuse, 'Mod-Enter': refuse }
  },
})

/** A pasted slice of several paragraphs (or other text blocks) as one paragraph, their text joined with spaces. */
function oneParagraph(slice: Slice, schema: Schema): Slice {
  const blocks: ProseMirrorNode[] = []
  slice.content.descendants((node) => {
    if (!node.isTextblock) return true
    blocks.push(node)
    return false
  })
  const paragraph = schema.nodes.paragraph
  if (blocks.length < 2 || !paragraph) return slice
  const inline: ProseMirrorNode[] = []
  for (const block of blocks) {
    if (block.childCount === 0) continue
    if (inline.length > 0) inline.push(schema.text(' '))
    block.content.forEach((node) => inline.push(node))
  }
  return new Slice(Fragment.from(paragraph.create(null, inline)), 1, 1)
}

function extensionsFor(features: ReadonlySet<Feature>, levels: Level[], inline: boolean): AnyExtension[] {
  const out: AnyExtension[] = inline ? [InlineDocument, InlineKeys, Paragraph, Text, UndoRedo] : [Document, Paragraph, Text, UndoRedo]
  if (features.has('heading') && levels.length > 0) out.push(InlayHeading.configure({ levels }))
  if (features.has('bold')) out.push(Bold)
  if (features.has('italic')) out.push(Italic)
  if (features.has('code')) out.push(InlayCode)
  if (features.has('link')) out.push(InlayLink)
  if (features.has('bulletList')) out.push(BulletList)
  if (features.has('orderedList')) out.push(InlayOrderedList)
  if (features.has('bulletList') || features.has('orderedList')) out.push(ListItem)
  if (features.has('blockquote')) out.push(Blockquote)
  if (features.has('hardBreak')) out.push(HardBreak)
  if (features.has('image')) out.push(InlayImage)
  if (features.has('table')) {
    out.push(Table.configure({ resizable: false, allowTableNodeSelection: false }), TableRow, InlayTableHeader, InlayTableCell, TableKeys)
  }
  return out
}

/**
 * The stored doc if this editor can show all of it, `null` for an empty editor, or `undefined` if it can't
 * (it is then shown read-only, and the stored value is left alone).
 */
function initialContent(raw: string, extensions: AnyExtension[]): JSONContent | null | undefined {
  if (raw === '') return null
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof json !== 'object' || json === null) return undefined
  const content = (json as { content?: unknown }).content
  if ((json as { type?: unknown }).type === 'doc' && (content === undefined || (Array.isArray(content) && content.length === 0))) return null
  try {
    getSchema(extensions).nodeFromJSON(json).check()
    return json as JSONContent
  } catch {
    return undefined
  }
}

function readLabels(raw: string | undefined): Record<string, string> {
  try {
    const data: unknown = JSON.parse(raw ?? '{}')
    if (typeof data !== 'object' || data === null) return {}
    return Object.fromEntries(Object.entries(data).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return {}
  }
}

interface Tool {
  command: string
  run(): void
  /** Toggles show whether they are on; buttons that insert something have no state. */
  active?: () => boolean
  /** Shown only where it applies (the table's row and column buttons). */
  shown?: () => boolean
  /** Disabled where its node isn't allowed. */
  enabled?: () => boolean
}

function openPicker(url: string | undefined, onPick: (pick: Pick) => void): void {
  if (url !== undefined) window.InlayAdmin?.openPicker(url, onPick)
}

/** Sets the link on the selection, or inserts the pick's label as a link where nothing is selected. */
function applyLink(editor: Editor, pick: Pick): void {
  let attrs: { href: string | null; document: string | null }
  if (pick.value.startsWith(URL_PICK)) {
    const href = pick.value.slice(URL_PICK.length)
    if (!isLinkAddress(href)) return
    attrs = { href, document: null }
  } else {
    if (!UUID.test(pick.value)) return
    attrs = { href: null, document: pick.value }
  }
  const chain = editor.chain().focus()
  if (editor.state.selection.empty) {
    chain.insertContent({ type: 'text', text: pick.label, marks: [{ type: 'link', attrs }] }).run()
  } else {
    chain.setMark('link', attrs).run()
  }
}

/** The index of the selection's row in its table, or -1 outside a table. */
function rowIndex(editor: Editor): number {
  const { $from } = editor.state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === 'tableRow') return $from.index(depth - 1)
  }
  return -1
}

function toolsFor(editor: Editor, root: HTMLElement, features: ReadonlySet<Feature>, levels: Level[]): Tool[] {
  const tools: Tool[] = []
  for (const feature of FEATURES) {
    if (!features.has(feature)) continue
    switch (feature) {
      case 'heading':
        for (const level of levels) {
          tools.push({
            command: `heading${level}`,
            run: () => editor.chain().focus().toggleHeading({ level }).run(),
            active: () => editor.isActive('heading', { level }),
          })
        }
        break
      case 'bold':
        tools.push({ command: 'bold', run: () => editor.chain().focus().toggleBold().run(), active: () => editor.isActive('bold') })
        break
      case 'italic':
        tools.push({ command: 'italic', run: () => editor.chain().focus().toggleItalic().run(), active: () => editor.isActive('italic') })
        break
      case 'code':
        tools.push({ command: 'code', run: () => editor.chain().focus().toggleCode().run(), active: () => editor.isActive('code') })
        break
      case 'link':
        tools.push({
          command: 'link',
          run() {
            if (editor.isActive('link')) {
              editor.chain().focus().extendMarkRange('link').unsetMark('link').run()
              return
            }
            openPicker(root.dataset.pickLink, (pick) => applyLink(editor, pick))
          },
          active: () => editor.isActive('link'),
        })
        break
      case 'bulletList':
        tools.push({ command: 'bulletList', run: () => editor.chain().focus().toggleBulletList().run(), active: () => editor.isActive('bulletList') })
        break
      case 'orderedList':
        tools.push({ command: 'orderedList', run: () => editor.chain().focus().toggleOrderedList().run(), active: () => editor.isActive('orderedList') })
        break
      case 'blockquote':
        tools.push({ command: 'blockquote', run: () => editor.chain().focus().toggleBlockquote().run(), active: () => editor.isActive('blockquote') })
        break
      case 'image':
        tools.push({
          command: 'image',
          run: () =>
            openPicker(root.dataset.pickImage, (pick) => {
              if (HEX64.test(pick.value)) editor.chain().focus().insertContent({ type: 'image', attrs: { media: pick.value, alt: null } }).run()
            }),
          enabled: () => !editor.isActive('table'),
        })
        break
      case 'hardBreak':
        tools.push({ command: 'hardBreak', run: () => editor.chain().focus().setHardBreak().run(), enabled: () => !editor.isActive('table') })
        break
      case 'table': {
        const inTable = () => editor.isActive('table')
        tools.push(
          {
            command: 'table',
            run: () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
            // Only between top-level blocks: not in a list, a quote or another table.
            enabled: () => editor.state.selection.$from.depth === 1,
          },
          { command: 'addRowAfter', run: () => editor.chain().focus().addRowAfter().run(), shown: inTable },
          { command: 'addColumnAfter', run: () => editor.chain().focus().addColumnAfter().run(), shown: inTable },
          // The first row is the header row.
          { command: 'deleteRow', run: () => editor.chain().focus().deleteRow().run(), shown: () => rowIndex(editor) > 0 },
          {
            command: 'deleteColumn',
            // Tiptap won't delete every column of a table (its last one, say): the table goes instead.
            run() {
              if (!editor.chain().focus().deleteColumn().run()) editor.chain().focus().deleteTable().run()
            },
            shown: inTable,
          },
          { command: 'deleteTable', run: () => editor.chain().focus().deleteTable().run(), shown: inTable },
        )
        break
      }
    }
  }
  return tools
}

/**
 * One button per tool; the arrow keys, Home and End move between the shown, enabled ones, and only one is in the
 * tab order.
 */
function buildToolbar(toolbar: HTMLElement, tools: Tool[], labels: Record<string, string>): () => void {
  const buttons = tools.map((tool, i) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn btn-ghost btn-sm aria-pressed:btn-active'
    button.dataset.command = tool.command
    button.textContent = labels[tool.command] ?? tool.command
    button.tabIndex = i === 0 ? 0 : -1
    if (tool.active) button.setAttribute('aria-pressed', 'false')
    button.addEventListener('click', () => tool.run())
    return button
  })
  toolbar.replaceChildren(...buttons)

  const usable = () => buttons.filter((b) => !b.hidden && !b.disabled)
  const focusAt = (index: number) => {
    const open = usable()
    const n = open.length
    const target = open[((index % n) + n) % n]
    if (!target) return
    for (const b of buttons) b.tabIndex = b === target ? 0 : -1
    target.focus()
  }
  toolbar.addEventListener('keydown', (event) => {
    const open = usable()
    const at = open.indexOf(event.target as HTMLButtonElement)
    if (at < 0) return
    const next = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: open.length - 1 }[event.key]
    if (next === undefined) return
    event.preventDefault()
    focusAt(next)
  })

  return () => {
    tools.forEach((tool, i) => {
      const button = buttons[i]
      if (!button) return
      if (tool.active) button.setAttribute('aria-pressed', String(tool.active()))
      if (tool.shown) button.hidden = !tool.shown()
      if (tool.enabled) button.disabled = !tool.enabled()
    })
    const open = usable()
    if (!open.some((b) => b.tabIndex === 0)) for (const b of buttons) b.tabIndex = b === open[0] ? 0 : -1
  }
}

const mounted = new WeakMap<HTMLElement, Editor>()

/**
 * Mounts the editor in a `[data-richtext]` element rendered by the rich text widget (once; later calls return it).
 * With `data-inline` (the inline-text widget) it is a one-line editor: one paragraph, and pasted lines joined.
 */
export function mountRichText(root: HTMLElement): Editor {
  const existing = mounted.get(root)
  if (existing) return existing

  const features = new Set((root.dataset.features ?? '').split(' ').filter((f): f is Feature => (FEATURES as readonly string[]).includes(f)))
  const levels = (root.dataset.headings ?? '')
    .split(' ')
    .map(Number)
    .filter((n): n is Level => Number.isInteger(n) && n >= 1 && n <= 6)
  const labels = readLabels(root.dataset.labels)
  const mount = root.querySelector<HTMLElement>('[data-richtext-mount]') ?? root
  const input = root.querySelector<HTMLInputElement>(':scope > input[type="hidden"]')
  const toolbar = root.querySelector<HTMLElement>('[role="toolbar"]')
  const inline = root.hasAttribute('data-inline')

  const extensions = extensionsFor(features, levels, inline)
  const content = initialContent(input?.value ?? '', extensions)
  const readable = content !== undefined
  const editable = readable && !root.hasAttribute('data-readonly')
  if (!readable) {
    const problem = root.querySelector<HTMLElement>('[data-richtext-error]')
    if (problem) problem.hidden = false
  }

  const attributes: Record<string, string> = { role: 'textbox', 'aria-multiline': String(!inline) }
  for (const name of ['aria-label', 'aria-describedby', 'aria-invalid']) {
    const value = mount.getAttribute(name)
    if (value !== null) attributes[name] = value
  }
  if (!editable) attributes['aria-readonly'] = 'true'

  const editor = new Editor({
    element: mount,
    extensions,
    content,
    editable,
    editorProps: inline
      ? {
          attributes,
          transformPastedText: (text) => text.replace(/\s*[\r\n]+\s*/g, ' '),
          transformPasted: (slice, view) => oneParagraph(slice, view.state.schema),
        }
      : { attributes },
    onUpdate: ({ editor: e }) => {
      if (!input || !readable) return
      input.value = JSON.stringify(e.getJSON())
      input.dispatchEvent(new Event('change', { bubbles: true }))
    },
  })
  mounted.set(root, editor)

  if (toolbar && editable) {
    const refresh = buildToolbar(toolbar, toolsFor(editor, root, features, levels), labels)
    editor.on('transaction', refresh)
    refresh()
  }
  return editor
}

function mountAll(scope: ParentNode): void {
  for (const root of scope.querySelectorAll<HTMLElement>('[data-richtext]')) mountRichText(root)
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mountAll(document))
else mountAll(document)
// An outerHTML swap fires on the element it replaced, so look through the whole page; mounted islands are skipped.
document.addEventListener('htmx:afterSwap', () => mountAll(document))
