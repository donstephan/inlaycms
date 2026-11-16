import multipart from '@fastify/multipart'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { verifyUploadToken } from '../../core/auth/upload-token.js'
import { InlayError } from '../../core/errors.js'
import { typeLabel } from '../../core/media/detect.js'
import { formatSize } from '../../core/media/labels.js'
import { sanitizeFilename } from '../../core/media/library.js'
import { t } from '../../core/messages/index.js'
import type { Actor, Ctx } from '../../core/types.js'
import { html } from '../../jsx/html.js'
import { sameOrigin } from '../web.js'
import { HTML, type AdminContext } from './context.js'
import { badOriginPage } from './pages.js'
import { Alert, authPage } from './views/layout.js'

const UPLOAD_PATH = '/admin/upload'
const FILE_TOO_LARGE = 'FST_REQ_FILE_TOO_LARGE'
/** @fastify/multipart's error for a form with more file parts than the `files` limit (one). */
const TOO_MANY_FILES = 'FST_FILES_LIMIT'

const tokenOf = (request: FastifyRequest): unknown => (request.query as Record<string, unknown>).token

const linkFor = (token: string) => `${UPLOAD_PATH}?${new URLSearchParams({ token }).toString()}`

interface Upload {
  data: Buffer
  filename: string
}

/**
 * `GET /admin/upload?token=` shows a form for uploading one file to the media library; `POST` stores it as the
 * user the token was issued to. No login is needed: the signed token from `request_media_upload` is the
 * permission, and that user must still be active.
 */
export function registerUploadRoutes(scope: FastifyInstance, opts: AdminContext): void {
  const { service, core, baseUrl, secret, uploads } = opts
  scope.register(multipart, { limits: { fileSize: uploads.maxBytes, files: 1, fields: 10, parts: 20 } })

  const page = (reply: FastifyReply, status: number, body: string) => reply.code(status).type(HTML).send(body)
  const hint = t('admin.upload.fileHint', { types: uploads.types.map(typeLabel).join(', '), max: formatSize(uploads.maxBytes) })

  /** The user the token was issued to, if it is genuine, unexpired, and they may still use Inlay. */
  async function actorOf(token: unknown): Promise<Actor | null> {
    if (typeof token !== 'string') return null
    // Upload links use the real clock, like the rest of authentication.
    const verified = verifyUploadToken(secret, token, new Date())
    return verified ? service.actorForUser(verified.userId) : null
  }

  const expired = async (reply: FastifyReply) =>
    page(reply, 403, await authPage(opts, t('admin.upload.expired.title'), html`<p>${t('admin.upload.expired')}</p>`))

  function form(token: string, values: { alt?: string; error?: string } = {}): Promise<string> {
    const error = values.error === undefined ? '' : Alert({ kind: 'error', id: 'file-error', children: values.error })
    const body = html`<p>${t('admin.upload.intro')}</p>${error}<form method="post" action="${linkFor(
      token,
    )}" enctype="multipart/form-data" class="flex flex-col gap-4"><div class="flex flex-col gap-1"><label for="file">${t(
      'admin.upload.file',
    )}</label><p class="text-sm" id="file-hint">${hint}</p><input id="file" name="file" type="file" accept="${uploads.types.join(
      ',',
    )}" class="file-input w-full" required aria-describedby="file-hint${values.error === undefined ? '' : ' file-error'}"></div><div class="flex flex-col gap-1"><label for="alt">${t(
      'admin.upload.alt',
    )}</label><p class="text-sm" id="alt-hint">${t('admin.upload.altHint')}</p><input id="alt" name="alt" type="text" value="${
      values.alt ?? ''
    }" class="input w-full" aria-describedby="alt-hint"></div><button type="submit" class="btn btn-primary">${t('admin.upload.submit')}</button></form>`
    return authPage(opts, t('admin.upload.title'), body)
  }

  /** The file and alt text of a multipart form; `error` when the file is too large or there is more than one. */
  async function readForm(request: FastifyRequest): Promise<{ file?: Upload; alt: string; error?: string }> {
    let file: Upload | undefined
    let alt = ''
    if (!request.isMultipart()) return { alt }
    try {
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'alt' && typeof part.value === 'string') alt = part.value
          continue
        }
        if (part.fieldname !== 'file' || file !== undefined) {
          part.file.resume()
          continue
        }
        try {
          file = { data: await part.toBuffer(), filename: part.filename }
        } catch (e) {
          if ((e as { code?: unknown }).code !== FILE_TOO_LARGE) throw e
          const max = formatSize(uploads.maxBytes)
          return { alt, error: t('error.mediaTooLarge', { filename: sanitizeFilename(part.filename), max }) }
        }
      }
    } catch (e) {
      if ((e as { code?: unknown }).code !== TOO_MANY_FILES) throw e
      return { alt, error: t('admin.upload.oneFile') }
    }
    // A browser sends an empty, nameless part when no file was chosen.
    if (file && file.filename === '' && file.data.length === 0) file = undefined
    return { ...(file && { file }), alt }
  }

  scope.get(UPLOAD_PATH, async (request, reply) => {
    const token = tokenOf(request)
    if (!(await actorOf(token))) return expired(reply)
    return page(reply, 200, await form(token as string))
  })

  scope.post(UPLOAD_PATH, async (request, reply) => {
    if (!sameOrigin(request, baseUrl)) return page(reply, 403, await badOriginPage(opts))
    const token = tokenOf(request)
    const actor = await actorOf(token)
    if (!actor) return expired(reply)
    const link = token as string
    const ctx: Ctx = { actor, source: 'admin' }

    const { file, alt, error } = await readForm(request)
    if (error !== undefined) return page(reply, 400, await form(link, { alt, error }))
    if (!file) return page(reply, 400, await form(link, { alt, error: t('admin.upload.noFile') }))

    let filename: string
    try {
      const { media } = await core.addMedia(file, ctx)
      if (alt.trim() !== '') await core.setMediaAlt(media.id, alt, ctx)
      filename = media.filename
    } catch (e) {
      if (!(e instanceof InlayError)) throw e
      return page(reply, e.code === 'forbidden' ? 403 : 400, await form(link, { alt, error: e.message }))
    }
    const body = html`<p>${t('admin.upload.uploaded', { filename })}</p><p><strong>${t(
      'admin.upload.done',
    )}</strong></p><p><a href="${linkFor(link)}" class="link">${t('admin.upload.another')}</a></p>`
    return page(reply, 200, await authPage(opts, t('admin.upload.done.title'), body))
  })
}
