import { createReadStream } from 'node:fs'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Core } from '../../core/core.js'
import { InlayError } from '../../core/errors.js'
import { isRasterImage } from '../../core/media/detect.js'
import type { VariantFormat } from '../../core/media/variants.js'
import { t } from '../../core/messages/index.js'

/** A variant's file name: `<width>.<format>`. */
export const VARIANT = /^([1-9][0-9]{0,4})\.(webp|avif|jpeg|png)$/

/** RFC 5987 `ext-value` encoding for `filename*`. */
function encodeFilename(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

function disposition(mime: string, filename: string): string {
  const type = isRasterImage(mime) || mime === 'application/pdf' ? 'inline' : 'attachment'
  return `${type}; filename*=UTF-8''${encodeFilename(filename)}`
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).type('text/plain; charset=utf-8').send(t('error.mediaNotFound'))
}

/** Sends the file at `path` with headers for a content-addressed, never-changing resource. */
function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  id: string,
  file: { path: string; mime: string; disposition?: string },
): FastifyReply {
  const etag = `"${id}"`
  reply
    .header('cache-control', 'public, max-age=31536000, immutable')
    .header('etag', etag)
    .header('x-content-type-options', 'nosniff')
  if (request.headers['if-none-match'] === etag) return reply.code(304).send()
  if (file.disposition) reply.header('content-disposition', file.disposition)
  return reply.type(file.mime).send(createReadStream(file.path))
}

async function guard(reply: FastifyReply, send: () => Promise<FastifyReply>): Promise<FastifyReply> {
  try {
    return await send()
  } catch (e) {
    if (e instanceof InlayError && e.code === 'not_found') return notFound(reply)
    throw e
  }
}

/** `GET /media/:id` (the original) and `GET /media/:id/:width.:format` (a resized variant). */
export function registerMediaRoutes(app: FastifyInstance, core: Core): void {
  app.get<{ Params: { id: string } }>('/media/:id', (request, reply) =>
    guard(reply, async () => {
      const { id } = request.params
      const file = await core.mediaFile(id)
      return sendFile(request, reply, id, { ...file, disposition: disposition(file.mime, file.filename) })
    }),
  )

  app.get<{ Params: { id: string; variant: string } }>('/media/:id/:variant', (request, reply) =>
    guard(reply, async () => {
      const { id, variant } = request.params
      const m = VARIANT.exec(variant)
      if (!m) return notFound(reply)
      const file = await core.mediaVariant(id, { width: Number(m[1]), format: m[2] as VariantFormat })
      return sendFile(request, reply, id, file)
    }),
  )
}
