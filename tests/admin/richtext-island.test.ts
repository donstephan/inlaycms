// @vitest-environment happy-dom
// happy-dom has no XPathEvaluator, which htmx creates when it loads (to find `hx-on` attributes).
vi.hoisted(() => {
  Object.assign(globalThis, {
    XPathEvaluator: class {
      createExpression() {
        return { evaluate: () => ({ iterateNext: () => null }) }
      }
    },
  })
})

import { isDeepStrictEqual } from 'node:util'
import htmxModule from 'htmx.org'
import { mountRichText } from '../../client/admin/editor.js'
import { openPicker, type Pick } from '../../client/admin/picker.js'
import { WebAddress } from '../../src/adapters/admin/screens/pickers.js'
import { f } from '../../src/core/fields/builtins.js'
import { fieldMeta, type AgentRefs } from '../../src/core/fields/define.js'
import { inlineTextWidget, richTextWidget } from '../../src/core/fields/widgets.js'
import { parseInlineText } from '../../src/core/richtext/inline.js'
import { markdownToRichText } from '../../src/core/richtext/markdown.js'
import { DEFAULT_RICH_TEXT, parseRichText, type RichTextDoc, type RichTextTable } from '../../src/core/richtext/schema.js'
import { renderToString } from '../../src/jsx/html.js'
import { jsx } from '../../src/jsx/jsx-runtime.js'

const htmx = htmxModule as unknown as typeof htmxModule.default

const refs: AgentRefs = {
  document: () => null,
  media: () => ({ status: 'unknown' }),
  mediaUrl: (id) => `/media/${id}`,
}

const DOC = '33333333-3333-4333-8333-333333333333'
const SHA = 'd'.repeat(64)

type Field = ReturnType<typeof f.richText> | ReturnType<typeof f.inlineText>

async function mount(schema: Field, value: unknown, opts: { readOnly?: boolean } = {}) {
  const widget = fieldMeta(schema)!.kind === 'inlineText' ? inlineTextWidget : richTextWidget
  const html = await renderToString(
    widget.render({
      name: 'fields.body',
      id: 'f-fields-body',
      value,
      meta: fieldMeta(schema)!,
      optional: false,
      readOnly: opts.readOnly === true,
      describedBy: undefined,
      invalid: false,
      refs,
      locale: 'en',
    }),
  )
  document.body.innerHTML = `<form>${html}</form><dialog id="inlay-picker"><div id="inlay-picker-body"></div></dialog>`
  const root = document.querySelector<HTMLElement>('[data-richtext]')!
  const editor = mountRichText(root)
  const hidden = root.querySelector<HTMLInputElement>('input[name="fields.body"]')!
  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button')]
  const button = (command: string) => root.querySelector<HTMLButtonElement>(`[role="toolbar"] button[data-command="${command}"]`)!
  return { root, editor, hidden, buttons, button }
}

const paragraph = (text: string): RichTextDoc => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

function fromMarkdown(markdown: string): RichTextDoc {
  const read = markdownToRichText(markdown)
  if (!read.ok) throw new Error(JSON.stringify(read.problems))
  return read.doc
}

/** A paragraph, a list and a table with a header row (`a`, `b`) and one body row (`c`, `d`). */
const TABLE = fromMarkdown(['before', '', '- item', '', '| a | b |', '| --- | --- |', '| c | d |'].join('\n'))
const TABLE_TOOLS = ['addRowAfter', 'addColumnAfter', 'deleteRow', 'deleteColumn', 'deleteTable']

/** Puts the cursor inside the text node that reads `text`, after its first character. */
function cursorIn(editor: ReturnType<typeof mountRichText>, text: string): void {
  let at = -1
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text === text) at = pos + 1
    return at < 0
  })
  if (at < 0) throw new Error(`no text "${text}"`)
  editor.commands.setTextSelection(at)
}

/** The doc in the hidden input, as the core reads it. */
function written(hidden: HTMLInputElement): RichTextDoc {
  const parsed = parseRichText(JSON.parse(hidden.value), DEFAULT_RICH_TEXT)
  if (!parsed.ok) throw new Error(`not a valid doc: ${hidden.value}`)
  return parsed.doc
}

