import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { InlayError } from '../../core/errors.js'
import type { FormValues } from '../../core/fields/define.js'
import { t, type MessageId } from '../../core/messages/index.js'
import type { Actor } from '../../core/types.js'
import { html } from '../../jsx/html.js'
import { LOGIN_PATH, requestActor } from '../auth/request.js'
import { safeNext, sameOrigin } from '../web.js'
import { badOriginPage } from './pages.js'
import type { AdminRouteOptions } from './routes.js'
import { adminPage } from './views/layout.js'

export const HTML = 'text/html; charset=utf-8'
export const SETUP_PATH = '/admin/setup'

/** Everything admin screens receive. */
export type AdminContext = AdminRouteOptions

/** The part of the admin a page belongs to, for the navigation. */
export type Section =
  | 'dashboard'
  | 'pages'
  | 'globals'
  | `collection:${string}`
  | 'media'
  | 'redirects'
  | 'users'
  | 'backups'
  | 'releases'
  | 'integrations'
  | 'security'
  | 'account'

export type { FormValues }

/** The notices a redirect may ask for with `?notice=<key>`, and the counts each may carry in the query. */
export const NOTICES: Record<string, { id: MessageId; params?: readonly string[] }> = {
  saved: { id: 'admin.notice.saved' },
  unchanged: { id: 'admin.notice.unchanged' },
  created: { id: 'admin.notice.created' },
  deleted: { id: 'admin.notice.deleted' },
  restored: { id: 'admin.notice.restored' },
  uploaded: { id: 'admin.notice.uploaded' },
  reused: { id: 'admin.notice.reused' },
  translated: { id: 'admin.notice.translated' },
  backedUp: { id: 'admin.notice.backedUp' },
  siteLocked: { id: 'admin.notice.siteLocked' },
  siteUnlocked: { id: 'admin.notice.siteUnlocked' },
  sitePasswordSaved: { id: 'admin.notice.sitePasswordSaved' },
  integrationSaved: { id: 'admin.notice.integrationSaved' },
  passwordChanged: { id: 'admin.notice.passwordChanged' },
  userAdded: { id: 'admin.notice.userAdded' },
  userUpdated: { id: 'admin.notice.userUpdated' },
  userRemoved: { id: 'admin.notice.userRemoved' },
  keyRevoked: { id: 'admin.notice.keyRevoked' },
  twoStepOn: { id: 'admin.notice.twoStepOn' },
  twoStepOff: { id: 'admin.notice.twoStepOff' },
  redirectAdded: { id: 'admin.notice.redirectAdded' },
  redirectRemoved: { id: 'admin.notice.redirectRemoved' },
  imported: { id: 'admin.notice.imported', params: ['created', 'updated'] },
  contentImported: { id: 'admin.notice.contentImported', params: ['documents'] },
  altSaved: { id: 'admin.notice.altSaved' },
  bulkDeleted: { id: 'admin.bulkDelete.done', params: ['count'] },
  published: { id: 'admin.notice.published' },
  unpublished: { id: 'admin.notice.unpublished' },
  releaseUploaded: { id: 'admin.notice.releaseUploaded' },
  releaseActivated: { id: 'admin.notice.releaseActivated' },
  releaseDeleted: { id: 'admin.notice.releaseDeleted' },
}

const COUNT = /^\d{1,15}$/

/** The text of the query's `notice`, when it names a known notice and every count it needs is a non-negative integer. */
export function noticeOf(query: unknown): string | undefined {
  if (typeof query !== 'object' || query === null) return undefined
  const q = query as Record<string, unknown>
  const key = q.notice
  if (typeof key !== 'string' || !Object.hasOwn(NOTICES, key)) return undefined
  const notice = NOTICES[key]
  if (!notice) return undefined
  const params: Record<string, number> = {}
  for (const name of notice.params ?? []) {
    const value = Object.hasOwn(q, name) ? q[name] : undefined
    if (typeof value !== 'string' || !COUNT.test(value)) return undefined
    params[name] = Number(value)
  }
  return t(notice.id, params)
}

