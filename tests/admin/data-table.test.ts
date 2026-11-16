import { DataTable, PAGE_SIZES, pageOf, readTableQuery, tableHref } from '../../src/adapters/admin/views/data-table.js'
import type { Column, DataTableProps, TableQuery } from '../../src/adapters/admin/views/data-table.js'
import { raw, renderToString } from '../../src/jsx/html.js'
import { parseHtml } from '../helpers/admin.js'

interface Post {
  id: string
  title: string
  updated: string
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i)
const q: TableQuery = { q: '', status: 'all', sort: 'updated', dir: 'desc', page: 1, size: 25 }

const posts: Post[] = [
  { id: 'p1', title: 'Bruh', updated: 'today' },
  { id: 'p2', title: 'Alex Rivera', updated: 'yesterday' },
]

const columns: ReadonlyArray<Column<Post>> = [
  { key: 'title', label: 'Title', sortable: true, cell: (p) => p.title },
  { key: 'updated', label: 'Last changed', sortable: true, cell: (p) => p.updated },
]

function props(over: Partial<DataTableProps<Post>> = {}): DataTableProps<Post> {
  return {
    id: 't',
    caption: 'Posts',
    base: '/admin/collections/posts',
    query: q,
    rows: posts,
    columns,
    rowKey: (p) => p.id,
    rowLabel: (p) => p.title,
    empty: 'There is nothing here yet.',
    ...over,
  }
}

async function render(over: Partial<DataTableProps<Post>> = {}): Promise<Document> {
  return parseHtml(await renderToString(DataTable(props(over))))
}

const hrefOf = (el: Element | null) => decodeURIComponent(el?.getAttribute('href') ?? '')

describe('readTableQuery', () => {
  const opts = { sorts: ['title', 'updated'], defaultSort: 'updated', defaultDir: 'desc' as const, statuses: ['all', 'new'] }

  it('falls back on anything it does not know', () => {
    expect(readTableQuery({ page: 'abc', size: '1000', sort: 'evil', dir: 'up', status: 'nope', q: '  hi ' }, opts))
      .toEqual({ q: 'hi', status: 'all', sort: 'updated', dir: 'desc', page: 1, size: 25 })
    expect(readTableQuery({ page: '0' }, opts).page).toBe(1)
    expect(readTableQuery({ page: '-2' }, opts).page).toBe(1)
    expect(readTableQuery({ page: '1.5' }, opts).page).toBe(1)
    expect(readTableQuery({ page: '99999999999999999999' }, opts).page).toBe(1)
    expect(readTableQuery({ page: ['2', '3'], q: ['a', 'b'] }, opts)).toMatchObject({ page: 1, q: '' })
    expect(readTableQuery({ size: '50', page: '3', sort: 'title', dir: 'asc' }, opts)).toMatchObject({ size: 50, page: 3, sort: 'title', dir: 'asc' })
    expect(readTableQuery({ status: 'new' }, opts).status).toBe('new')
  })

  it('has no status when there are no statuses', () => {
    expect(readTableQuery({ status: 'new' }, { sorts: ['title'], defaultSort: 'title', defaultDir: 'asc' }).status).toBe('')
  })

  it('offers 25, 50 and 100 rows', () => {
    expect(PAGE_SIZES).toEqual([25, 50, 100])
  })
})

it('pageOf clamps to the last page', () => {
  expect(pageOf(range(104), { ...q, page: 99, size: 25 })).toMatchObject({ total: 104, page: 5 })
  expect(pageOf(range(104), { ...q, page: 99, size: 25 }).rows).toHaveLength(4)
  expect(pageOf(range(104), { ...q, page: 2, size: 50 }).rows[0]).toBe(50)
  expect(pageOf([], { ...q, page: 3 })).toEqual({ rows: [], total: 0, page: 1 })
})

it('tableHref drops empty values', () => {
  expect(tableHref('/admin/x', { a: '1', b: '', c: 'x y' })).toBe('/admin/x?a=1&c=x+y')
  expect(tableHref('/admin/x', { a: '' })).toBe('/admin/x')
})