const tableIn = (doc: RichTextDoc) => doc.content.filter((node): node is RichTextTable => node.type === 'table')
const cellTypes = (table: RichTextTable | undefined) => table?.content.map((row) => row.content.map((cell) => cell.type))

afterEach(() => {
  delete window.InlayAdmin
  vi.restoreAllMocks()
})

describe('rich text island', () => {
  it('gives back the same doc for every feature after a change that changes nothing', async () => {
    const markdown = [
      '## H',
      '',
      `**bold** and *italic* and \`code\` with [x](https://example.com) and [y](inlay:document/${DOC}) and [\`z\`](/z)`,
      '',
      '- one',
      '- two',
      '',
      '3. three',
      '4. four',
      '',
      '> quoted',
      '',
      '| **Name** | Link |',
      '| --- | --- |',
      '| one | [x](https://example.com) |',
      '| two | |',
      '',
      `line one\\`,
      `line two ![alt](inlay:media/${SHA})`,
    ].join('\n')
    const read = markdownToRichText(markdown)
    if (!read.ok) throw new Error(JSON.stringify(read.problems))
    const { doc } = read

    const { editor, hidden } = await mount(f.richText({ label: 'Body' }), doc)
    expect(editor.isEditable).toBe(true)
    expect(JSON.parse(hidden.value)).toEqual(doc)
    editor.view.dispatch(editor.state.tr.insertText('x', 1).delete(1, 2))

    const written: unknown = JSON.parse(hidden.value)
    expect(written).not.toBe(doc)
    const parsed = parseRichText(written, DEFAULT_RICH_TEXT)
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.doc).toEqual(doc)
    expect(isDeepStrictEqual(parsed.ok && parsed.doc, doc)).toBe(true)
  })

  it('shows one toolbar button per allowed feature, labeled from the catalog', async () => {
    const { root, buttons } = await mount(f.richText({ label: 'Body', features: ['bold', 'link'] }), paragraph('Hi'))
    expect(root.getAttribute('data-features')).toBe('bold link')
    expect(buttons()).toHaveLength(2)
    expect(buttons().map((b) => b.textContent)).toEqual(['Bold', 'Link'])
    for (const b of buttons()) {
      expect(b.getAttribute('type')).toBe('button')
      expect(b.getAttribute('aria-pressed')).toBe('false')
    }

    const table = await mount(f.richText({ label: 'Body', features: ['table'] }), paragraph('Hi'))
    expect(table.buttons().map((b) => [b.dataset.command, b.textContent])).toEqual([
      ['table', 'Insert table'],
      ['addRowAfter', 'Add row below'],
      ['addColumnAfter', 'Add column right'],
      ['deleteRow', 'Delete row'],
      ['deleteColumn', 'Delete column'],
      ['deleteTable', 'Delete table'],
    ])
  })

  it('shows each heading level separately and refuses levels that are not allowed', async () => {
    const all = await mount(f.richText({ label: 'Body', features: ['heading'] }), paragraph('Hi'))
    expect(all.buttons().map((b) => b.textContent)).toEqual(['Heading 2', 'Heading 3', 'Heading 4'])

    const { root, editor, buttons } = await mount(f.richText({ label: 'Body', features: ['heading'], headings: [2] }), paragraph('Hi'))
    expect(root.getAttribute('data-headings')).toBe('2')
    expect(buttons()).toHaveLength(1)
    expect(editor.can().toggleHeading({ level: 3 })).toBe(false)
    expect(editor.can().toggleHeading({ level: 2 })).toBe(true)
  })

  it('writes every change into the hidden input and marks active formatting as pressed', async () => {
    const { editor, hidden, button } = await mount(f.richText({ label: 'Body', features: ['bold'] }), paragraph('hello'))
    editor.commands.setTextSelection({ from: 1, to: 6 })
    editor.commands.toggleBold()
    expect(JSON.parse(hidden.value)).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello', marks: [{ type: 'bold' }] }] }],
    })
    expect(button('bold').getAttribute('aria-pressed')).toBe('true')
  })

  it('marks code from the toolbar, and never makes it bold or italic', async () => {
    const { editor, hidden, button } = await mount(f.richText({ label: 'Body', features: ['bold', 'italic', 'code'] }), paragraph('hello'))
    editor.commands.setTextSelection({ from: 1, to: 6 })
    button('bold').click()
    button('code').click()
    expect(written(hidden)).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello', marks: [{ type: 'code' }] }] }],
    })
    expect(button('code').getAttribute('aria-pressed')).toBe('true')
    expect(button('code').textContent).toBe('Code')
    editor.commands.setTextSelection({ from: 1, to: 6 })
    button('italic').click()
    expect(written(hidden)).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello', marks: [{ type: 'code' }] }] }],
    })
  })

  it('fires a bubbling change event when the text changes', async () => {
    const { editor, hidden } = await mount(f.richText({ label: 'Body' }), paragraph('hello'))
    const seen: string[] = []
    const listen = (event: Event) => {
      if (event.target === hidden) seen.push(hidden.value)
    }
    document.addEventListener('change', listen)
    try {
      editor.view.dispatch(editor.state.tr.insertText('!', 6))
      expect(seen).toEqual([JSON.stringify(paragraph('hello!'))])
    } finally {
      document.removeEventListener('change', listen)
    }
  })

  it('leaves the stored value alone until something changes', async () => {
    const { hidden } = await mount(f.richText({ label: 'Body' }), paragraph('hello'))
    expect(hidden.value).toBe(JSON.stringify(paragraph('hello')))
    const empty = await mount(f.richText({ label: 'Body' }), undefined)
    expect(empty.hidden.value).toBe('')
  })

  it('renders images from the media library', async () => {
    const doc: RichTextDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'image', attrs: { media: SHA, alt: 'A cat' } }] }] }
    const { root } = await mount(f.richText({ label: 'Body' }), doc)
    const img = root.querySelector(`img[src="/media/${SHA}/640.webp"]`)!
    expect(img).not.toBeNull()
    expect(img.getAttribute('alt')).toBe('A cat')
  })

  it('opens the media picker for images and inserts the chosen one', async () => {
    const openPicker = vi.fn<(url: string, onPick: (pick: Pick) => void) => void>()
    window.InlayAdmin = { openPicker }
    const { hidden, button } = await mount(f.richText({ label: 'Body', features: ['image'] }), paragraph('hi'))
    button('image').click()
    expect(openPicker).toHaveBeenCalledTimes(1)
    const [url, onPick] = openPicker.mock.calls[0]!
    expect(url).toContain('/admin/pick/media?kind=image')
    onPick({ value: SHA, label: 'cat.jpg', thumb: `/media/${SHA}/320.webp` })
    const parsed = parseRichText(JSON.parse(hidden.value), DEFAULT_RICH_TEXT)
    expect(parsed.ok && JSON.stringify(parsed.doc)).toContain(`"media":"${SHA}"`)
  })

  it('links to a page or a web address from the documents picker, and removes a link', async () => {
    const openPicker = vi.fn<(url: string, onPick: (pick: Pick) => void) => void>()
    window.InlayAdmin = { openPicker }
    const { editor, hidden, button } = await mount(f.richText({ label: 'Body', features: ['link'] }), paragraph('hello'))

    editor.commands.setTextSelection({ from: 1, to: 6 })
    button('link').click()
    const [url, onPick] = openPicker.mock.calls[0]!
    expect(url).toBe('/admin/pick/documents?locale=en&web=1')
    onPick({ value: DOC, label: 'About — /about' })
    const marks = () => (JSON.parse(hidden.value) as { content: { content: { marks?: unknown }[] }[] }).content[0]!.content[0]!.marks
    expect(marks()).toEqual([{ type: 'link', attrs: { href: null, document: DOC } }])
    expect(button('link').getAttribute('aria-pressed')).toBe('true')

    editor.commands.setTextSelection({ from: 1, to: 6 })
    button('link').click()
    expect(openPicker).toHaveBeenCalledTimes(1)
    expect(marks()).toBeUndefined()

    editor.commands.setTextSelection({ from: 1, to: 6 })
    button('link').click()
    openPicker.mock.calls[1]![1]({ value: 'url:https://example.com/a', label: 'https://example.com/a' })
    expect(marks()).toEqual([{ type: 'link', attrs: { href: 'https://example.com/a', document: null } }])

    editor.commands.setTextSelection({ from: 1, to: 6 })
    button('link').click()
    editor.commands.setTextSelection({ from: 1, to: 6 })
    button('link').click()
    openPicker.mock.calls[2]![1]({ value: 'url:javascript:alert(1)', label: 'x' })
    expect(marks()).toBeUndefined()
  })

  it('moves between toolbar buttons with the arrow keys', async () => {
    const { buttons } = await mount(f.richText({ label: 'Body', features: ['bold', 'italic', 'link'] }), paragraph('hi'))
    const [bold, italic, link] = buttons()
    expect(buttons().map((b) => b.tabIndex)).toEqual([0, -1, -1])
    bold!.focus()
    bold!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement).toBe(italic)
    expect(buttons().map((b) => b.tabIndex)).toEqual([-1, 0, -1])
    italic!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(document.activeElement).toBe(link)
    link!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement).toBe(bold)
  })

  it('inserts a 3×3 table with a header row', async () => {
    const { editor, hidden, button } = await mount(f.richText({ label: 'Body' }), paragraph('Hi'))
    editor.commands.setTextSelection(3)
    expect(button('table').disabled).toBe(false)
    button('table').click()
    const tables = tableIn(written(hidden))
    expect(tables).toHaveLength(1)
    expect(cellTypes(tables[0])).toEqual([
      ['tableHeader', 'tableHeader', 'tableHeader'],
      ['tableCell', 'tableCell', 'tableCell'],
      ['tableCell', 'tableCell', 'tableCell'],
    ])
  })

  it('shows row and column buttons only inside a table, and no Delete row on the header row', async () => {
    const { editor, button } = await mount(f.richText({ label: 'Body' }), TABLE)
    const shown = () => TABLE_TOOLS.filter((command) => !button(command).hidden)
    expect(shown()).toEqual([])
    cursorIn(editor, 'd')
    expect(shown()).toEqual(TABLE_TOOLS)
    cursorIn(editor, 'b')
    expect(shown()).toEqual(['addRowAfter', 'addColumnAfter', 'deleteColumn', 'deleteTable'])
    cursorIn(editor, 'before')
    expect(shown()).toEqual([])
    expect(button('table').hidden).toBe(false)
  })

  it('disables the image and line-break buttons and Insert table inside a cell', async () => {
    const { editor, button } = await mount(f.richText({ label: 'Body' }), TABLE)
    const disabled = () => ['image', 'hardBreak', 'table'].map((command) => button(command).disabled)
    cursorIn(editor, 'c')
    expect(disabled()).toEqual([true, true, true])
    cursorIn(editor, 'a')
    expect(disabled()).toEqual([true, true, true])
    cursorIn(editor, 'before')
    expect(disabled()).toEqual([false, false, false])
    cursorIn(editor, 'item')
    expect(disabled()).toEqual([false, false, true])
  })

  it('ignores Enter in a cell', async () => {
    const { editor, hidden } = await mount(f.richText({ label: 'Body' }), TABLE)
    cursorIn(editor, 'c')
    const before = hidden.value
    for (const key of ['Enter', 'Shift-Enter', 'Mod-Enter']) editor.commands.keyboardShortcut(key)
    expect(hidden.value).toBe(before)

    cursorIn(editor, 'before')
    editor.commands.keyboardShortcut('Enter')
    expect(written(hidden).content.slice(0, 2)).toEqual([...paragraph('b').content, ...paragraph('efore').content])
  })

  it('deletes the table when its last column is deleted, and keeps it valid when its last body row is', async () => {
    const { editor, hidden, button } = await mount(f.richText({ label: 'Body' }), TABLE)
    cursorIn(editor, 'c')
    expect(button('deleteRow').hidden).toBe(false)
    button('deleteRow').click()
    expect(cellTypes(tableIn(written(hidden))[0])).toEqual([['tableHeader', 'tableHeader']])

    cursorIn(editor, 'a')
    expect(button('deleteRow').hidden).toBe(true)
    button('deleteColumn').click()
    expect(tableIn(written(hidden))).toEqual([
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }] }] },
    ])

    expect(button('deleteColumn').hidden).toBe(false)
    button('deleteColumn').click()
    expect(written(hidden).content.map((node) => node.type)).toEqual(['paragraph', 'bulletList'])
    expect(TABLE_TOOLS.filter((command) => !button(command).hidden)).toEqual([])
  })

  it('skips hidden and disabled buttons when moving with the arrow keys', async () => {
    const doc = fromMarkdown(['before', '', '| a | b |', '| --- | --- |', '| c | d |'].join('\n'))
    const { editor, buttons, button } = await mount(f.richText({ label: 'Body', features: ['bold', 'image', 'table'] }), doc)
    const focused = () => (document.activeElement as HTMLElement).dataset.command
    const press = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    const tabbable = () => buttons().filter((b) => b.tabIndex === 0).map((b) => b.dataset.command)

    cursorIn(editor, 'c')
    button('bold').focus()
    press('ArrowRight')
    expect(focused()).toBe('addRowAfter')
    press('ArrowLeft')
    expect(focused()).toBe('bold')
    press('ArrowLeft')
    expect(focused()).toBe('deleteTable')
    press('Home')
    expect(focused()).toBe('bold')
    press('End')
    expect(focused()).toBe('deleteTable')
    expect(tabbable()).toEqual(['deleteTable'])

    cursorIn(editor, 'before')
    expect(tabbable()).toEqual(['bold'])
    button('bold').focus()
    press('ArrowLeft')
    expect(focused()).toBe('table')
    press('ArrowLeft')
    expect(focused()).toBe('image')
  })

  it('labels the editable area and shows read-only text without a toolbar', async () => {
    const { editor, root } = await mount(f.richText({ label: 'Body' }), paragraph('hi'))
    const area = root.querySelector('[contenteditable]')!
    expect(area.getAttribute('aria-label')).toBe('Body')
    expect(area.getAttribute('role')).toBe('textbox')
    expect(editor.isEditable).toBe(true)

    const ro = await mount(f.richText({ label: 'Body' }), paragraph('hi'), { readOnly: true })
    expect(ro.editor.isEditable).toBe(false)
    expect(ro.buttons()).toHaveLength(0)
    expect(ro.hidden.disabled).toBe(true)
  })

  it('does not overwrite text it cannot show', async () => {
    const stored = { type: 'doc', content: [{ type: 'horizontalRule' }] }
    const { editor, hidden, root } = await mount(f.richText({ label: 'Body' }), stored)
    expect(editor.isEditable).toBe(false)
    expect(root.querySelector<HTMLElement>('[data-richtext-error]')!.hidden).toBe(false)
    editor.commands.insertContent('more')
    expect(hidden.value).toBe(JSON.stringify(stored))
  })

  it('mounts each island once, also after an htmx swap', async () => {
    const { root, editor } = await mount(f.richText({ label: 'Body' }), paragraph('hi'))
    expect(mountRichText(root)).toBe(editor)
    expect(root.querySelectorAll('[contenteditable]')).toHaveLength(1)

    const html = await renderToString(
      richTextWidget.render({
        name: 'fields.other',
        id: 'f-fields-other',
        value: paragraph('swapped'),
        meta: fieldMeta(f.richText({ label: 'Other' }))!,
        optional: true,
        readOnly: false,
        describedBy: undefined,
        invalid: false,
        refs,
        locale: 'en',
      }),
    )
    const target = document.createElement('div')
    target.innerHTML = html
    document.body.append(target)
    target.dispatchEvent(new CustomEvent('htmx:afterSwap', { bubbles: true }))
    expect(target.querySelector('[contenteditable]')!.textContent).toBe('swapped')
    expect(root.querySelectorAll('[contenteditable]')).toHaveLength(1)
  })
})

