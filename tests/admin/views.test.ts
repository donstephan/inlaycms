import { Icon } from '../../src/adapters/admin/views/icons.js'
import { Time } from '../../src/adapters/admin/views/layout.js'
import { Sheet } from '../../src/adapters/admin/views/sheet.js'
import { StatusDot, StatusLabel, statusTone } from '../../src/adapters/admin/views/status.js'
import { raw, renderToString } from '../../src/jsx/html.js'
import { parseHtml } from '../helpers/admin.js'

describe('status', () => {
  it('draws a status badge with plain text and a colored dot', async () => {
    const el = parseHtml(await renderToString(StatusLabel({ status: 'changed' }))).querySelector('.badge')!
    expect(el.className).toContain('badge-soft')
    expect(el.className).toContain('badge-warning')
    expect(el.className).toContain('text-base-content')
    expect(el.className).not.toMatch(/text-warning/)
    expect(el.querySelector('[aria-hidden="true"].bg-warning')).not.toBeNull()
    expect(el.textContent).toBe('Unpublished changes')
  })

  it('maps each status to a tone and a dot', async () => {
    expect(statusTone('published')).toBe('success')
    expect(statusTone('changed')).toBe('warning')
    expect(statusTone('new')).toBe('info')
    expect(statusTone('deleted')).toBe('neutral')
    const dot = parseHtml(await renderToString(StatusDot({ status: 'published' }))).querySelector('span')!
    expect(dot.className).toContain('bg-success')
    expect(dot.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('icons', () => {
  it('hides icons from screen readers', async () => {
    const svg = parseHtml(await renderToString(Icon({ name: 'collection', class: 'text-primary' }))).querySelector('svg')!
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('focusable')).toBe('false')
    expect(svg.getAttribute('class')).toBe('size-4 shrink-0 text-primary')
    expect(svg.querySelector('path')).not.toBeNull()
  })
})

describe('Time', () => {
  it('marks relative times and keeps the UTC text', async () => {
    const el = parseHtml(await renderToString(Time({ iso: '2026-11-02T10:00:00Z', relative: true }))).querySelector('time')!
    expect(el.hasAttribute('data-local')).toBe(true)
    expect(el.hasAttribute('data-relative')).toBe(true)
    expect(el.getAttribute('datetime')).toBe('2026-11-02T10:00:00Z')
    expect(el.getAttribute('title')).toContain('UTC')
    expect(el.textContent).toContain('UTC')
  })

  it('stays absolute by default', async () => {
    const el = parseHtml(await renderToString(Time({ iso: '2026-11-02T10:00:00Z' }))).querySelector('time')!
    expect(el.hasAttribute('data-relative')).toBe(false)
    expect(el.hasAttribute('title')).toBe(false)
  })
})

describe('Sheet', () => {
  it('renders a dialog holding one post form with a header, body and footer', async () => {
    const doc = parseHtml(
      await renderToString(
        Sheet({ id: 's', title: 'Add a thing', description: 'Why', action: '/admin/x', submit: 'Add', children: raw('<input id="f" name="f">') }),
      ),
    )
    const dialog = doc.querySelector('dialog#s.sheet[data-sheet]')!
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute('aria-labelledby')).toBe('s-title')
    expect(dialog.getAttribute('aria-describedby')).toBe('s-desc')
    expect(dialog.hasAttribute('data-sheet-autoopen')).toBe(false)
    expect(dialog.classList.contains('sheet-lg')).toBe(false)
    expect(dialog.querySelector('h2#s-title')!.textContent).toBe('Add a thing')
    expect(dialog.querySelector('p#s-desc')!.textContent).toBe('Why')
    const form = dialog.querySelector('form[method="post"][action="/admin/x"]')!
    expect(form.querySelector('#f')).not.toBeNull()
    const close = form.querySelector('header button')!
    expect(close.getAttribute('aria-label')).toBe('Close')
    expect(close.hasAttribute('data-sheet-close')).toBe(true)
    const buttons = [...form.querySelectorAll('footer button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Add'])
    expect(buttons[1]!.getAttribute('type')).toBe('submit')
    expect(buttons[1]!.classList.contains('btn-primary')).toBe(true)
  })

  it('marks a large sheet, an open one, and a multipart form', async () => {
    const doc = parseHtml(
      await renderToString(Sheet({ id: 's', title: 'T', size: 'lg', open: true, enctype: 'multipart/form-data', action: '/x', submit: 'Go' })),
    )
    const dialog = doc.querySelector('dialog#s')!
    expect(dialog.classList.contains('sheet-lg')).toBe(true)
    expect(dialog.hasAttribute('data-sheet-autoopen')).toBe(true)
    expect(dialog.hasAttribute('aria-describedby')).toBe(false)
    expect(doc.querySelector('#s-desc')).toBeNull()
    expect(doc.querySelector('form')!.getAttribute('enctype')).toBe('multipart/form-data')
  })
})
