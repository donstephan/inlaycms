import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isRasterImage, typeLabel } from '../../../core/media/detect.js'
import { formatSize } from '../../../core/media/labels.js'
import { t } from '../../../core/messages/index.js'
import type { MediaInfo } from '../../../core/types.js'
import { renderToString, type Renderable } from '../../../jsx/html.js'
import { adminActor, HTML, notFound, type AdminContext } from '../context.js'
import { Alert } from '../views/layout.js'
import type { Kind, UploadOutcome } from './media.js'

/** What choosing a result gives the field: the stored value, its name and, for images, a thumbnail. */
export interface Pick {
  value: string
  label: string
  thumb?: string
}

const MEDIA_PAGE = 24
const ENTRY_LIMIT = 20
const DOCUMENT_LIMIT = 10

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Lower-case text without accents, for matching a search. */
const fold = (text: string): string => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()

const withQuery = (base: string, params: Record<string, string>): string => {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '')).toString()
  return query === '' ? base : `${base}?${query}`
}

function PickButton({ pick }: { pick: Pick }) {
  return (
    <li>
      <button type="button" data-pick={JSON.stringify(pick)} class="btn btn-ghost h-auto min-h-12 w-full justify-start gap-3 py-2 text-left font-normal">
        {pick.thumb !== undefined && <img src={pick.thumb} alt="" loading="lazy" class="h-12 w-12 shrink-0 rounded object-cover" />}
        <span class="break-words">{pick.label}</span>
      </button>
    </li>
  )
}

/**
 * A web address to link to, for rich text's link picker: `client/admin/picker.ts` turns it into the pick
 * `{ value: 'url:<address>', label: <address> }`. Not a `<form>`, since the picker may sit inside the editor's form.
 */
export function WebAddress() {
  return (
    <div data-pick-web class="flex flex-col gap-2 rounded-box border border-base-300 p-4">
      <label for="picker-web" class="text-sm font-medium">
        {t('admin.picker.webAddress')}
      </label>
      <input
        type="text"
        inputmode="url"
        id="picker-web"
        autocomplete="off"
        aria-describedby="picker-web-hint"
        class="input input-bordered w-full"
      />
      <p id="picker-web-hint" class="text-sm text-base-content/70">
        {t('admin.picker.webHint')}
      </p>
      <p id="picker-web-problem" data-pick-web-problem hidden class="text-sm text-error">
        {t('admin.picker.webInvalid')}
      </p>
      <div>
        <button type="button" data-pick-web-use class="btn btn-sm">
          {t('admin.picker.webUse')}
        </button>
      </div>
    </div>
  )
}

/**
 * A picker fragment: an optional part above the search (the upload form), a labeled search box that reloads only
 * the results, the result count (announced politely), the results and paging.
 */
function Picker({ url, searchLabel, q, picks, top, nav }: {
  /** The fragment's own address without `q` and `page`. */
  url: string
  searchLabel: string
  q: string
  picks: Pick[]
  top?: Renderable
  nav?: Renderable
}) {
  return (
    <div class="flex flex-col gap-4">
      {top}
      <div class="flex flex-col gap-1">
        <label for="picker-q" class="text-sm font-medium">
          {searchLabel}
        </label>
        <input
          type="search"
          id="picker-q"
          name="q"
          value={q}
          autocomplete="off"
          class="input input-bordered w-full"
          hx-get={url}
          hx-trigger="input changed delay:300ms, search"
          hx-target="#picker-results"
          hx-select="#picker-results"
          hx-swap="outerHTML"
          hx-select-oob="#picker-count:innerHTML"
        />
      </div>
      <p id="picker-count" aria-live="polite" class="text-sm text-base-content/70">
        {picks.length === 0 ? t('admin.picker.none') : t('admin.picker.count', { count: picks.length })}
      </p>
      <div id="picker-results" class="flex flex-col gap-2">
        <ul class="flex flex-col gap-1">
          {picks.map((pick) => (
            <PickButton pick={pick} />
          ))}
        </ul>
        {nav}
      </div>
    </div>
  )
}

