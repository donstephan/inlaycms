// @vitest-environment happy-dom
import { initSheets } from '../../client/admin/sheet.js'
import { Sheet } from '../../src/adapters/admin/views/sheet.js'
import { raw, renderToString } from '../../src/jsx/html.js'

const BODY = `<input id="f" name="f">
<input type="radio" name="mode" value="a" checked>
<input type="radio" id="rb" name="mode" value="b">
<div id="ma" data-shown-when="mode=a">A</div>
<div id="mb" data-shown-when="mode=b">B</div>`

async function mount(open = false, body = BODY): Promise<HTMLDialogElement> {
  const html = await renderToString(
    Sheet({ id: 's', title: 'T', action: '/x', submit: 'Go', open, children: raw(body) }),
  )
  document.body.innerHTML = `${html}<button data-sheet-open="s">Open</button>`
  initSheets(document)
  return document.getElementById('s') as HTMLDialogElement
}

const opener = () => document.querySelector<HTMLElement>('[data-sheet-open]')!
const cancel = () => document.querySelector<HTMLElement>('footer [data-sheet-close]')!
const backdrop = (dialog: HTMLDialogElement) => dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }))

describe('sheet client', () => {
  it('opens from its button and focuses the first field', async () => {
    const dialog = await mount()
    opener().click()
    expect(dialog.open).toBe(true)
    expect(document.activeElement).toBe(document.getElementById('f'))
  })

  it('closes from the close button and from Cancel', async () => {
    const dialog = await mount()
    opener().click()
    document.querySelector<HTMLElement>('header [data-sheet-close]')!.click()
    expect(dialog.open).toBe(false)
    opener().click()
    cancel().click()
    expect(dialog.open).toBe(false)
  })

  it('closes on a backdrop click only while untouched', async () => {
    const dialog = await mount()
    opener().click()
    backdrop(dialog)
    expect(dialog.open).toBe(false)
    opener().click()
    document.getElementById('f')!.dispatchEvent(new Event('input', { bubbles: true }))
    backdrop(dialog)
    expect(dialog.open).toBe(true)
    cancel().click()
    opener().click()
    backdrop(dialog)
    expect(dialog.open).toBe(false)
  })

  it('opens a server-reopened sheet on load and keeps it from closing on a backdrop click', async () => {
    const dialog = await mount(true, `${BODY}<p role="alert">Fix this</p>`)
    expect(dialog.open).toBe(true)
    backdrop(dialog)
    expect(dialog.open).toBe(true)
  })

  it('shows only the field for the chosen option', async () => {
    await mount()
    expect(document.getElementById('mb')!.hidden).toBe(true)
    const b = document.getElementById('rb') as HTMLInputElement
    b.checked = true
    b.dispatchEvent(new Event('change', { bubbles: true }))
    expect(document.getElementById('ma')!.hidden).toBe(true)
    expect(document.getElementById('mb')!.hidden).toBe(false)
  })

  it('binds once however often it is initialized', () => {
    const doc = document.implementation.createHTMLDocument('x')
    const spy = vi.spyOn(doc, 'addEventListener')
    initSheets(doc)
    initSheets(doc)
    expect(spy.mock.calls.filter(([type]) => type === 'click')).toHaveLength(1)
    expect(spy.mock.calls.filter(([type]) => type === 'change')).toHaveLength(1)
  })

  it('moves focus to the problem alert instead of the first field', async () => {
    const dialog = await mount(true, `${BODY}<p id="al" role="alert">Fix this</p>`)
    const alert = document.getElementById('al')!
    expect(dialog.open).toBe(true)
    expect(alert.getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(alert)
  })

  it('focuses the first invalid field when there is no alert', async () => {
    await mount(true, '<input id="a"><input id="b" aria-invalid="true">')
    expect(document.activeElement).toBe(document.getElementById('b'))
  })

  it('keeps a sheet sent back with field errors from closing on a backdrop click', async () => {
    const dialog = await mount(true, '<input id="a"><input id="b" aria-invalid="true">')
    backdrop(dialog)
    expect(dialog.open).toBe(true)
  })

  it('does not treat an auto-opened sheet without problems as touched', async () => {
    const dialog = await mount(true)
    backdrop(dialog)
    expect(dialog.open).toBe(false)
  })

  it('removes the sheet parameter from the address when it closes', async () => {
    history.replaceState(null, '', '/admin/redirects?sheet=import&q=x')
    const dialog = await mount(true)
    cancel().click()
    expect(dialog.open).toBe(false)
    expect(location.search).toBe('?q=x')
  })

  it('marks the sheet touched on change alone', async () => {
    const dialog = await mount()
    opener().click()
    document.getElementById('f')!.dispatchEvent(new Event('change', { bubbles: true }))
    backdrop(dialog)
    expect(dialog.open).toBe(true)
  })

  it('prefers [autofocus] over document order', async () => {
    await mount(false, `${BODY}<input id="af" name="af" autofocus>`)
    opener().click()
    expect(document.activeElement).toBe(document.getElementById('af'))
  })

  it('focuses a blank password above the invalid field', async () => {
    await mount(true, '<input id="n"><input id="pw" type="password"><input id="cf" type="password" aria-invalid="true">')
    expect(document.activeElement).toBe(document.getElementById('pw'))
  })

  it('focuses the invalid field when the password above it is filled', async () => {
    await mount(true, '<input id="pw" type="password" value="x"><input id="cf" type="password" aria-invalid="true">')
    expect(document.activeElement).toBe(document.getElementById('cf'))
  })

  it('skips an invalid field inside a hidden block, and it is no problem', async () => {
    const dialog = await mount(true, '<input id="a"><div hidden><input id="h" aria-invalid="true"></div>')
    expect(document.activeElement).toBe(document.getElementById('a'))
    backdrop(dialog)
    expect(dialog.open).toBe(false)
  })

  it('ignores an invalid element outside the sheet', async () => {
    const html = await renderToString(Sheet({ id: 's', title: 'T', action: '/x', submit: 'Go', open: true, children: raw('<input id="a">') }))
    document.body.innerHTML = `<input id="out" aria-invalid="true">${html}`
    initSheets(document)
    const dialog = document.getElementById('s') as HTMLDialogElement
    expect(document.activeElement).toBe(document.getElementById('a'))
    backdrop(dialog)
    expect(dialog.open).toBe(false)
  })

  it('prefers an invalid field over [autofocus]', async () => {
    await mount(true, '<input id="af" autofocus><input id="b" aria-invalid="true">')
    expect(document.activeElement).toBe(document.getElementById('b'))
  })
})