describe('inline text island', () => {
  const HEADLINE = f.inlineText({ label: 'Headline' })

  it('shows only bold, italic, code and link', async () => {
    const { buttons } = await mount(HEADLINE, paragraph('hi'))
    expect(buttons().map((b) => b.dataset.command)).toEqual(['bold', 'italic', 'code', 'link'])
  })

  it('allows no line break', async () => {
    const { editor, hidden } = await mount(HEADLINE, paragraph('hi'))
    cursorIn(editor, 'hi')
    const before = hidden.value
    for (const key of ['Enter', 'Shift-Enter', 'Mod-Enter']) editor.commands.keyboardShortcut(key)
    expect(editor.state.doc.childCount).toBe(1)
    expect(hidden.value).toBe(before)

    // Claimed, so the browser doesn't add a line of its own.
    for (const shiftKey of [false, true]) {
      const enter = new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true, cancelable: true })
      editor.view.dom.dispatchEvent(enter)
      expect(enter.defaultPrevented).toBe(true)
    }
    expect(hidden.value).toBe(before)
  })

  it('joins pasted paragraphs with spaces', async () => {
    const text = await mount(HEADLINE, undefined)
    text.editor.view.pasteText('one\n\ntwo')
    expect(text.editor.state.doc.childCount).toBe(1)
    expect(text.editor.state.doc.textContent).toBe('one two')
    expect(parseInlineText(JSON.parse(text.hidden.value)).ok).toBe(true)

    const html = await mount(HEADLINE, undefined)
    html.editor.view.pasteHTML('<p><strong>one</strong></p><p></p><p>two</p>')
    expect(html.editor.state.doc.childCount).toBe(1)
    expect(html.editor.state.doc.textContent).toBe('one two')
    const parsed = parseInlineText(JSON.parse(html.hidden.value))
    expect(parsed.ok && parsed.doc).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one', marks: [{ type: 'bold' }] }, { type: 'text', text: ' two' }] }],
    })
  })

  it('marks the area as one line', async () => {
    const { root } = await mount(HEADLINE, paragraph('hi'))
    expect(root.hasAttribute('data-inline')).toBe(true)
    expect(root.querySelector('[contenteditable]')!.getAttribute('aria-multiline')).toBe('false')

    const body = await mount(f.richText({ label: 'Body' }), paragraph('hi'))
    expect(body.root.querySelector('[contenteditable]')!.getAttribute('aria-multiline')).toBe('true')
  })
})