async function sendFragment(reply: FastifyReply, body: Renderable): Promise<FastifyReply> {
  return reply.code(200).type(HTML).send(await renderToString(body))
}

const mediaPick = (media: MediaInfo): Pick => ({
  value: media.id,
  label: media.filename,
  ...(isRasterImage(media.mime) && { thumb: `/media/${media.id}/320.webp` }),
})

const fits = (kind: Kind, media: MediaInfo): boolean => kind === 'file' || media.mime.startsWith('image/')

const kindOf = (raw: unknown): Kind => (raw === 'file' ? 'file' : 'image')

/**
 * The media picker: an upload form, then the library's files (images only for `image`), 24 at a time. After an
 * upload, the new files come first and any problems are shown above.
 */
export async function mediaPicker(
  ctx: AdminContext,
  opts: { kind: Kind; q?: string; page?: number; outcome?: UploadOutcome },
): Promise<string> {
  const { core, uploads } = ctx
  const { kind, outcome } = opts
  const q = (opts.q ?? '').trim()
  const page = opts.page ?? 1
  const found = await core.listMedia({
    ...(kind === 'image' && { kind: 'image' as const }),
    ...(q !== '' && { search: q }),
    limit: MEDIA_PAGE + 1,
    offset: (page - 1) * MEDIA_PAGE,
  })
  const stored = outcome?.stored ?? []
  const fresh = stored.filter((m) => fits(kind, m))
  const problems = [
    ...(outcome?.problems ?? []),
    ...stored.filter((m) => !fits(kind, m)).map((m) => t('admin.picker.notImage', { filename: m.filename })),
  ]
  const freshIds = new Set(fresh.map((m) => m.id))
  const files = [...fresh, ...found.slice(0, MEDIA_PAGE).filter((m) => !freshIds.has(m.id))].slice(0, MEDIA_PAGE)
  const hasNext = found.length > MEDIA_PAGE
  const url = withQuery('/admin/pick/media', { kind })
  const pageUrl = (n: number) => withQuery('/admin/pick/media', { kind, q, page: n > 1 ? String(n) : '' })
  const types = kind === 'image' ? uploads.types.filter((type) => type.startsWith('image/')) : uploads.types
  const top = (
    <>
      {problems.length > 0 && (
        <Alert kind="error" id="picker-problems">
          <ul class="list-disc pl-6">
            {problems.map((problem) => (
              <li>{problem}</li>
            ))}
          </ul>
        </Alert>
      )}
      <form hx-post={`/admin/media?pick=${kind}`} hx-encoding="multipart/form-data" hx-target="#inlay-picker-body" hx-swap="innerHTML" class="flex flex-col gap-2 rounded-box border border-base-300 p-4">
        <label for="picker-upload" class="text-sm font-medium">
          {t('admin.picker.uploadFile')}
        </label>
        <input id="picker-upload" name="file" type="file" accept={types.join(',')} class="file-input w-full" aria-describedby="picker-upload-hint" />
        <p id="picker-upload-hint" class="text-sm text-base-content/70">
          {t('admin.upload.fileHint', { types: types.map(typeLabel).join(', '), max: formatSize(uploads.maxBytes) })}
        </p>
        <div>
          <button type="submit" class="btn btn-sm">
            {t('admin.picker.upload')}
          </button>
        </div>
      </form>
    </>
  )
  const nav = (page > 1 || hasNext) && (
    <nav aria-label={t('admin.list.page', { page })} class="flex gap-2">
      {page > 1 && (
        <button type="button" class="btn btn-sm" hx-get={pageUrl(page - 1)} hx-target="#inlay-picker-body" hx-swap="innerHTML">
          {t('admin.list.prev')}
        </button>
      )}
      {hasNext && (
        <button type="button" class="btn btn-sm" hx-get={pageUrl(page + 1)} hx-target="#inlay-picker-body" hx-swap="innerHTML">
          {t('admin.list.next')}
        </button>
      )}
    </nav>
  )
  return renderToString(
    <Picker url={url} searchLabel={t('admin.picker.searchMedia')} q={q} picks={files.map(mediaPick)} top={top} nav={nav} />,
  )
}

