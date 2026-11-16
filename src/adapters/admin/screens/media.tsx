import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { InlayError } from '../../../core/errors.js'
import { isRasterImage, typeLabel } from '../../../core/media/detect.js'
import { formatSize } from '../../../core/media/labels.js'
import { sanitizeFilename } from '../../../core/media/library.js'
import { t } from '../../../core/messages/index.js'
import type { Actor, Ctx, MediaInfo, Usage } from '../../../core/types.js'
import { adminActor, formOf, HTML, noticeOf, notFound, type AdminContext } from '../context.js'
import { Icon } from '../views/icons.js'
import { Alert, adminPage, Time } from '../views/layout.js'
import { Sheet } from '../views/sheet.js'
import { mediaPicker } from './pickers.js'

const PAGE_SIZE = 48
/** How many files one upload form may carry. */
export const MAX_FILES = 10
const TOO_MANY_FILES = 'FST_FILES_LIMIT'

export type Kind = 'image' | 'file'

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

/** What an upload form did: the files now in the library, and a plain message for each one that failed. */
export interface UploadOutcome {
  stored: MediaInfo[]
  /** True when every stored file was already in the library. */
  allReused: boolean
  problems: string[]
}

/**
 * Reads the files of a multipart request and adds each to the library as `ctx`. A file that can't be stored gets a
 * message in `problems`; the others are still stored.
 */
export async function receiveUploads(
  request: FastifyRequest,
  ctx: AdminContext,
  as: Ctx,
): Promise<UploadOutcome> {
  const outcome: UploadOutcome = { stored: [], allReused: true, problems: [] }
  if (!request.isMultipart()) return outcome
  let seen = 0
  try {
    for await (const part of request.files({ limits: { files: MAX_FILES, fileSize: ctx.uploads.maxBytes }, throwFileSizeLimit: false })) {
      const data = await part.toBuffer()
      if (part.file.truncated) {
        const max = formatSize(ctx.uploads.maxBytes)
        outcome.problems.push(t('error.mediaTooLarge', { filename: sanitizeFilename(part.filename), max }))
        seen++
        continue
      }
      // A browser sends an empty, nameless part when no file was chosen.
      if (part.filename === '' && data.length === 0) continue
      seen++
      try {
        const { media, reused } = await ctx.core.addMedia({ data, filename: part.filename }, as)
        outcome.stored.push(media)
        if (!reused) outcome.allReused = false
      } catch (e) {
        if (!(e instanceof InlayError)) throw e
        outcome.problems.push(e.message)
      }
    }
  } catch (e) {
    if ((e as { code?: unknown }).code !== TOO_MANY_FILES) throw e
    outcome.problems.push(t('admin.media.tooMany', { count: MAX_FILES }))
  }
  if (seen === 0 && outcome.problems.length === 0) outcome.problems.push(t('admin.media.noFile'))
  return outcome
}

const href = (base: string, params: Record<string, string>): string => {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '')).toString()
  return query === '' ? base : `${base}?${query}`
}

function Card({ media }: { media: MediaInfo }) {
  return (
    <li class="card card-border bg-base-100">
      <a href={`/admin/media/${encodeURIComponent(media.id)}`} class="flex h-full flex-col">
        <figure class="flex aspect-square items-center justify-center bg-base-200">
          {isRasterImage(media.mime) ? (
            <img src={`/media/${media.id}/320.webp`} alt={media.defaultAlt ?? ''} loading="lazy" class="h-full w-full object-cover" />
          ) : (
            <span class="px-2 text-center text-sm font-medium">{typeLabel(media.mime)}</span>
          )}
        </figure>
        <span class="card-body p-3 text-sm break-words">{media.filename}</span>
      </a>
    </li>
  )
}

function Grid({ files }: { files: MediaInfo[] }) {
  return (
    <ul class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {files.map((media) => (
        <Card media={media} />
      ))}
    </ul>
  )
}

/** The kind filter's value; anything else means all files. */
const kindOf = (raw: unknown): Kind | undefined => (raw === 'image' || raw === 'file' ? raw : undefined)