it('renders a captioned table with row headers and aria-sort', async () => {
  const doc = await render()
  const region = doc.querySelector('div#t')!
  expect(region.className).toContain('rounded-box')
  expect(region.className).not.toContain('overflow-hidden')
  expect(region.querySelector('.overflow-x-auto')!.className).toContain('lg:overflow-visible')
  const table = region.querySelector('table.table.table-sm')!
  expect(table.querySelector('caption.sr-only')!.textContent).toBe('Posts')
  const heads = [...table.querySelectorAll('tbody th[scope="row"]')].map((th) => th.textContent)
  expect(heads).toEqual(['Bruh', 'Alex Rivera'])
  expect(table.querySelectorAll('[aria-sort]')).toHaveLength(1)
  const sorted = table.querySelector('th[aria-sort="descending"]')!
  expect(sorted.textContent).toContain('Last changed')
  expect(table.querySelector('tbody tr')!.className).toContain('hover:bg-base-200/60')
})

it('flips the direction when the sorted column is clicked again', async () => {
  const doc = await render()
  const [title, updated] = [...doc.querySelectorAll('thead th a')]
  expect(hrefOf(updated!)).toContain('sort=updated&dir=asc')
  expect(hrefOf(title!)).toContain('sort=title&dir=asc')
  const asc = await render({ query: { ...q, sort: 'title', dir: 'asc' } })
  expect(asc.querySelector('th[aria-sort="ascending"]')!.textContent).toContain('Title')
  expect(hrefOf(asc.querySelector('thead th a'))).toContain('sort=title&dir=desc')
  for (const a of doc.querySelectorAll('thead th a')) {
    expect(a.getAttribute('hx-get')).toBe(a.getAttribute('href'))
    expect(a.getAttribute('hx-target')).toBe('#t')
    expect(a.getAttribute('hx-select')).toBe('#t')
    expect(a.getAttribute('hx-swap')).toBe('outerHTML')
    expect(a.getAttribute('hx-push-url')).toBe('true')
  }
})

it('keeps search and kept params in links and resets the page', async () => {
  const doc = await render({
    keep: { locale: 'es', deleted: '' },
    query: { ...q, q: 'cat', page: 3 },
    total: 104,
    search: { label: 'Search posts' },
    tabs: [
      { key: 'all', label: 'All', count: 104 },
      { key: 'new', label: 'New', count: 3 },
    ],
  })
  const tabs = doc.querySelectorAll('.tabs.tabs-box.tabs-sm a.tab')
  expect(tabs).toHaveLength(2)
  const tab = hrefOf(tabs[1]!)
  expect(tab).toContain('locale=es')
  expect(tab).toContain('q=cat')
  expect(tab).toContain('status=new')
  expect(tab).not.toContain('page=')
  expect(tab).not.toContain('deleted=')
  expect(tabs[0]!.className).toContain('tab-active')
  expect(tabs[0]!.getAttribute('aria-current')).toBe('true')
  expect(tabs[1]!.hasAttribute('aria-current')).toBe(false)
  expect(tabs[1]!.textContent).toContain('3')
  expect(hrefOf(doc.querySelector('thead th a'))).not.toContain('page=')

  const form = doc.querySelector('form#t-filters')!
  expect(form.getAttribute('method')).toBe('get')
  expect(form.getAttribute('action')).toBe('/admin/collections/posts')
  expect(form.getAttribute('hx-trigger')).toBe('submit, input changed delay:300ms from:find input[name=q], change from:find select')
  expect(form.getAttribute('hx-target')).toBe('#t')
  const hidden = Object.fromEntries([...form.querySelectorAll('input[type="hidden"]')].map((i) => [i.getAttribute('name'), i.getAttribute('value')]))
  expect(hidden).toEqual({ locale: 'es', status: 'all', sort: 'updated', dir: 'desc' })
  const search = form.querySelector('input#t-q[name="q"][type="search"]')!
  expect(search.getAttribute('value')).toBe('cat')
  const label = doc.querySelector('label[for="t-q"]')!
  expect(label.className).toContain('sr-only')
  expect(label.textContent).toBe('Search posts')
  const submit = form.querySelector('button[type="submit"]')!
  expect(submit.textContent).toBe('Show results')
  expect(submit.className).toContain('focus:not-sr-only')

  const pageLinks = [...doc.querySelectorAll('nav a')].map(hrefOf)
  expect(pageLinks.every((h) => h.includes('locale=es') && h.includes('q=cat'))).toBe(true)
})

