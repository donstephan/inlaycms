import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createPreviewToken, verifyPreviewToken } from '../../core/preview.js'
import { encodePath, normalizePath } from '../../core/site/paths.js'
import type { LiveState } from '../../core/types.js'
import { catalogPage, PREVIEW_EXIT_PATH } from './render.js'

export const PREVIEW_COOKIE = 'inlay_preview'
export const PREVIEW_PATH = '/_inlay/preview'

/** The value of the `name` cookie in the request's `Cookie` header, if any. */
function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/**
 * A link that turns preview on for 24 hours and opens `path` (a decoded site path, default `/`): of the live site's
 * drafts, or with `release` of that staged release.
 */
export function previewLink(
  opts: { baseUrl: string; secret: string; now: () => Date },
  path = '/',
  link: { release?: string } = {},
): string {
  const token = createPreviewToken(opts.secret, opts.now(), link.release === undefined ? {} : { release: link.release })
  const query = new URLSearchParams({ token, path: encodePath(path) })
  return `${opts.baseUrl}${PREVIEW_PATH}?${query.toString()}`
}

/**
 * What the request's preview cookie says: `'preview'` when it carries a valid one, otherwise `'published'`, and the
 * staged release it previews (null for the live site's drafts or without a cookie).
 */
export function readPreview(request: FastifyRequest, secret: string, now: Date): { state: LiveState; release: string | null } {
  const token = readCookie(request, PREVIEW_COOKIE)
  const valid = token === undefined ? null : verifyPreviewToken(secret, token, now)
  return valid === null ? { state: 'published', release: null } : { state: 'preview', release: valid.release }
}

/** `'preview'` when the request carries a valid preview cookie (of the live site or of a release), otherwise `'published'`. */
export function previewState(request: FastifyRequest, secret: string, now: Date): LiveState {
  return readPreview(request, secret, now).state
}

/** `raw` when it's a clean, encoded site-relative path, otherwise `/`. */
function safeTarget(raw: unknown): string {
  if (typeof raw !== 'string') return '/'
  const normalized = normalizePath(raw)
  return normalized !== null && encodePath(normalized) === raw ? raw : '/'
}

/** Turns preview off for this browser. */
export function clearPreviewCookie(reply: FastifyReply, baseUrl: string): void {
  setCookie(reply, '', 0, baseUrl.startsWith('https:'))
}

function setCookie(reply: FastifyReply, value: string, maxAge: number, secure: boolean): void {
  const parts = [`${PREVIEW_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`]
  if (secure) parts.push('Secure')
  reply.header('set-cookie', parts.join('; '))
}

/**
 * `GET /_inlay/preview?token&path` turns preview on for this browser (the cookie is the token, so it names the
 * release a release link previews); `GET /_inlay/preview/exit` turns it off.
 */
export function registerPreviewRoutes(
  app: FastifyInstance,
  opts: { secret: string; baseUrl: string; now: () => Date },
): void {
  const secure = opts.baseUrl.startsWith('https:')

  app.get(PREVIEW_PATH, async (request, reply) => {
    const query = request.query as Record<string, unknown>
    const token = typeof query.token === 'string' ? query.token : ''
    const now = opts.now()
    const valid = verifyPreviewToken(opts.secret, token, now)
    reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex')
    if (!valid) {
      return reply
        .code(403)
        .type('text/html; charset=utf-8')
        .send(catalogPage('preview.expired.title', 'preview.expired'))
    }
    setCookie(reply, token, Math.ceil((valid.expiresAt.getTime() - now.getTime()) / 1000), secure)
    return reply.redirect(safeTarget(query.path), 302)
  })

  app.get(PREVIEW_EXIT_PATH, async (_request, reply) => {
    setCookie(reply, '', 0, secure)
    return reply.header('cache-control', 'no-store').redirect('/', 302)
  })
}