/**
 * The fragments the editor's pickers load into the shared dialog: media, entries of a collection, and pages to link
 * to (with `web=1`, which rich text asks for, also a web address).
 */
export function registerPickers(scope: FastifyInstance, ctx: AdminContext): void {
  const { core } = ctx
  const { registry } = core

  const queryOf = (request: FastifyRequest) => request.query as Record<string, unknown>
  const localeOf = (raw: unknown): string => (typeof raw === 'string' && registry.locales.includes(raw) ? raw : registry.defaultLocale)

  scope.get('/admin/pick/media', async (request, reply) => {
    const query = queryOf(request)
    const asked = Number.parseInt(textOf(query.page), 10)
    const page = Number.isSafeInteger(asked) && asked > 0 ? asked : 1
    const body = await mediaPicker(ctx, { kind: kindOf(query.kind), q: textOf(query.q), page })
    return reply.code(200).type(HTML).send(body)
  })

  scope.get('/admin/pick/entries', async (request, reply) => {
    const query = queryOf(request)
    const collection = registry.site.collections.find((c) => c.name === query.collection)
    if (!collection) return notFound(reply, ctx, adminActor(request))
    const locale = localeOf(query.locale)
    const q = textOf(query.q).trim()
    const found = await core.searchEntries(collection.name, q, { locale, limit: ENTRY_LIMIT })
    const picks = found.map((entry): Pick => ({ value: entry.groupId, label: entry.title }))
    const url = withQuery('/admin/pick/entries', { collection: collection.name, locale })
    return sendFragment(reply, <Picker url={url} searchLabel={t('admin.picker.search')} q={q} picks={picks} />)
  })

  scope.get('/admin/pick/documents', async (request, reply) => {
    const query = queryOf(request)
    const locale = localeOf(query.locale)
    const q = textOf(query.q).trim()
    const words = fold(q).split(/\s+/).filter((w) => w !== '')

    const singletons = registry.site.singletons.filter((s) => s.path !== null)
    const pages = (
      await Promise.all(
        singletons.map(async (def) => {
          const doc = await core.findSingleton(def.name)
          return doc ? [{ def, doc }] : []
        }),
      )
    ).flat()
    const routed = registry.site.collections.filter((c) => c.route !== null)
    const entries = (await Promise.all(routed.map((c) => core.searchEntries(c.name, q, { locale, limit: DOCUMENT_LIMIT })))).flat()
    const live = await core.liveDocuments([...pages.map((p) => p.doc.groupId), ...entries.map((e) => e.groupId)], locale, { state: 'preview' })

    const pick = (groupId: string, fallbackTitle: string): Pick => {
      const doc = live.get(groupId)
      const title = doc?.title ?? fallbackTitle
      return { value: groupId, label: doc?.path ? t('admin.picker.page', { title, path: doc.path }) : title }
    }
    const pagePicks = pages
      .filter(({ def, doc }) => {
        const found = live.get(doc.groupId)
        const haystack = fold([def.label, found?.title ?? doc.title, found?.path ?? ''].join('\n'))
        return words.every((w) => haystack.includes(w))
      })
      .map(({ doc }) => pick(doc.groupId, doc.title))
    const picks = [...pagePicks, ...entries.map((e) => pick(e.groupId, e.title))]
    const url = withQuery('/admin/pick/documents', { locale })
    const top = query.web === '1' ? <WebAddress /> : undefined
    return sendFragment(reply, <Picker url={url} searchLabel={t('admin.picker.search')} q={q} picks={picks} top={top} />)
  })
}
