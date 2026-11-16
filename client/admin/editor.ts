import './preview.js'
import { Editor, Mark, Node, getSchema, type AnyExtension, type Attributes, type JSONContent } from '@tiptap/core'
import { Blockquote } from '@tiptap/extension-blockquote'
import { Bold } from '@tiptap/extension-bold'
import { Document } from '@tiptap/extension-document'
import { HardBreak } from '@tiptap/extension-hard-break'
import { Heading, type Level } from '@tiptap/extension-heading'
import { Italic } from '@tiptap/extension-italic'
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list'
import { Paragraph } from '@tiptap/extension-paragraph'
import { Text } from '@tiptap/extension-text'
import { UndoRedo } from '@tiptap/extensions'
import type { Pick } from './picker.js'

/**
 * The rich text island. Node and mark names and attrs mirror `richTextSchema` in the core, so `editor.getJSON()`
 * passes `parseRichText`. Every label comes from the server in `data-labels`.
 */

/** The core's `RICH_TEXT_FEATURES`, in toolbar order. */
const FEATURES = ['heading', 'bold', 'italic', 'link', 'bulletList', 'orderedList', 'blockquote', 'image', 'hardBreak'] as const
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

/** Headings hold text only, as in the core. */
const InlayHeading = Heading.extend({ content: 'text*' })

/** Numbered lists keep only where they start (Tiptap's list style `type` isn't stored). */
const InlayOrderedList = OrderedList.extend({
  addAttributes() {
    const { start } = (this.parent?.() ?? {}) as Attributes
    return start === undefined ? {} : { start }
  },
})

function extensionsFor(features: ReadonlySet<Feature>, levels: Level[]): AnyExtension[] {
  const out: AnyExtension[] = [Document, Paragraph, Text, UndoRedo]
  if (features.has('heading') && levels.length > 0) out.push(InlayHeading.configure({ levels }))
  if (features.has('bold')) out.push(Bold)
  if (features.has('italic')) out.push(Italic)
  if (features.has('link')) out.push(InlayLink)
  if (features.has('bulletList')) out.push(BulletList)
  if (features.has('orderedList')) out.push(InlayOrderedList)
  if (features.has('bulletList') || features.has('orderedList')) out.push(ListItem)
  if (features.has('blockquote')) out.push(Blockquote)
  if (features.has('hardBreak')) out.push(HardBreak)
  if (features.has('image')) out.push(InlayImage)
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
        })
        break
      case 'hardBreak':
        tools.push({ command: 'hardBreak', run: () => editor.chain().focus().setHardBreak().run() })
        break
    }
  }
  return tools
}

/** One button per tool; the arrow keys, Home and End move between them, and only one is in the tab order. */
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

  const focusAt = (index: number) => {
    const n = buttons.length
    const target = buttons[((index % n) + n) % n]
    if (!target) return
    for (const b of buttons) b.tabIndex = b === target ? 0 : -1
    target.focus()
  }
  toolbar.addEventListener('keydown', (event) => {
    const at = buttons.indexOf(event.target as HTMLButtonElement)
    if (at < 0) return
    const next = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: buttons.length - 1 }[event.key]
    if (next === undefined) return
    event.preventDefault()
    focusAt(next)
  })

  return () => {
    tools.forEach((tool, i) => {
      if (tool.active) buttons[i]?.setAttribute('aria-pressed', String(tool.active()))
    })
  }
}

const mounted = new WeakMap<HTMLElement, Editor>()

/** Mounts the editor in a `[data-richtext]` element rendered by the rich text widget (once; later calls return it). */
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

  const extensions = extensionsFor(features, levels)
  const content = initialContent(input?.value ?? '', extensions)
  const readable = content !== undefined
  const editable = readable && !root.hasAttribute('data-readonly')
  if (!readable) {
    const problem = root.querySelector<HTMLElement>('[data-richtext-error]')
    if (problem) problem.hidden = false
  }

  const attributes: Record<string, string> = { role: 'textbox', 'aria-multiline': 'true' }
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
    editorProps: { attributes },
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
