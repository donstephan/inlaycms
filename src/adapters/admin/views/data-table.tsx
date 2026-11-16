import { t } from '../../../core/messages/index.js'
import type { Renderable } from '../../../jsx/html.js'
import { Icon } from './icons.js'
import type { IconName } from './icons.js'

export interface TableQuery {
  q: string
  status: string
  sort: string
  dir: 'asc' | 'desc'
  page: number
  size: number
}

export const PAGE_SIZES: readonly number[] = [25, 50, 100]
const DEFAULT_SIZE = 25

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Reads a table's search, status tab, sort and page from the query string; anything unknown falls back to the default. */
export function readTableQuery(
  query: Record<string, unknown>,
  opts: { sorts: readonly string[]; defaultSort: string; defaultDir: 'asc' | 'desc'; statuses?: readonly string[] },
): TableQuery {
  const status = textOf(query.status)
  const sort = textOf(query.sort)
  const dir = textOf(query.dir)
  const pageText = textOf(query.page)
  const page = /^\d+$/.test(pageText) ? Number(pageText) : 1
  const sizeText = textOf(query.size)
  return {
    q: textOf(query.q).trim(),
    status: opts.statuses?.includes(status) ? status : (opts.statuses?.[0] ?? ''),
    sort: opts.sorts.includes(sort) ? sort : opts.defaultSort,
    dir: dir === 'asc' || dir === 'desc' ? dir : opts.defaultDir,
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
    size: PAGE_SIZES.find((n) => String(n) === sizeText) ?? DEFAULT_SIZE,
  }
}

/** The rows on the asked-for page; a page past the end shows the last page. */
export function pageOf<Row>(rows: readonly Row[], query: TableQuery): { rows: Row[]; total: number; page: number } {
  const pages = Math.max(1, Math.ceil(rows.length / query.size))
  const page = Math.min(query.page, pages)
  const start = (page - 1) * query.size
  return { rows: rows.slice(start, start + query.size), total: rows.length, page }
}

/** `base` with `params` as its query string, leaving out empty values. */
export function tableHref(base: string, params: Record<string, string>): string {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '')).toString()
  return query === '' ? base : `${base}?${query}`
}

export interface Column<Row> {
  key: string
  label: string
  hideLabel?: boolean
  sortable?: boolean
  align?: 'end'
  class?: string
  cell: (row: Row) => Renderable
}

export interface RowAction {
  label: string
  icon: IconName
  href: string
  danger?: boolean
  /** A post action submits a form to `href` instead of linking to it. */
  method?: 'post'
}

export interface DataTableProps<Row> {
  id: string
  caption: string
  base: string
  /** Query kept on every link and as hidden inputs (e.g. `{ locale, deleted }`); empty values are left out. */
  keep?: Record<string, string>
  /** Names `toolbarEnd`'s controls already send with the filter form; `keep` skips them as hidden inputs but still links with them. */
  controls?: readonly string[]
  /** Required when search, tabs, sorting or paging are used. */
  query?: TableQuery
  rows: readonly Row[]
  /** Turns the paging footer on (it shows when there is more than one page). */
  total?: number
  /** The first column renders as `<th scope="row">`. */
  columns: ReadonlyArray<Column<Row>>
  rowKey: (row: Row) => string
  rowLabel: (row: Row) => string
  search?: { label: string }
  tabs?: ReadonlyArray<{ key: string; label: string; count: number }>
  /** Rendered inside the filter form's toolbar row. */
  toolbarEnd?: Renderable
  rowActions?: (row: Row) => RowAction[]
  /** Buttons rendered inside `form#<id>-bulk`. */
  bulk?: { actions: Renderable }
  empty: string
}

/** htmx attributes that load `href` and swap just this table, keeping the address in the URL. */
function swapTo(id: string, href: string): Record<string, string> {
  return { 'hx-get': href, 'hx-target': `#${id}`, 'hx-select': `#${id}`, 'hx-swap': 'outerHTML', 'hx-push-url': 'true' }
}

function cellClass(col: { align?: 'end'; class?: string }, base = ''): string | undefined {
  const cls = [base, col.align === 'end' ? 'text-right' : '', col.class ?? ''].filter((c) => c !== '').join(' ')
  return cls === '' ? undefined : cls
}

/** First, last, and the current page with its neighbors; `0` stands for a gap. */
function pageNumbers(page: number, pages: number): number[] {
  const out: number[] = []
  let last = 0
  for (let p = 1; p <= pages; p++) {
    if (p !== 1 && p !== pages && Math.abs(p - page) > 1) continue
    if (p - last > 1) out.push(0)
    out.push(p)
    last = p
  }
  return out
}