/**
 * Where a redirect URI sends the user: the host (with any port) for http(s), otherwise the scheme and host
 * (`evilapp://claude.ai`), or just the scheme for an app's own (`cursor:`), so another scheme can't pass for a website.
 */
export function hostOf(raw: string | null): string | undefined {
  if (raw === null) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol === 'https:' || url.protocol === 'http:') return url.host
  return url.host !== '' ? `${url.protocol}//${url.host}` : url.protocol
}

const bodyOf = (request: FastifyRequest): URLSearchParams =>
  request.body instanceof URLSearchParams ? request.body : new URLSearchParams()

/** The submitted urlencoded form, with every repeated value; empty when the body wasn't one. */
export function formValues(request: FastifyRequest): FormValues {
  const params = bodyOf(request)
  return {
    get: (name) => params.get(name) ?? undefined,
    all: (name) => params.getAll(name),
    names: () => [...new Set(params.keys())],
  }
}

/** The first value of each name in the submitted form; empty when the body wasn't one. */
export function formOf(request: FastifyRequest): Record<string, string> {
  const form: Record<string, string> = Object.create(null)
  for (const [key, value] of bodyOf(request)) if (!Object.hasOwn(form, key)) form[key] = value
  return form
}

const actors = new WeakMap<FastifyRequest, Actor>()

/** The signed-in user of a request to a route registered through `registerScreens`. */
export function adminActor(request: FastifyRequest): Actor {
  const actor = actors.get(request)
  if (!actor) throw new InlayError('definition', 'definition.adminActor')
  return actor
}

/** The admin's "you can't open this page" page, with status 403. */
export async function forbidden(reply: FastifyReply, ctx: AdminContext, actor: Actor): Promise<FastifyReply> {
  const body = html`<p>${t('admin.forbidden')}</p><p><a href="/admin" class="link">${t('admin.backToDashboard')}</a></p>`
  const page = await adminPage(ctx, { title: t('admin.forbidden.title'), actor, status: 403 }, body)
  return reply.code(403).type(HTML).send(page)
}

/** The admin's "page not found" page, with status 404. */
export async function notFound(reply: FastifyReply, ctx: AdminContext, actor: Actor): Promise<FastifyReply> {
  const body = html`<p>${t('admin.notFound')}</p><p><a href="/admin" class="link">${t('admin.backToDashboard')}</a></p>`
  const page = await adminPage(ctx, { title: t('admin.notFound.title'), actor, status: 404 }, body)
  return reply.code(404).type(HTML).send(page)
}

/**
 * Registers the screens that need a signed-in user in a child scope. Before any of its routes runs, a POST from
 * another origin gets 403, and a request without a session is sent to log in: an htmx request gets 401 with
 * `HX-Redirect`, anything else a 302 that comes back afterwards (or to setup while there is no owner yet).
 */
export function registerScreens(scope: FastifyInstance, ctx: AdminContext, register: (authed: FastifyInstance) => void): void {
  scope.register(async (authed) => {
    authed.addHook('onRequest', async (request, reply) => {
      if (request.method === 'POST' && !sameOrigin(request, ctx.baseUrl)) {
        return reply.code(403).type(HTML).send(await badOriginPage(ctx))
      }
      const actor = await requestActor(request, ctx.service)
      if (actor) {
        actors.set(request, actor)
        return
      }
      if (request.headers['hx-request'] === 'true') return reply.code(401).header('hx-redirect', LOGIN_PATH).send()
      if (!(await ctx.service.hasOwner())) return reply.redirect(SETUP_PATH, 302)
      return reply.redirect(`${LOGIN_PATH}?${new URLSearchParams({ next: safeNext(request.url) }).toString()}`, 302)
    })
    register(authed)
  })
}
