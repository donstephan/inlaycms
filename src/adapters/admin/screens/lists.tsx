import type { FastifyInstance } from 'fastify'
import { InlayError } from '../../../core/errors.js'
import { t } from '../../../core/messages/index.js'
import type { GlobalDef, SingletonDef } from '../../../core/registry/define.js'
import { designedInCode } from '../../../core/registry/designed.js'
import { singletonPath, withLocale } from '../../../core/site/paths.js'
import type { Actor, Ctx, DocumentSummary, LiveDocument } from '../../../core/types.js'
import type { Renderable } from '../../../jsx/html.js'
import { adminActor, forbidden, formValues, HTML, noticeOf, notFound, type AdminContext } from '../context.js'
import { backOf, idsOf } from '../publish.js'
import { DataTable, pageOf, readTableQuery, tableHref, type Column, type TableQuery } from '../views/data-table.js'
import { Icon } from '../views/icons.js'
import { adminPage, Alert, initials, Time } from '../views/layout.js'
import { Badge, badgeClass, documentStatus, StatusBadge, StatusDot, type DocumentStatus } from '../views/status.js'
import { translationRows, type TranslationRow } from '../translations.js'

const TABLE_ID = 'entries-table'
const STATUSES = ['all', 'published', 'changed', 'new'] as const
const STATUS_ORDER: Record<DocumentStatus, number> = { new: 0, changed: 1, published: 2, deleted: 3 }

const editorLink = (doc: DocumentSummary) => `/admin/documents/${encodeURIComponent(doc.id)}`

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Marks a document whose published revision leaves a required field empty. */
const GapBadge = () => (
  <Badge tone="warning" class="ml-2">
    {t('admin.gaps.badge')}
  </Badge>
)

function LanguageChips({ row, from }: { row: TranslationRow; from: DocumentSummary | null }) {
  return (
    <span class="flex flex-wrap gap-1">
      {[...row.docs].map(([locale, doc]) => {
        const code = locale.toUpperCase()
        if (doc) {
          const label = t('admin.list.languageStatus', { locale: code, status: t(`admin.status.${documentStatus(doc)}`) })
          return (
            <a href={editorLink(doc)} class={`${badgeClass('ghost')} uppercase`} aria-label={label} title={label}>
              <StatusDot status={documentStatus(doc)} />
              {locale}
            </a>
          )
        }
        if (!from) return null
        const label = t('admin.list.translateInto', { locale: code })
        return (
          <form method="post" action={`${editorLink(from)}/translations`}>
            <input type="hidden" name="locale" value={locale} />
            <button type="submit" class={`${badgeClass('outline')} border-dashed uppercase`} aria-label={label} title={label}>
              <Icon name="plus" />
              {locale}
            </button>
          </form>
        )
      })}
    </span>
  )
}

function Person({ name }: { name: string }) {
  if (name === '') return null
  return (
    <span class="flex items-center gap-2 whitespace-nowrap">
      <span class="grid size-6 shrink-0 place-items-center rounded-full bg-base-300 text-[10px] font-medium" aria-hidden="true">
        {initials(name)}
      </span>
      {name}
    </span>
  )
}

function compareBy(sort: string): (a: DocumentSummary, b: DocumentSummary) => number {
  if (sort === 'title') return (a, b) => a.title.localeCompare(b.title)
  if (sort === 'status') return (a, b) => STATUS_ORDER[documentStatus(a)] - STATUS_ORDER[documentStatus(b)]
  return (a, b) => a.updatedAt.localeCompare(b.updatedAt)
}

/** The list's address for this view, leaving out everything at its default. */
function listHref(base: string, locale: string, defaultLocale: string, query: TableQuery, page: number): string {
  return tableHref(base, {
    locale: locale === defaultLocale ? '' : locale,
    q: query.q,
    status: query.status === 'all' ? '' : query.status,
    sort: query.sort === 'updated' ? '' : query.sort,
    dir: query.dir === 'desc' ? '' : query.dir,
    size: query.size === 25 ? '' : String(query.size),
    page: page > 1 ? String(page) : '',
  })
}