describe('web address in the documents picker', () => {
  async function open() {
    vi.spyOn(htmx, 'ajax').mockResolvedValue(undefined)
    document.body.innerHTML = '<button id="opener" type="button">x</button><dialog id="inlay-picker"><div id="inlay-picker-body"></div></dialog>'
    const picks: Pick[] = []
    openPicker('/admin/pick/documents?locale=en&web=1', (pick) => picks.push(pick))
    document.getElementById('inlay-picker-body')!.innerHTML = await renderToString(jsx(WebAddress, {}))
    const input = document.querySelector<HTMLInputElement>('#inlay-picker [data-pick-web] input')!
    const use = document.querySelector<HTMLButtonElement>('#inlay-picker [data-pick-web-use]')!
    return { picks, input, use }
  }

  it('picks the address typed in, as a url: value', async () => {
    const { picks, input, use } = await open()
    expect(use.getAttribute('type')).toBe('button')
    expect(document.querySelector(`label[for="${input.id}"]`)!.textContent).toContain('web address')
    input.value = '  https://example.com/x  '
    use.click()
    expect(picks).toEqual([{ value: 'url:https://example.com/x', label: 'https://example.com/x' }])
  })

  it('picks the address when Enter is pressed, without submitting the form', async () => {
    const { picks, input } = await open()
    input.value = '/blog'
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    input.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(true)
    expect(picks).toEqual([{ value: 'url:/blog', label: '/blog' }])
  })

  it('refuses addresses a link cannot hold, and says so', async () => {
    const { picks, input, use } = await open()
    const problem = document.querySelector<HTMLElement>('[data-pick-web-problem]')!
    expect(problem.hidden).toBe(true)
    for (const bad of ['javascript:alert(1)', '', '//evil.example', 'not an address']) {
      input.value = bad
      use.click()
    }
    expect(picks).toEqual([])
    expect(problem.hidden).toBe(false)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toContain(problem.id)
  })
})

