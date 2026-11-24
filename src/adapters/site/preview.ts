import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createPreviewToken, verifyPreviewToken } from '../../core/preview.js'
import { encodePath, normalizePath, presentHref, type TrailingSlash } from '../../core/site/paths.js'
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
 * A link that turns preview on for 24 hours and opens `path` (a decoded site path, default `/`). It shows the live
 * site's drafts on that page only: every other page stays as published. With `release`, it previews that whole staged
 * release instead.
 */
export function previewLink(
  opts: { baseUrl: string; secret: string; now: () => Date },
  path = '/',
  link: { release?: string } = {},
): string {
  const page = normalizePath(path) ?? '/'
  const token = createPreviewToken(opts.secret, opts.now(), link.release === undefined ? { path: page } : { release: link.release })
  const query = new URLSearchParams({ token, path: encodePath(path) })
  return `${opts.baseUrl}${PREVIEW_PATH}?${query.toString()}`
}

/** The decoded site path the request asks for, or null if it isn't a clean one. */
function requestPath(request: FastifyRequest): string | null {
  const q = request.url.indexOf('?')
  return normalizePath(q === -1 ? request.url : request.url.slice(0, q))
}

/**
 * What the request's preview cookie says. `state`: `'preview'` when the cookie is valid and covers this request (a
 * release's cookie covers every page, a page's cookie only its own page), otherwise `'published'`. `release`: the
 * staged release it previews. `page`: the one page of the live site's drafts it previews. Both are null without a
 * valid cookie.
 */
export function readPreview(
  request: FastifyRequest,
  secret: string,
  now: Date,
): { state: LiveState; release: string | null; page: string | null } {
  const token = readCookie(request, PREVIEW_COOKIE)
  const valid = token === undefined ? null : verifyPreviewToken(secret, token, now)
  if (valid === null) return { state: 'published', release: null, page: null }
  const covered = valid.release !== null || valid.path === requestPath(request)
  return { state: covered ? 'preview' : 'published', release: valid.release, page: valid.path }
}

/** `'preview'` when the request carries a valid preview cookie (of the live site or of a release), otherwise `'published'`. */
export function previewState(request: FastifyRequest, secret: string, now: Date): LiveState {
  return readPreview(request, secret, now).state
}

/** `raw` in its presented form when it's a clean, encoded site-relative path, otherwise `/`. */
function safeTarget(raw: unknown, mode: TrailingSlash): string {
  if (typeof raw !== 'string') return '/'
  const normalized = normalizePath(raw)
  if (normalized === null) return '/'
  const encoded = encodePath(normalized)
  const presented = presentHref(encoded, mode)
  return raw === encoded || raw === presented ? presented : '/'
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
  opts: { secret: string; baseUrl: string; now: () => Date; trailingSlash?: TrailingSlash },
): void {
  const mode = opts.trailingSlash ?? 'never'
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
    // A page's link opens its own page, whatever the address asks for: nowhere else would show a draft.
    const target = valid.path === null ? safeTarget(query.path, mode) : presentHref(encodePath(valid.path), mode)
    return reply.redirect(target, 302)
  })

  app.get(PREVIEW_EXIT_PATH, async (_request, reply) => {
    setCookie(reply, '', 0, secure)
    return reply.header('cache-control', 'no-store').redirect('/', 302)
  })
}