function RowMenu({ title, formId, actions }: { title: string; formId: string; actions: RowAction[] }) {
  return (
    <details class="dropdown dropdown-end">
      <summary class="btn btn-ghost btn-xs btn-square" aria-label={t('admin.table.actionsFor', { title })}>
        <Icon name="more" />
      </summary>
      <ul class="dropdown-content menu menu-sm z-20 w-44 rounded-box border border-base-300 bg-base-100 p-1 shadow-lg">
        {actions.map((action, i) => (
          <li>
            {action.method === 'post' ? (
              <button type="submit" form={`${formId}-${i}`} class={action.danger ? 'text-error' : undefined}>
                <Icon name={action.icon} />
                {action.label}
              </button>
            ) : (
              <a href={action.href} class={action.danger ? 'text-error' : undefined}>
                <Icon name={action.icon} />
                {action.label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </details>
  )
}

/**
 * The admin's shared table. Search, status tabs, sorting and paging live in the URL and work without JS; htmx swaps
 * `div#<id>` for speed. With `bulk`, each row gets a box tied to `form#<id>-bulk`.
 */
export function DataTable<Row>(props: DataTableProps<Row>): Renderable {
  const { id, caption, base, query, rows, columns, rowKey, rowLabel, search, tabs, toolbarEnd, rowActions, bulk, total } = props
  const filtersId = `${id}-filters`
  const bulkId = `${id}-bulk`
  const keep = Object.fromEntries(Object.entries(props.keep ?? {}).filter(([, v]) => v !== ''))
  const paged = query !== undefined && total !== undefined && total > query.size
  const pages = paged ? Math.ceil(total / query.size) : 1
  const page = query === undefined ? 1 : Math.min(query.page, pages)
  const state: Record<string, string> =
    query === undefined
      ? keep
      : { ...keep, q: query.q, status: query.status, sort: query.sort, dir: query.dir, size: query.size === DEFAULT_SIZE ? '' : String(query.size) }
  const href = (over: Record<string, string>) => tableHref(base, { ...state, ...over })
  const colSpan = columns.length + (bulk === undefined ? 0 : 1) + (rowActions === undefined ? 0 : 1)
  const hasToolbar = search !== undefined || tabs !== undefined || toolbarEnd !== undefined

  const controls = props.controls ?? []
  const hidden = Object.entries(state).filter(
    ([name, value]) => value !== '' && name !== 'q' && (name !== 'size' || !paged) && !controls.includes(name),
  )

  const filters = (query !== undefined || hasToolbar) && (
    <form
      id={filtersId}
      method="get"
      action={base}
      {...swapTo(id, base)}
      hx-trigger="submit, input changed delay:300ms from:find input[name=q], change from:find select"
      class={hasToolbar ? 'flex min-h-12 flex-wrap items-center gap-2 border-b border-base-300 px-3 py-2' : 'contents'}
    >
      {hidden.map(([name, value]) => (
        <input type="hidden" name={name} value={value} />
      ))}
      {search !== undefined && (
        <>
          <label for={`${id}-q`} class="sr-only">
            {search.label}
          </label>
          <div class="input input-sm w-full sm:w-64">
            <Icon name="search" class="opacity-50" />
            <input id={`${id}-q`} name="q" type="search" value={query?.q ?? ''} placeholder={search.label} autocomplete="off" />
          </div>
        </>
      )}
      {tabs !== undefined && query !== undefined && (
        <div class="tabs tabs-box tabs-sm" role="group" aria-label={t('admin.table.status')}>
          {tabs.map((tab) => {
            const link = href({ status: tab.key })
            const active = tab.key === query.status
            return (
              <a href={link} {...swapTo(id, link)} class={active ? 'tab tab-active gap-1.5' : 'tab gap-1.5'} aria-current={active ? 'true' : undefined}>
                {tab.label}
                <span class="text-xs text-base-content/60 tabular-nums">{tab.count}</span>
              </a>
            )
          })}
        </div>
      )}
      {toolbarEnd !== undefined && <div class="ml-auto flex flex-wrap items-center gap-2">{toolbarEnd}</div>}
      <button type="submit" class="btn btn-sm sr-only focus:not-sr-only">
        {t('admin.table.apply')}
      </button>
    </form>
  )

  const bulkBar = bulk !== undefined && (
    <div
      data-bulk-bar
      data-selected-template={t('admin.table.selected', { count: '{count}' })}
      class="flex min-h-12 items-center border-b border-base-300 bg-primary/5 px-3 py-2"
    >
      <form id={bulkId} method="get" class="flex w-full flex-wrap items-center gap-2">
        <span data-selected-count class="text-sm font-medium tabular-nums"></span>
        {bulk.actions}
        <button type="button" data-clear-selection class="btn btn-ghost btn-xs ml-auto">
          <Icon name="x" />
          {t('admin.table.clear')}
        </button>
      </form>
    </div>
  )

  const head = (
    <tr>
      {bulk !== undefined && (
        <th scope="col" class="w-10">
          <input type="checkbox" class="checkbox checkbox-xs" data-select-all form={bulkId} aria-label={t('admin.table.selectAll')} />
        </th>
      )}
      {columns.map((col) => {
        const label = col.hideLabel === true ? <span class="sr-only">{col.label}</span> : col.label
        if (col.sortable !== true || query === undefined) {
          return (
            <th scope="col" class={cellClass(col)}>
              {label}
            </th>
          )
        }
        const sorted = query.sort === col.key
        const link = href({ sort: col.key, dir: sorted && query.dir === 'asc' ? 'desc' : 'asc' })
        return (
          <th scope="col" class={cellClass(col)} aria-sort={sorted ? (query.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
            <a href={link} {...swapTo(id, link)} class="inline-flex items-center gap-1 hover:text-base-content">
              {label}
              {sorted ? (
                <Icon name={query.dir === 'asc' ? 'arrow-up' : 'arrow-down'} class="size-3!" />
              ) : (
                <Icon name="updown" class="size-3! opacity-30" />
              )}
            </a>
          </th>
        )
      })}
      {rowActions !== undefined && (
        <th scope="col" class="w-10">
          <span class="sr-only">{t('admin.table.actions')}</span>
        </th>
      )}
    </tr>
  )

  const body =
    rows.length === 0 ? (
      <tr>
        <td colspan={colSpan} class="py-12 text-center text-base-content/60">
          {query !== undefined && query.q !== '' ? t('admin.table.noMatches') : props.empty}
        </td>
      </tr>
    ) : (
      rows.map((row) => {
        const title = rowLabel(row)
        const actions = rowActions?.(row) ?? []
        const formId = `${id}-act-${rowKey(row)}`
        return (
          <tr class="hover:bg-base-200/60">
            {bulk !== undefined && (
              <td class="w-10">
                <input
                  type="checkbox"
                  class="checkbox checkbox-xs"
                  name="ids"
                  form={bulkId}
                  value={rowKey(row)}
                  aria-label={t('admin.table.select', { title })}
                />
              </td>
            )}
            {columns.map((col, i) =>
              i === 0 ? (
                <th scope="row" class={cellClass(col, 'font-medium')}>
                  {col.cell(row)}
                </th>
              ) : (
                <td class={cellClass(col)}>{col.cell(row)}</td>
              ),
            )}
            {rowActions !== undefined && (
              <td class="w-10 text-right">
                {actions.map((action, i) =>
                  action.method === 'post' ? <form id={`${formId}-${i}`} method="post" action={action.href} hidden></form> : null,
                )}
                {actions.length > 0 && <RowMenu title={title} formId={formId} actions={actions} />}
              </td>
            )}
          </tr>
        )
      })
    )

  const pageLink = (p: number) => href({ page: p === 1 ? '' : String(p) })
  const prevLink = pageLink(page - 1)
  const nextLink = pageLink(page + 1)
  const footer = paged && (
    <nav
      aria-label={t('admin.table.pages')}
      class="flex flex-wrap items-center gap-3 border-t border-base-300 px-3 py-2 text-sm text-base-content/70"
    >
      <span class="tabular-nums">
        {t('admin.table.showing', {
          from: (page - 1) * query.size + 1,
          to: Math.min(page * query.size, total),
          total,
        })}
      </span>
      <span class="ml-auto flex items-center gap-2">
        <label for={`${id}-size`}>{t('admin.table.rowsPerPage')}</label>
        <select
          id={`${id}-size`}
          name="size"
          form={filtersId}
          class="select select-xs w-16"
          {...swapTo(id, base)}
          hx-include={`#${filtersId}`}
        >
          {PAGE_SIZES.map((n) => (
            <option value={String(n)} selected={n === query.size}>
              {n}
            </option>
          ))}
        </select>
      </span>
      <div class="join">
        {page > 1 ? (
          <a href={prevLink} {...swapTo(id, prevLink)} class="join-item btn btn-xs" aria-label={t('admin.list.prev')}>
            <Icon name="chevron-left" />
          </a>
        ) : (
          <span class="join-item btn btn-xs btn-disabled" aria-hidden="true">
            <Icon name="chevron-left" />
          </span>
        )}
        {pageNumbers(page, pages).map((p) => {
          if (p === 0) {
            return (
              <span class="join-item btn btn-xs btn-disabled" aria-hidden="true">
                …
              </span>
            )
          }
          const link = pageLink(p)
          return (
            <a
              href={link}
              {...swapTo(id, link)}
              class={p === page ? 'join-item btn btn-xs btn-active' : 'join-item btn btn-xs'}
              aria-label={t('admin.list.page', { page: p })}
              aria-current={p === page ? 'page' : undefined}
            >
              {p}
            </a>
          )
        })}
        {page < pages ? (
          <a href={nextLink} {...swapTo(id, nextLink)} class="join-item btn btn-xs" aria-label={t('admin.list.next')}>
            <Icon name="chevron-right" />
          </a>
        ) : (
          <span class="join-item btn btn-xs btn-disabled" aria-hidden="true">
            <Icon name="chevron-right" />
          </span>
        )}
      </div>
    </nav>
  )

  return (
    <div id={id} class="rounded-box border border-base-300 bg-base-100">
      {filters}
      {bulkBar}
      <div class="overflow-x-auto lg:overflow-visible">
        <table class="table table-sm">
          <caption class="sr-only">{caption}</caption>
          <thead class="text-xs text-base-content/60">{head}</thead>
          <tbody>{body}</tbody>
        </table>
      </div>
      {footer}
    </div>
  )
}
