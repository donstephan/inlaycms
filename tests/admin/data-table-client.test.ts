// @vitest-environment happy-dom
// The bulk Delete dialog loads its confirmation through htmx; stand in for its `ajax`.
const ajax = vi.hoisted(() => vi.fn<(verb: string, url: string, opts: { target: string; select: string }) => Promise<void>>())
vi.mock('htmx.org', () => ({ default: { ajax } }))

import { initDataTables, initDropdowns } from '../../client/admin/data-table.js'
import { DataTable } from '../../src/adapters/admin/views/data-table.js'
import { raw, renderToString } from '../../src/jsx/html.js'

const rows = ['a', 'b', 'c']

async function mount(): Promise<void> {
  document.body.innerHTML = await renderToString(
    DataTable({
      id: 't',
      caption: 'Posts',
      base: '/admin/collections/posts',
      rows,
      columns: [{ key: 'title', label: 'Title', cell: (r: string) => r }],
      rowKey: (r) => r,
      rowLabel: (r) => r,
      bulk: { actions: '' },
      empty: 'Nothing',
    }),
  )
  initDataTables(document)
}

const bar = () => document.querySelector<HTMLElement>('[data-bulk-bar]')!
const boxes = () => [...document.querySelectorAll<HTMLInputElement>('input[name="ids"]')]
const selectAll = () => document.querySelector<HTMLInputElement>('[data-select-all]')!

function tick(box: HTMLInputElement, checked = true): void {
  box.checked = checked
  box.dispatchEvent(new Event('change', { bubbles: true }))
}

it('hides the bulk bar until something is ticked, then counts', async () => {
  await mount()
  expect(bar().hidden).toBe(true)
  tick(boxes()[0]!)
  tick(boxes()[2]!)
  expect(bar().hidden).toBe(false)
  expect(bar().querySelector('[data-selected-count]')!.textContent).toBe('2 selected')
  expect(selectAll().checked).toBe(false)
  tick(boxes()[1]!)
  expect(selectAll().checked).toBe(true)
  tick(boxes()[0]!, false)
  tick(boxes()[1]!, false)
  tick(boxes()[2]!, false)
  expect(bar().hidden).toBe(true)
})

it('selects and clears every row on the page', async () => {
  await mount()
  tick(selectAll())
  expect(boxes().every((b) => b.checked)).toBe(true)
  expect(bar().querySelector('[data-selected-count]')!.textContent).toBe('3 selected')
  bar().querySelector<HTMLButtonElement>('[data-clear-selection]')!.click()
  expect(boxes().some((b) => b.checked)).toBe(false)
  expect(selectAll().checked).toBe(false)
  expect(bar().hidden).toBe(true)
})

it('binds each table once, however often it is initialized', async () => {
  await mount()
  initDataTables(document)
  tick(selectAll())
  expect(boxes().every((b) => b.checked)).toBe(true)
  tick(selectAll(), false)
  expect(boxes().some((b) => b.checked)).toBe(false)
})

const CONFIRM = `
  <div id="bulk-delete-confirm">
    <form method="post" action="/admin/collections/posts/delete">
      <button type="submit">Delete</button>
      <a href="/admin/collections/posts" data-dialog-cancel>Cancel</a>
    </form>
  </div>`

async function mountWithDialog(): Promise<HTMLDialogElement> {
  const table = await renderToString(
    DataTable({
      id: 't',
      caption: 'Posts',
      base: '/admin/collections/posts',
      rows,
      columns: [{ key: 'title', label: 'Title', cell: (r: string) => r }],
      rowKey: (r) => r,
      rowLabel: (r) => r,
      bulk: {
        actions: raw(
          '<input type="hidden" name="back" value="/admin/collections/posts?status=new" form="t-bulk" />' +
            '<button type="submit" formaction="/admin/collections/posts/delete" formmethod="get" data-bulk-delete>Delete</button>',
        ),
      },
      empty: 'Nothing',
    }),
  )
  document.body.innerHTML = `${table}
    <dialog id="bulk-delete-dialog"><div id="bulk-delete-body"></div></dialog>`
  initDataTables(document)
  return document.querySelector<HTMLDialogElement>('#bulk-delete-dialog')!
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const deleteButton = () => document.querySelector<HTMLButtonElement>('button[data-bulk-delete]')!

describe('the bulk Delete dialog', () => {
  beforeEach(() => {
    ajax.mockReset()
  })

  it('loads the confirmation, focuses Delete, and closes on Cancel', async () => {
    ajax.mockImplementation(async (_verb, _url, opts) => {
      document.querySelector(opts.target)!.innerHTML = CONFIRM
    })
    const dialog = await mountWithDialog()
    tick(boxes()[1]!)
    deleteButton().click()
    expect(dialog.open).toBe(true)
    await flush()
    expect(ajax).toHaveBeenCalledWith('get', '/admin/collections/posts/delete?ids=b&back=%2Fadmin%2Fcollections%2Fposts%3Fstatus%3Dnew', {
      target: '#bulk-delete-body',
      select: '#bulk-delete-confirm',
    })
    expect(document.activeElement?.textContent).toBe('Delete')
    expect(dialog.contains(document.activeElement)).toBe(true)

    const cancel = dialog.querySelector<HTMLAnchorElement>('[data-dialog-cancel]')!
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    cancel.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(dialog.open).toBe(false)
  })

  it('goes to the confirmation page when loading it fails', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
    try {
      for (const fail of [() => Promise.reject(new Error('offline')), async () => {}]) {
        ajax.mockImplementation(fail)
        const dialog = await mountWithDialog()
        tick(boxes()[0]!)
        deleteButton().click()
        await flush()
        expect(dialog.open).toBe(false)
        expect(assign).toHaveBeenLastCalledWith('/admin/collections/posts/delete?ids=a&back=%2Fadmin%2Fcollections%2Fposts%3Fstatus%3Dnew')
      }
      expect(assign).toHaveBeenCalledTimes(2)
    } finally {
      assign.mockRestore()
    }
  })
})

describe('dropdown menus', () => {
  function mountMenus(): HTMLDetailsElement[] {
    document.body.innerHTML = `
      <details class="dropdown" id="one"><summary>One</summary><ul><li><a href="#a">A</a></li></ul></details>
      <details class="dropdown" id="two"><summary>Two</summary><ul><li><a href="#b">B</a></li></ul></details>
      <p id="outside">Elsewhere</p>`
    initDropdowns(document)
    return [...document.querySelectorAll<HTMLDetailsElement>('details.dropdown')]
  }

  it('closes on Escape and puts focus back on its button', () => {
    const [one] = mountMenus()
    one!.open = true
    const link = one!.querySelector('a')!
    link.focus()
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    link.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(one!.open).toBe(false)
    expect(document.activeElement).toBe(one!.querySelector('summary'))
  })

  it('closes on a click outside, and when another menu opens', () => {
    const [one, two] = mountMenus()
    one!.open = true
    one!.querySelector('a')!.click()
    expect(one!.open).toBe(true)
    document.querySelector<HTMLElement>('#outside')!.click()
    expect(one!.open).toBe(false)

    one!.open = true
    two!.querySelector('summary')!.click()
    expect(one!.open).toBe(false)
  })

  it('leaves Escape alone outside an open menu', () => {
    const [one] = mountMenus()
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    one!.querySelector('summary')!.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(false)
  })
})