it('leaves a kept param to the toolbar control that sends it, but still links with it', async () => {
  const doc = await render({
    keep: { locale: 'es' },
    controls: ['locale'],
    query: { ...q, page: 2 },
    total: 104,
    tabs: [{ key: 'all', label: 'All', count: 104 }],
    toolbarEnd: raw('<select name="locale" form="t-filters"><option value="es" selected>es</option></select>'),
  })
  const form = doc.querySelector('form#t-filters')!
  expect(form.querySelectorAll('input[type="hidden"][name="locale"]')).toHaveLength(0)
  expect(form.querySelectorAll('[name="locale"]')).toHaveLength(1)
  expect(hrefOf(doc.querySelector('.tabs a.tab'))).toContain('locale=es')
  expect([...doc.querySelectorAll('nav a')].map(hrefOf).every((h) => h.includes('locale=es'))).toBe(true)
})

it('shows the footer only when there is more than one page', async () => {
  const one = await render({ total: 20 })
  expect(one.querySelector('nav[aria-label="Pages of results"]')).toBeNull()

  const doc = await render({ total: 104, query: { ...q, page: 2 } })
  const nav = doc.querySelector('nav[aria-label="Pages of results"]')!
  expect(nav.textContent).toContain('Showing 26–50 of 104')
  expect(nav.querySelector('a[aria-current="page"]')!.textContent).toBe('2')
  expect([...nav.querySelectorAll('a.join-item')].map((a) => a.textContent)).toEqual(['', '1', '2', '3', '5', ''])
  expect(nav.querySelector('a[aria-label="Previous page"]')).not.toBeNull()
  expect(hrefOf(nav.querySelector('a[aria-label="Previous page"]'))).not.toContain('page=')
  expect(hrefOf(nav.querySelector('a[aria-label="Next page"]'))).toContain('page=3')
  expect(nav.textContent).toContain('…')
  const size = nav.querySelector('select[name="size"]')!
  expect(size.getAttribute('form')).toBe('t-filters')
  expect(doc.querySelector(`label[for="${size.id}"]`)!.textContent).toBe('Rows per page')
  expect(size.querySelector('option[selected]')!.textContent).toBe('25')

  const last = await render({ total: 104, query: { ...q, page: 5 } })
  expect(last.querySelector('nav')!.textContent).toContain('Showing 101–104 of 104')
  expect(last.querySelector('a[aria-label="Next page"]')).toBeNull()
})

it('keeps a non-default page size on links and in the form', async () => {
  const doc = await render({ total: 104, query: { ...q, size: 50 } })
  expect(hrefOf(doc.querySelector('thead th a'))).toContain('size=50')
  expect(doc.querySelector('select[name="size"] option[selected]')!.textContent).toBe('50')
  const few = await render({ total: 30, query: { ...q, size: 50 } })
  expect(few.querySelector('form#t-filters input[type="hidden"][name="size"]')!.getAttribute('value')).toBe('50')
})

it('adds labeled selection boxes tied to the bulk form', async () => {
  const doc = await render({ bulk: { actions: raw('<button type="submit" class="btn">Publish</button>') } })
  const boxes = [...doc.querySelectorAll('input[type="checkbox"][name="ids"][form="t-bulk"]')]
  expect(boxes).toHaveLength(2)
  expect(boxes.map((b) => b.getAttribute('value'))).toEqual(['p1', 'p2'])
  expect(boxes.map((b) => b.getAttribute('aria-label'))).toEqual(['Select Bruh', 'Select Alex Rivera'])
  const all = doc.querySelector('thead input[type="checkbox"][data-select-all]')!
  expect(all.hasAttribute('name')).toBe(false)
  expect(all.getAttribute('aria-label')).toBe('Select all on this page')
  const bar = doc.querySelector('[data-bulk-bar]')!
  expect(bar.hasAttribute('hidden')).toBe(false)
  expect(bar.getAttribute('data-selected-template')).toBe('{count} selected')
  const form = bar.querySelector('form#t-bulk[method="get"]')!
  expect(form.querySelector('button.btn')!.textContent).toBe('Publish')
  expect(form.querySelector('span[data-selected-count]')!.textContent).toBe('')
  const clear = form.querySelector('button[type="button"][data-clear-selection]')!
  expect(clear.textContent).toBe('Clear selection')
})

