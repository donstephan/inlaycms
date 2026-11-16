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
import { richTextWidget } from '../../src/core/fields/widgets.js'
import { markdownToRichText } from '../../src/core/richtext/markdown.js'
import { DEFAULT_RICH_TEXT, parseRichText, type RichTextDoc } from '../../src/core/richtext/schema.js'
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

type Field = ReturnType<typeof f.richText>

async function mount(schema: Field, value: unknown, opts: { readOnly?: boolean } = {}) {
  const html = await renderToString(
    richTextWidget.render({
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

afterEach(() => {
  delete window.InlayAdmin
  vi.restoreAllMocks()
})

describe('rich text island', () => {
  it('gives back the same doc for every feature after a change that changes nothing', async () => {
    const markdown = [
      '## H',
      '',
      `**bold** and *italic* with [x](https://example.com) and [y](inlay:document/${DOC})`,
      '',
      '- one',
      '- two',
      '',
      '3. three',
      '4. four',
      '',
      '> quoted',
      '',
      `line one\\`,
      `line two ![alt](inlay:media/${SHA})`,
    ].join('\n')
    const read = markdownToRichText(markdown)
    if (!read.ok) throw new Error(JSON.stringify(read.problems))
    const { doc } = read

    const { editor, hidden } = await mount(f.richText({ label: 'Body' }), doc)
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
    const stored = { type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'x' }] }] }
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