describe('code blocks', () => {
  const CODE: RichTextDoc = {
    type: 'doc',
    content: [{ type: 'codeBlock', attrs: { language: 'C#' }, content: [{ type: 'text', text: 'var a = 1\n\n  b()' }] }],
  }
  const language = (root: HTMLElement) => root.querySelector<HTMLInputElement>('input[data-code-language]')!
  const setLanguage = (root: HTMLElement, value: string) => {
    const box = language(root)
    box.value = value
    box.dispatchEvent(new Event('change', { bubbles: true }))
  }

  it('puts the Code block button after Quote, and only on fields that allow it', async () => {
    const all = await mount(f.richText({ label: 'Body' }), paragraph('Hi'))
    const commands = all.buttons().map((b) => b.dataset.command)
    expect(commands.indexOf('codeBlock')).toBe(commands.indexOf('blockquote') + 1)
    const some = await mount(f.richText({ label: 'Body', features: ['bold'] }), paragraph('Hi'))
    expect(some.root.querySelector('[data-command="codeBlock"]')).toBeNull()
    expect(some.root.querySelector('input[data-code-language]')).toBeNull()
  })

  it('turns a paragraph into a code block', async () => {
    const { editor, hidden, button } = await mount(f.richText({ label: 'Body' }), paragraph('Hi'))
    cursorIn(editor, 'Hi')
    button('codeBlock').click()
    editor.commands.insertContent('x')
    expect(written(hidden).content[0]?.type).toBe('codeBlock')
  })

  it('shows the language box only inside a code block', async () => {
    const { editor, root, button } = await mount(f.richText({ label: 'Body' }), paragraph('Hi'))
    cursorIn(editor, 'Hi')
    expect(language(root).hidden).toBe(true)
    button('codeBlock').click()
    expect(language(root).hidden).toBe(false)
    expect(language(root).getAttribute('aria-label')).toBe('Code language')
  })

  it('stores, clears and refuses languages', async () => {
    const { editor, root, hidden, button } = await mount(f.richText({ label: 'Body' }), paragraph('Hi'))
    cursorIn(editor, 'Hi')
    button('codeBlock').click()
    editor.commands.insertContent('x')
    setLanguage(root, 'ts')
    expect(written(hidden).content[0]).toEqual({ type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'Hxi' }] })
    const note = root.querySelector<HTMLElement>('[data-code-language-invalid]')!
    expect(note.hidden).toBe(true)
    expect(language(root).hasAttribute('aria-describedby')).toBe(false)
    setLanguage(root, 'a b')
    expect(language(root).getAttribute('aria-invalid')).toBe('true')
    expect(note.hidden).toBe(false)
    expect(note.textContent).toBe('Use only letters, digits and + # _ . - (up to 32), with no spaces.')
    expect(language(root).getAttribute('aria-describedby')).toBe(note.id)
    expect(document.getElementById(note.id)).toBe(note)
    expect(written(hidden).content[0]).toMatchObject({ attrs: { language: 'ts' } })
    setLanguage(root, '')
    expect(language(root).hasAttribute('aria-invalid')).toBe(false)
    expect(language(root).hasAttribute('aria-describedby')).toBe(false)
    expect(note.hidden).toBe(true)
    expect(written(hidden).content[0]).toEqual({ type: 'codeBlock', content: [{ type: 'text', text: 'Hxi' }] })
  })

  it('mounts a stored code block editable and gives it back unchanged', async () => {
    const { editor, root, hidden } = await mount(f.richText({ label: 'Body' }), CODE)
    expect(editor.isEditable).toBe(true)
    expect(editor.getJSON()).toEqual(CODE)
    cursorIn(editor, 'var a = 1\n\n  b()')
    expect(language(root).value).toBe('C#')
    expect(hidden.value).toBe(JSON.stringify(CODE))
  })

  it('drops a pasted language the core would refuse, and keeps a valid one', async () => {
    const { editor, hidden } = await mount(f.richText({ label: 'Body' }), paragraph('Hi'))
    editor.commands.setContent('<pre><code class="language-js{1,3}">x</code></pre>', { emitUpdate: true })
    expect(editor.getJSON().content?.[0]).toEqual({ type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'x' }] })
    expect(written(hidden).content[0]).toEqual({ type: 'codeBlock', content: [{ type: 'text', text: 'x' }] })
    editor.commands.setContent('<p></p>', { emitUpdate: true })
    editor.view.pasteHTML('<pre><code class="language-a&quot;b">y</code></pre>')
    expect(written(hidden).content.find((node) => node.type === 'codeBlock')).toEqual({ type: 'codeBlock', content: [{ type: 'text', text: 'y' }] })
    editor.commands.setContent('<pre><code class="language-ts">z</code></pre>', { emitUpdate: true })
    expect(written(hidden).content[0]).toEqual({ type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'z' }] })
  })

  it('disables the button inside a table', async () => {
    const { editor, button } = await mount(f.richText({ label: 'Body' }), TABLE)
    cursorIn(editor, 'c')
    expect(button('codeBlock').disabled).toBe(true)
    cursorIn(editor, 'before')
    expect(button('codeBlock').disabled).toBe(false)
  })
})
