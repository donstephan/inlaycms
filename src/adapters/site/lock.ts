import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import type { AuthService } from '../../core/auth/service.js'
import type { Database } from '../../core/db/schema.js'
import { t, type MessageId } from '../../core/messages/index.js'
import { matchSitePassword, readSiteLock } from '../../core/site-lock/site-lock.js'
import { createUnlockToken, UNLOCK_TTL_MS, verifyUnlockToken } from '../../core/site-lock/token.js'
import { escapeHtml, raw } from '../../jsx/html.js'
import { requestActor } from '../auth/request.js'
import { safeNext } from '../web.js'
import { FailureLimiter } from './limiter.js'
import { readPreview } from './preview.js'
import { inlayPage } from './render.js'

export const UNLOCK_COOKIE = 'inlay_unlock'
export const UNLOCK_PATH = '/_inlay/unlock'

export interface SiteLockGateOptions {
  db: Kysely<Database>
  service: AuthService
  secret: string
  baseUrl: string
  now: () => Date
  publicPaths: readonly string[]
  /**
   * The release a forced preview shows: a preview cookie for it lets a request through, as the proxy that forwarded it
   * already checked it. Elsewhere a cookie that previews a release never does.
   */
  release?: string
}

/** Paths that are never locked, with everything under them. */
const EXEMPT_PREFIXES = ['/admin', '/api/auth', '/mcp', '/.well-known', '/_inlay', '/public']

/** Dot segments, encoded slashes, dots or backslashes, and empty segments: none may borrow an exemption. */
const TRICKY = /(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\|\/\//i

const locked = new WeakSet<FastifyRequest>()

/** True when the gate saw the lock on for this request. */
export function isLockedRequest(request: FastifyRequest): boolean {
  return locked.has(request)
}

/** The site's own catch-all routes, which would answer any unknown path under an exemption with the site's 404. */
const SITE_ROUTES = new Set(['/', '/*'])

function exempt(request: FastifyRequest, path: string, publicPaths: readonly string[]): boolean {
  const route = request.routeOptions.url
  if (route === undefined || SITE_ROUTES.has(route)) return false
  if (publicPaths.includes(path)) return true
  if (TRICKY.test(path)) return false
  return EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

function readCookie(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/** The neutral screen asking for the site password, which sends it to `UNLOCK_PATH` and comes back to `next`. */
export function passwordScreen(baseUrl: string, next: string, error?: MessageId): string {
  const alert = error === undefined ? '' : `<p role="alert" class="inlay-error">${escapeHtml(t(error))}</p>`
  const body =
    `<p>${escapeHtml(t('site.lock.intro'))}</p>${alert}` +
    `<form method="post" action="${UNLOCK_PATH}">` +
    `<input type="hidden" name="next" value="${escapeHtml(next)}">` +
    `<label for="inlay-password">${escapeHtml(t('site.lock.password'))}</label>` +
    '<input type="password" id="inlay-password" name="password" autocomplete="current-password" required autofocus>' +
    `<button type="submit">${escapeHtml(t('site.lock.submit'))}</button></form>`
  return inlayPage(new URL(baseUrl).host, raw(body))
}

/** Locks every request but the exempt ones while the site lock is on, and keeps let-through responses out of shared caches. */
export function registerSiteLockGate(app: FastifyInstance, opts: SiteLockGateOptions): void {
  async function unlocked(request: FastifyRequest, passwordHash: string | null): Promise<boolean> {
    const cookie = request.headers.cookie
    if (typeof cookie !== 'string') return false
    const now = opts.now()
    const token = readCookie(cookie, UNLOCK_COOKIE)
    if (token !== undefined && passwordHash !== null && verifyUnlockToken(opts.secret, passwordHash, token, now)) return true
    // A preview of the live site's drafts; a release's preview is answered by its own worker, through the proxy.
    const preview = readPreview(request, opts.secret, now)
    if (preview.state === 'preview' && (preview.release === null || preview.release === opts.release)) return true
    return (await requestActor(request, opts.service)) !== null
  }

  app.addHook('onRequest', async (request, reply) => {
    const q = request.url.indexOf('?')
    const path = q === -1 ? request.url : request.url.slice(0, q)
    if (exempt(request, path, opts.publicPaths)) return
    const lock = await readSiteLock(opts.db)
    if (!lock.enabled) return
    locked.add(request)
    if (path === '/robots.txt') return
    if (await unlocked(request, lock.passwordHash)) return
    return reply
      .code(401)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('x-robots-tag', 'noindex')
      .send(passwordScreen(opts.baseUrl, safeNext(request.url, '/')))
  })

  app.addHook('onSend', async (request, reply, payload) => {
    if (!locked.has(request)) return payload
    reply.header('x-robots-tag', 'noindex')
    reply.header('cache-control', privateControl(reply.getHeader('cache-control')))
    return payload
  })
}

/** `control` made private: kept when already `private` or `no-store`, else `public` swapped for `private`. */
function privateControl(control: string | number | string[] | undefined): string {
  const directives = (Array.isArray(control) ? control.join(',') : String(control ?? ''))
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d !== '')
  if (directives.length === 0) return 'private, no-cache'
  const lower = directives.map((d) => d.toLowerCase())
  if (lower.includes('private') || lower.includes('no-store')) return directives.join(', ')
  return ['private', ...directives.filter((_, i) => lower[i] !== 'public')].join(', ')
}

const FORM_LIMIT = 4 * 1024

/** `POST /_inlay/unlock`: checks the site password, sets the unlock cookie and returns to `next`; wrong guesses are rate limited per client IP. */
export function registerUnlockRoute(app: FastifyInstance, opts: SiteLockGateOptions & { rateLimit: boolean }): void {
  const limiter = new FailureLimiter({ max: 5, windowMs: 60_000 })
  const secure = opts.baseUrl.startsWith('https:')

  app.register(async (child) => {
    child.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: FORM_LIMIT },
      (_request, body, done) => done(null, new URLSearchParams(body as string)),
    )
    child.post(UNLOCK_PATH, async (request, reply) => {
      const form = request.body instanceof URLSearchParams ? request.body : new URLSearchParams()
      const next = safeNext(form.get('next'), '/')
      reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex')
      const screen = (status: number, error: MessageId) =>
        reply.code(status).type('text/html; charset=utf-8').send(passwordScreen(opts.baseUrl, next, error))
      if (!(await readSiteLock(opts.db)).enabled) return reply.redirect(next, 303)
      if (opts.rateLimit) {
        const now = opts.now().getTime()
        if (limiter.blocked(request.ip, now)) return screen(429, 'site.lock.tooMany')
        // Counted before the slow check, so concurrent guesses can't all slip past `blocked`
        limiter.fail(request.ip, now)
      }
      const passwordHash = await matchSitePassword(opts.db, form.get('password') ?? '')
      if (passwordHash === null) return screen(401, 'site.lock.wrong')
      if (opts.rateLimit) limiter.refund(request.ip)
      const token = createUnlockToken(opts.secret, passwordHash, opts.now())
      const parts = [`${UNLOCK_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${UNLOCK_TTL_MS / 1000}`]
      if (secure) parts.push('Secure')
      reply.header('set-cookie', parts.join('; '))
      return reply.redirect(next, 303)
    })
  })
}