/** The pages, site-wide content and collection lists of the admin. */
export function registerLists(scope: FastifyInstance, ctx: AdminContext): void {
  const { core } = ctx
  const { registry } = core
  const localeOf = (raw: unknown) => {
    const value = textOf(raw)
    return registry.locales.includes(value) ? value : registry.defaultLocale
  }

  for (const [path, section, kind] of [
    ['/admin/pages', 'pages', 'singleton'],
    ['/admin/globals', 'globals', 'global'],
  ] as const) {
    scope.get(path, async (request, reply) => {
      const actor = adminActor(request)
      const query = request.query as Record<string, unknown>
      const defs: ReadonlyArray<SingletonDef | GlobalDef> = kind === 'singleton' ? registry.site.singletons : registry.site.globals
      const [rows, found] = await Promise.all([translationRows(ctx, defs), core.listGaps({ types: defs.map((def) => def.name) })])
      const gapped = new Set(found.map((g) => g.document.id))
      const hasGap = (row: TranslationRow) => [...row.docs.values()].some((d) => d !== null && gapped.has(d.id))
      const { locales, defaultLocale } = registry
      const defaultDoc = (row: TranslationRow) => row.docs.get(defaultLocale) ?? null
      const sourceOf = (row: TranslationRow) => [...row.docs.values()].find((d) => d !== null) ?? null

      const columns: Array<Column<TranslationRow>> = [
        {
          key: 'name',
          label: t(kind === 'singleton' ? 'admin.list.col.page' : 'admin.list.col.item'),
          class: 'max-w-md',
          cell: (row) => {
            const doc = defaultDoc(row)
            return (
              <>
                {doc ? (
                  <a href={editorLink(doc)} class="link link-hover">
                    {row.def.label}
                  </a>
                ) : (
                  row.def.label
                )}
                {hasGap(row) && <GapBadge />}
                {designedInCode(row.def.template) && (
                  <Badge tone="neutral" class="ml-2">
                    {t('admin.list.designedInCode')}
                  </Badge>
                )}
                {row.def.help !== undefined && (
                  <div class="truncate text-xs font-normal text-base-content/60" title={row.def.help}>
                    {row.def.help}
                  </div>
                )}
              </>
            )
          },
        },
      ]
      if (kind === 'singleton') {
        columns.push({
          key: 'address',
          label: t('admin.list.col.address'),
          cell: (row) => {
            const address = row.def.kind === 'singleton' ? singletonPath(row.def, defaultLocale, defaultLocale) : null
            return address === null ? (
              <span class="text-base-content/60">{t('admin.list.noPath')}</span>
            ) : (
              <code>{withLocale(registry, defaultLocale, address)}</code>
            )
          },
        })
      }
      columns.push({
        key: 'status',
        label: t('admin.list.col.status'),
        cell: (row) => {
          const doc = defaultDoc(row)
          return doc ? <StatusBadge doc={doc} /> : null
        },
      })
      if (locales.length > 1) {
        columns.push({ key: 'languages', label: t('admin.list.col.languages'), cell: (row) => <LanguageChips row={row} from={sourceOf(row)} /> })
      }
      columns.push({
        key: 'updated',
        label: t('admin.list.col.updated'),
        class: 'whitespace-nowrap',
        cell: (row) => {
          const doc = defaultDoc(row)
          return doc ? <Time iso={doc.updatedAt} relative /> : null
        },
      })

      const body = (
        <DataTable<TranslationRow>
          id={section}
          caption={t(kind === 'singleton' ? 'admin.nav.pages' : 'admin.nav.globals')}
          base={path}
          rows={rows}
          columns={columns}
          rowKey={(row) => row.def.name}
          rowLabel={(row) => row.def.label}
          rowActions={(row) => {
            const doc = defaultDoc(row) ?? sourceOf(row)
            return doc
              ? [
                  { label: t('admin.list.edit'), icon: 'pencil' as const, href: editorLink(doc) },
                  { label: t('admin.list.history'), icon: 'history' as const, href: `${editorLink(doc)}/history` },
                ]
              : []
          }}
          empty={t('admin.list.empty')}
        />
      )
      const notice = noticeOf(query)
      const title = t(kind === 'singleton' ? 'admin.nav.pages' : 'admin.nav.globals')
      const page = await adminPage(ctx, { title, actor, section, ...(notice !== undefined && { notice }) }, body)
      return reply.code(200).type(HTML).send(page)
    })
  }

  scope.get('/admin/collections/:type', async (request, reply) => {
    const actor = adminActor(request)
    const { type } = request.params as { type: string }
    const def = registry.types.get(type)
    if (def?.kind !== 'collection') return notFound(reply, ctx, actor)

    const query = request.query as Record<string, unknown>
    const deleted = textOf(query.deleted) === '1'
    if (deleted && actor.role !== 'owner') return forbidden(reply, ctx, actor)
    const locale = localeOf(query.locale)
    const asked = readTableQuery(query, {
      sorts: ['title', 'status', 'updated'],
      defaultSort: 'updated',
      defaultDir: 'desc',
      statuses: STATUSES,
    })
    const table: TableQuery = deleted ? { ...asked, q: '', status: 'all' } : asked

    let source: DocumentSummary[]
    if (deleted) {
      const all = await core.listEntries(type, { locale, includeDeleted: true })
      source = all.filter((d) => d.deletedAt !== null)
    } else if (table.q !== '') {
      source = await core.searchEntries(type, table.q, { locale, limit: 50 })
    } else {
      source = await core.listEntries(type, { locale })
    }
    const countOf = (status: string) => (status === 'all' ? source.length : source.filter((d) => documentStatus(d) === status).length)
    const filtered = table.status === 'all' ? source : source.filter((d) => documentStatus(d) === table.status)
    const compare = compareBy(table.sort)
    const sorted = [...filtered].sort(table.dir === 'asc' ? compare : (a, b) => compare(b, a))
    const shown = pageOf(sorted, table)

    const authors = new Map<string, string>()
    await Promise.all(
      shown.rows.map(async (d) => {
        const view = await core.getDocument(d.id)
        if (view) authors.set(d.id, view.revision.authorName)
      }),
    )
    const gaps = deleted ? new Set<string>() : new Set((await core.listGaps({ ids: shown.rows.map((d) => d.id) })).map((g) => g.document.id))
    const live = deleted ? new Map<string, LiveDocument>() : await core.liveDocuments(shown.rows.map((d) => d.groupId), locale, { state: 'preview' })
    const pathOf = (d: DocumentSummary): string | null => {
      const found = live.get(d.groupId)
      return found && found.documentId === d.id ? found.path : null
    }

    const base = `/admin/collections/${encodeURIComponent(type)}`
    const bulkId = `${TABLE_ID}-bulk`
    const back = listHref(base, locale, registry.defaultLocale, table, shown.page)
    const keepLocale = locale === registry.defaultLocale ? '' : locale

    const columns: Array<Column<DocumentSummary>> = [
      {
        key: 'title',
        label: t('admin.list.col.title'),
        sortable: true,
        class: 'max-w-md',
        cell: (d) => {
          const path = pathOf(d)
          return (
            <>
              <a href={editorLink(d)} class="link link-hover">
                {d.title}
              </a>
              {gaps.has(d.id) && <GapBadge />}
              {path !== null && <div class="truncate text-xs font-normal text-base-content/60">{path}</div>}
            </>
          )
        },
      },
      { key: 'status', label: t('admin.list.col.status'), sortable: true, cell: (d) => <StatusBadge doc={d} /> },
      {
        key: 'updated',
        label: t('admin.list.col.updated'),
        sortable: true,
        class: 'whitespace-nowrap',
        cell: (d) => <Time iso={d.updatedAt} relative />,
      },
      { key: 'author', label: t('admin.list.col.author'), cell: (d) => <Person name={authors.get(d.id) ?? ''} /> },
    ]
    if (deleted) {
      columns.push({
        key: 'restore',
        label: t('admin.editor.restore'),
        cell: (d) => (
          <form method="post" action={`${editorLink(d)}/restore`}>
            <button type="submit" class="btn btn-xs" aria-label={t('admin.editor.restoreItem', { title: d.title })}>
              {t('admin.editor.restore')}
            </button>
          </form>
        ),
      })
    }

    const { locales } = registry
    const toolbarEnd = (
      <>
        {locales.length > 1 && (
          <>
            <label for={`${TABLE_ID}-locale`} class="sr-only">
              {t('admin.list.locale')}
            </label>
            <select id={`${TABLE_ID}-locale`} name="locale" form={`${TABLE_ID}-filters`} class="select select-sm w-20">
              {locales.map((l) => (
                <option value={l} selected={l === locale}>
                  {l}
                </option>
              ))}
            </select>
          </>
        )}
        {actor.role === 'owner' && (
          <details class="dropdown dropdown-end">
            <summary class="btn btn-ghost btn-sm btn-square" aria-label={t('admin.list.more')}>
              <Icon name="more" />
            </summary>
            <ul class="dropdown-content menu menu-sm z-20 w-52 rounded-box border border-base-300 bg-base-100 p-1 shadow-lg">
              <li>
                <a href={tableHref(base, { locale: keepLocale, deleted: deleted ? '' : '1' })}>
                  <Icon name="trash" />
                  {t(deleted ? 'admin.list.showCurrent' : 'admin.list.showDeleted')}
                </a>
              </li>
            </ul>
          </details>
        )}
      </>
    )

    const body = (
      <>
        <DataTable<DocumentSummary>
          id={TABLE_ID}
          caption={def.label}
          base={base}
          keep={{ locale: keepLocale, deleted: deleted ? '1' : '' }}
          {...(locales.length > 1 && { controls: ['locale'] })}
          query={table}
          rows={shown.rows}
          total={shown.total}
          columns={columns}
          rowKey={(d) => d.id}
          rowLabel={(d) => d.title}
          {...(!deleted && {
            search: { label: t('admin.list.search') },
            tabs: STATUSES.map((key) => ({ key, label: t(key === 'all' ? 'admin.table.all' : `admin.status.${key}`), count: countOf(key) })),
            rowActions: (d: DocumentSummary) => [
              { label: t('admin.list.edit'), icon: 'pencil' as const, href: editorLink(d) },
              { label: t('admin.list.history'), icon: 'history' as const, href: `${editorLink(d)}/history` },
              { label: t('admin.list.delete'), icon: 'trash' as const, href: `${editorLink(d)}/delete`, danger: true },
            ],
            bulk: {
              actions: (
                <>
                  <input type="hidden" name="back" value={back} form={bulkId} />
                  {/* Sends `ids` even with nothing ticked, so the publish review says nothing was chosen. */}
                  <input type="hidden" name="ids" value="" form={bulkId} />
                  <button type="submit" formaction="/admin/publish" formmethod="get" data-publish-dialog class="btn btn-ghost btn-xs">
                    <Icon name="send" />
                    {t('admin.bulk.publish')}
                  </button>
                  <button type="submit" formaction={`${base}/delete`} formmethod="get" data-bulk-delete class="btn btn-ghost btn-xs text-error">
                    <Icon name="trash" />
                    {t('admin.bulk.delete')}
                  </button>
                </>
              ),
            },
          })}
          toolbarEnd={toolbarEnd}
          empty={t('admin.list.empty')}
        />
        {!deleted && (
          <dialog id="bulk-delete-dialog" aria-labelledby="bulk-delete-title" class="modal">
            <div class="modal-box flex flex-col gap-4">
              <div class="flex items-center justify-between gap-4">
                <h2 id="bulk-delete-title" class="text-lg font-semibold">
                  {t('admin.bulkDelete.title')}
                </h2>
                <form method="dialog">
                  <button type="submit" class="btn btn-ghost btn-sm btn-square" aria-label={t('admin.bulkDelete.close')}>
                    <Icon name="x" />
                  </button>
                </form>
              </div>
              <div id="bulk-delete-body"></div>
            </div>
            <form method="dialog" class="modal-backdrop">
              <button type="submit" tabindex="-1">
                {t('admin.bulkDelete.close')}
              </button>
            </form>
          </dialog>
        )}
      </>
    )
    const notice = noticeOf(query)
    const title = deleted ? t('admin.list.deletedTitle', { label: def.label }) : def.label
    const actions = deleted ? undefined : (
      <a href={`${base}/new`} class="btn btn-primary btn-sm">
        <Icon name="plus" />
        {t('admin.list.new')}
      </a>
    )
    const page = await adminPage(
      ctx,
      { title, actor, section: `collection:${type}`, ...(notice !== undefined && { notice }), ...(actions !== undefined && { actions }) },
      body,
    )
    return reply.code(200).type(HTML).send(page)
  })

  /** The live entries of `type` among `ids`, in the order asked, each group once. */
  async function entriesOf(type: string, ids: string[]): Promise<DocumentSummary[]> {
    const found: DocumentSummary[] = []
    const groups = new Set<string>()
    for (const id of ids) {
      const doc = await core.getDocument(id)
      if (!doc || doc.kind !== 'entry' || doc.type !== type || doc.deletedAt !== null || groups.has(doc.groupId)) continue
      groups.add(doc.groupId)
      found.push(doc)
    }
    return found
  }

  /** A return address on this list, or the list itself. */
  const listBackOf = (base: string, raw: unknown): string => {
    const back = backOf(raw)
    return back === base || back.startsWith(`${base}?`) ? back : base
  }

  const bulkPage = (actor: Actor, type: string, label: string, title: string, body: Renderable) =>
    adminPage(ctx, { title, actor, section: `collection:${type}`, breadcrumbs: [{ label, href: `/admin/collections/${encodeURIComponent(type)}` }] }, body)

  const noneChosen = (back: string) => (
    <div id="bulk-delete-confirm" class="flex flex-col gap-4">
      <p>{t('admin.bulkDelete.none')}</p>
      <p>
        <a href={back} class="link">
          {t('admin.bulkDelete.back')}
        </a>
      </p>
    </div>
  )

  scope.get('/admin/collections/:type/delete', async (request, reply) => {
    const actor = adminActor(request)
    const { type } = request.params as { type: string }
    const def = registry.types.get(type)
    if (def?.kind !== 'collection') return notFound(reply, ctx, actor)
    const query = request.query as Record<string, unknown>
    const base = `/admin/collections/${encodeURIComponent(type)}`
    const back = listBackOf(base, query.back)
    const entries = await entriesOf(type, idsOf(query.ids))
    const body =
      entries.length === 0 ? (
        noneChosen(back)
      ) : (
        <div id="bulk-delete-confirm" class="flex flex-col gap-4">
          <p>{t('admin.bulkDelete.intro')}</p>
          <ul class="list-disc pl-6">
            {entries.map((d) => (
              <li>{d.title}</li>
            ))}
          </ul>
          <form method="post" action={`${base}/delete`} class="flex flex-wrap items-center gap-2">
            <input type="hidden" name="ids" value={entries.map((d) => d.id).join(',')} />
            <input type="hidden" name="back" value={back} />
            <button type="submit" class="btn btn-error">
              {t('admin.bulkDelete.confirm')}
            </button>
            <a href={back} class="btn btn-ghost" data-dialog-cancel>
              {t('admin.bulkDelete.cancel')}
            </a>
          </form>
        </div>
      )
    return reply.code(200).type(HTML).send(await bulkPage(actor, type, def.label, t('admin.bulkDelete.title'), body))
  })

  scope.post('/admin/collections/:type/delete', async (request, reply) => {
    const actor = adminActor(request)
    const { type } = request.params as { type: string }
    const def = registry.types.get(type)
    if (def?.kind !== 'collection') return notFound(reply, ctx, actor)
    const form = formValues(request)
    const base = `/admin/collections/${encodeURIComponent(type)}`
    const back = listBackOf(base, form.get('back'))
    const entries = await entriesOf(type, idsOf(form.all('ids')))
    if (entries.length === 0) {
      return reply.code(200).type(HTML).send(await bulkPage(actor, type, def.label, t('admin.bulkDelete.title'), noneChosen(back)))
    }

    const run: Ctx = { actor, source: 'admin' }
    let count = 0
    const failed: Array<{ title: string; reason: string }> = []
    for (const doc of entries) {
      try {
        await core.deleteEntry(doc.groupId, run)
        count += 1
      } catch (e) {
        if (!(e instanceof InlayError)) throw e
        failed.push({ title: doc.title, reason: t(e.messageId, e.params) })
      }
    }
    if (failed.length === 0) return reply.redirect(`${back}${back.includes('?') ? '&' : '?'}notice=bulkDeleted&count=${count}`, 303)

    const body = (
      <div class="flex flex-col gap-4">
        {count > 0 && (
          <div role="status" class="alert alert-success">
            {t('admin.bulkDelete.done', { count })}
          </div>
        )}
        <Alert kind="error">
          <div class="flex flex-col gap-2">
            <p>{t('admin.bulkDelete.failed')}</p>
            <ul class="list-disc pl-6">
              {failed.map((f) => (
                <li>{t('admin.bulkDelete.failedItem', { title: f.title, reason: f.reason })}</li>
              ))}
            </ul>
          </div>
        </Alert>
        <p>
          <a href={back} class="link">
            {t('admin.bulkDelete.back')}
          </a>
        </p>
      </div>
    )
    return reply.code(200).type(HTML).send(await bulkPage(actor, type, def.label, def.label, body))
  })
}