const usageState = (u: Usage) => t(u.in === 'draft' ? 'admin.media.usage.draft' : u.in === 'published' ? 'admin.media.usage.published' : 'admin.media.usage.both')

function UsageList({ usages }: { usages: Usage[] }) {
  return (
    <ul class="list-disc pl-6">
      {usages.map((u) => (
        <li>
          <a href={`/admin/documents/${encodeURIComponent(u.documentId)}`} class="link">
            {u.title}
          </a>{' '}
          ({u.locale}, {usageState(u)})
        </li>
      ))}
    </ul>
  )
}

/** The media library: a grid of uploaded files with search, a kind filter, paging and an upload form. */
export function registerMedia(scope: FastifyInstance, ctx: AdminContext): void {
  const { core, uploads } = ctx
  const asCtx = (actor: Actor): Ctx => ({ actor, source: 'admin' })
  const send = async (reply: FastifyReply, status: number, opts: Parameters<typeof adminPage>[1], body: Parameters<typeof adminPage>[2]) =>
    reply.code(status).type(HTML).send(await adminPage(ctx, { ...opts, status }, body))

  async function library(
    request: FastifyRequest,
    reply: FastifyReply,
    status: number,
    outcome?: UploadOutcome,
  ): Promise<FastifyReply> {
    const actor = adminActor(request)
    const query = request.query as Record<string, unknown>
    const q = textOf(query.q).trim()
    const kind = kindOf(query.kind)
    const asked = Number.parseInt(textOf(query.page), 10)
    const page = Number.isSafeInteger(asked) && asked > 0 ? asked : 1
    const found = await core.listMedia({
      ...(kind && { kind }),
      ...(q !== '' && { search: q }),
      limit: PAGE_SIZE + 1,
      offset: (page - 1) * PAGE_SIZE,
    })
    const files = found.slice(0, PAGE_SIZE)
    const hasNext = found.length > PAGE_SIZE
    const keep = { q, kind: kind ?? '' }
    const stored = outcome?.stored ?? []
    const accept = uploads.types.join(',')
    const body = (
      <div class="flex flex-col gap-8">
        <form method="get" action="/admin/media" class="flex flex-wrap items-end gap-4">
          <div class="flex flex-col gap-1">
            <label for="q" class="text-sm font-medium">
              {t('admin.media.search')}
            </label>
            <input id="q" name="q" type="search" value={q} class="input input-bordered" />
          </div>
          <div class="flex flex-col gap-1">
            <label for="kind" class="text-sm font-medium">
              {t('admin.media.kind')}
            </label>
            <select id="kind" name="kind" class="select select-bordered">
              <option value="" selected={kind === undefined}>
                {t('admin.media.kind.all')}
              </option>
              <option value="image" selected={kind === 'image'}>
                {t('admin.media.kind.image')}
              </option>
              <option value="file" selected={kind === 'file'}>
                {t('admin.media.kind.file')}
              </option>
            </select>
          </div>
          <button type="submit" class="btn">
            {t('admin.media.filter')}
          </button>
        </form>
        {files.length === 0 ? <p>{t(q !== '' || kind ? 'admin.media.noMatches' : 'admin.media.empty')}</p> : <Grid files={files} />}
        {(page > 1 || hasNext) && (
          <nav aria-label={t('admin.list.page', { page })} class="flex gap-4">
            {page > 1 && (
              <a href={href('/admin/media', { ...keep, page: page > 2 ? String(page - 1) : '' })} class="btn">
                {t('admin.list.prev')}
              </a>
            )}
            {hasNext && (
              <a href={href('/admin/media', { ...keep, page: String(page + 1) })} class="btn">
                {t('admin.list.next')}
              </a>
            )}
          </nav>
        )}
        <Sheet
          id="upload-media"
          title={t('admin.media.uploadHeading')}
          action="/admin/media"
          enctype="multipart/form-data"
          submit={t('admin.media.upload')}
          open={(outcome !== undefined && outcome.problems.length > 0) || query.sheet === 'upload'}
        >
          {outcome && outcome.problems.length > 0 && (
            <Alert kind="error" id="upload-problems">
              <div>
                <p class="font-semibold">{t('admin.media.problems')}</p>
                <ul class="list-disc pl-6">
                  {outcome.problems.map((problem) => (
                    <li>{problem}</li>
                  ))}
                </ul>
              </div>
            </Alert>
          )}
          {stored.length > 0 && (
            <section aria-labelledby="stored-heading" class="flex flex-col gap-2">
              <h3 id="stored-heading" class="font-semibold">
                {t('admin.media.storedHeading')}
              </h3>
              <ul class="list-disc pl-6">
                {stored.map((m) => (
                  <li>{t('admin.upload.uploaded', { filename: m.filename })}</li>
                ))}
              </ul>
            </section>
          )}
          <div class="flex flex-col gap-2">
            <label for="files" class="text-sm font-medium">
              {t('admin.media.files')}
            </label>
            <input id="files" name="file" type="file" multiple accept={accept} class="file-input w-full" aria-describedby="files-hint" />
            <p id="files-hint" class="text-sm">
              {t('admin.media.uploadHint', { count: MAX_FILES, types: uploads.types.map(typeLabel).join(', '), max: formatSize(uploads.maxBytes) })}
            </p>
          </div>
        </Sheet>
      </div>
    )
    const notice = noticeOf(query)
    const actions = (
      <button type="button" class="btn btn-primary btn-sm" data-sheet-open="upload-media">
        <Icon name="upload" />
        {t('admin.media.uploadHeading')}
      </button>
    )
    return send(reply, status, { title: t('admin.media.title'), actions, actor, section: 'media', ...(notice !== undefined && { notice }) }, body)
  }

  scope.get('/admin/media', (request, reply) => library(request, reply, 200))

  scope.post('/admin/media', async (request, reply) => {
    const actor = adminActor(request)
    const outcome = await receiveUploads(request, ctx, asCtx(actor))
    // From the picker's upload form: the picker again, with the new files first and any problems above.
    const pick = (request.query as Record<string, unknown>).pick
    if (pick === 'image' || pick === 'file') return reply.code(200).type(HTML).send(await mediaPicker(ctx, { kind: pick, outcome }))
    if (outcome.problems.length > 0) return library(request, reply, 400, outcome)
    return reply.redirect(`/admin/media?notice=${outcome.allReused ? 'reused' : 'uploaded'}`, 303)
  })

  async function detail(
    reply: FastifyReply,
    actor: Actor,
    media: MediaInfo,
    opts: { notice?: string; error?: string; usages?: Usage[] } = {},
  ): Promise<FastifyReply> {
    const usages = opts.usages ?? (await core.findUsages({ kind: 'media', id: media.id }))
    const id = encodeURIComponent(media.id)
    const body = (
      <div class="flex flex-col gap-8">
        <div>
          {isRasterImage(media.mime) ? (
            <img src={`/media/${media.id}/960.webp`} alt={media.defaultAlt ?? ''} class="max-h-96 max-w-full" />
          ) : (
            <a href={`/media/${id}`} class="link">
              {t('admin.media.download')}
            </a>
          )}
        </div>
        <dl class="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1">
          <dt class="font-medium">{t('admin.media.type')}</dt>
          <dd>{typeLabel(media.mime)}</dd>
          <dt class="font-medium">{t('admin.media.size')}</dt>
          <dd>{formatSize(media.size)}</dd>
          {media.width !== null && media.height !== null && (
            <>
              <dt class="font-medium">{t('admin.media.dimensions')}</dt>
              <dd>{t('admin.media.dimensionsValue', { width: media.width, height: media.height })}</dd>
            </>
          )}
          <dt class="font-medium">{t('admin.media.uploadedBy')}</dt>
          <dd>
            {media.createdBy}, <Time iso={media.createdAt} />
          </dd>
        </dl>
        <form method="post" action={`/admin/media/${id}/alt`} class="flex flex-col gap-2">
          <label for="alt" class="text-sm font-medium">
            {t('admin.media.alt')}
          </label>
          <input id="alt" name="alt" type="text" value={media.defaultAlt ?? ''} class="input input-bordered w-full" aria-describedby="alt-hint" />
          <p id="alt-hint" class="text-sm">
            {t('admin.media.altHint')}
          </p>
          <div>
            <button type="submit" class="btn">
              {t('admin.media.altSave')}
            </button>
          </div>
        </form>
        <section aria-labelledby="usage-heading" class="flex flex-col gap-2">
          <h2 id="usage-heading" class="text-lg font-semibold">
            {t('admin.media.usageHeading')}
          </h2>
          {usages.length === 0 ? <p>{t('admin.media.unused')}</p> : <UsageList usages={usages} />}
        </section>
        <div>
          <a href={`/admin/media/${id}/delete`} class="btn btn-error btn-outline">
            {t('admin.media.delete')}
          </a>
        </div>
      </div>
    )
    return send(
      reply,
      200,
      {
        title: media.filename,
        actor,
        section: 'media',
        breadcrumbs: [{ label: t('admin.media.title'), href: '/admin/media' }],
        ...(opts.notice !== undefined && { notice: opts.notice }),
      },
      body,
    )
  }

  async function confirmDelete(reply: FastifyReply, status: number, actor: Actor, media: MediaInfo, error?: InlayError) {
    const usages = error?.details.usages ?? []
    const id = encodeURIComponent(media.id)
    const body = (
      <div class="flex flex-col gap-4">
        {error && (
          <Alert kind="error" id="delete-error">
            {error.message}
          </Alert>
        )}
        {usages.length > 0 && <UsageList usages={usages} />}
        <p>{t('admin.media.delete.confirm', { filename: media.filename })}</p>
        <form method="post" action={`/admin/media/${id}/delete`} class="flex gap-4">
          <button type="submit" class="btn btn-error">
            {t('admin.media.delete.submit')}
          </button>
          <a href={`/admin/media/${id}`} class="btn">
            {t('admin.media.cancel')}
          </a>
        </form>
      </div>
    )
    return send(
      reply,
      status,
      {
        title: t('admin.media.delete.title', { filename: media.filename }),
        actor,
        section: 'media',
        breadcrumbs: [{ label: t('admin.media.title'), href: '/admin/media' }],
      },
      body,
    )
  }

  scope.get('/admin/media/:id', async (request, reply) => {
    const actor = adminActor(request)
    const media = await core.getMedia((request.params as { id: string }).id)
    if (!media) return notFound(reply, ctx, actor)
    return detail(reply, actor, media, { ...(noticeOf(request.query) !== undefined && { notice: noticeOf(request.query) as string }) })
  })

  scope.post('/admin/media/:id/alt', async (request, reply) => {
    const actor = adminActor(request)
    const { id } = request.params as { id: string }
    try {
      await core.setMediaAlt(id, formOf(request).alt ?? '', asCtx(actor))
    } catch (e) {
      if (e instanceof InlayError && e.code === 'not_found') return notFound(reply, ctx, actor)
      throw e
    }
    return reply.redirect(`/admin/media/${encodeURIComponent(id)}?notice=altSaved`, 303)
  })

  scope.get('/admin/media/:id/delete', async (request, reply) => {
    const actor = adminActor(request)
    const media = await core.getMedia((request.params as { id: string }).id)
    if (!media) return notFound(reply, ctx, actor)
    return confirmDelete(reply, 200, actor, media)
  })

  scope.post('/admin/media/:id/delete', async (request, reply) => {
    const actor = adminActor(request)
    const media = await core.getMedia((request.params as { id: string }).id)
    if (!media) return notFound(reply, ctx, actor)
    try {
      await core.deleteMedia(media.id, asCtx(actor))
    } catch (e) {
      if (!(e instanceof InlayError)) throw e
      if (e.code === 'in_use') return confirmDelete(reply, 409, actor, media, e)
      if (e.code === 'not_found') return notFound(reply, ctx, actor)
      throw e
    }
    return reply.redirect('/admin/media?notice=deleted', 303)
  })
}