it('names each row menu after its row', async () => {
  const doc = await render({
    rowActions: (p) => [
      { label: 'Edit', icon: 'pencil', href: `/admin/documents/${p.id}` },
      { label: 'Delete', icon: 'trash', href: `/admin/documents/${p.id}/delete`, danger: true },
    ],
  })
  const menu = doc.querySelector('tbody details.dropdown.dropdown-end')!
  const summary = menu.querySelector('summary.btn.btn-ghost.btn-xs.btn-square')!
  expect(summary.getAttribute('aria-label')).toBe('More actions for Bruh')
  const links = [...menu.querySelectorAll('ul.menu a')]
  expect(links.map((a) => a.textContent)).toEqual(['Edit', 'Delete'])
  expect(links[0]!.getAttribute('href')).toBe('/admin/documents/p1')
  expect(links[0]!.className).not.toContain('text-error')
  expect(links[1]!.className).toContain('text-error')
})

it('submits a post action through a form of its own', async () => {
  const doc = await render({
    rowActions: (p) => [
      { label: 'Edit', icon: 'pencil', href: `/x/${p.id}` },
      { label: 'Delete', icon: 'trash', href: `/x/${p.id}/delete`, danger: true, method: 'post' },
    ],
  })
  const menu = doc.querySelector('tbody tr details')!
  expect([...menu.querySelectorAll('ul.menu a')].map((a) => a.textContent)).toEqual(['Edit'])
  const button = menu.querySelector('ul.menu button[type="submit"]')!
  expect(button.textContent).toBe('Delete')
  expect(button.className).toContain('text-error')
  expect(button.getAttribute('form')).toBe('t-act-p1-1')
  const form = doc.querySelector('form#t-act-p1-1')!
  expect(form.getAttribute('method')).toBe('post')
  expect(form.getAttribute('action')).toBe('/x/p1/delete')
  expect(form.closest('details')).toBeNull()
  expect(doc.querySelector('form#t-act-p2-1')!.getAttribute('action')).toBe('/x/p2/delete')
  const ids = [...doc.querySelectorAll('form[id]')].map((f) => f.id)
  expect(new Set(ids).size).toBe(ids.length)
})

it('shows the empty message in a single cell', async () => {
  const doc = await render({ rows: [], bulk: { actions: '' }, rowActions: () => [] })
  const rows = doc.querySelectorAll('tbody tr')
  expect(rows).toHaveLength(1)
  const cell = rows[0]!.querySelector('td[colspan]')!
  expect(cell.getAttribute('colspan')).toBe('4')
  expect(cell.textContent).toBe('There is nothing here yet.')
  const searched = await render({ rows: [], query: { ...q, q: 'zzz' } })
  expect(searched.querySelector('tbody td[colspan]')!.textContent).toBe('Nothing matches your search.')
})

it('works without a query', async () => {
  const doc = await render({ query: undefined, total: 100 })
  expect(doc.querySelector('form')).toBeNull()
  expect(doc.querySelector('thead a')).toBeNull()
  expect(doc.querySelector('nav')).toBeNull()
  expect(doc.querySelector('[aria-sort]')).toBeNull()
})

it('hides a column label visually but keeps it for screen readers', async () => {
  const doc = await render({ columns: [...columns, { key: 'x', label: 'Restore', hideLabel: true, align: 'end', cell: () => 'r' }] })
  const th = [...doc.querySelectorAll('thead th')].at(-1)!
  expect(th.querySelector('.sr-only')!.textContent).toBe('Restore')
  expect(th.className).toContain('text-right')
})
