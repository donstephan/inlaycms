import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import { AUTH_BASE_PATH } from '../../core/auth/auth.js'
import type { AuthService } from '../../core/auth/service.js'
import type { Core } from '../../core/core.js'
import type { Database } from '../../core/db/schema.js'
import { InlayError } from '../../core/errors.js'
import { t, type MessageId } from '../../core/messages/index.js'
import type { AdminHostHooks } from '../../host/hooks.js'
import { LOGIN_PATH, requestActor } from '../auth/request.js'
import { copyCookies, safeNext, sameOrigin, toWebRequest } from '../web.js'
import { registerAssetRoutes, type AdminAssets } from './assets.js'
import { adminActor, formOf, hostOf, HTML, notFound, registerScreens, SETUP_PATH } from './context.js'
import { badOriginPage, consentPage, loginPage, messagePage, setupPage, type SetupField } from './pages.js'
import { registerPublishRoutes } from './publish.js'
import { registerBackups } from './screens/backups.js'
import { registerSecurity } from './screens/security.js'
import { registerDashboard } from './screens/dashboard.js'
import { registerEditor } from './screens/editor.js'
import { registerHistory } from './screens/history.js'
import { registerLists } from './screens/lists.js'
import { registerMedia } from './screens/media.js'
import { registerPreviewPane } from './screens/preview-pane.js'
import { registerPickers } from './screens/pickers.js'
import { registerRedirects } from './screens/redirects.js'
import { registerReleases } from './screens/releases.js'
import { registerSearch } from './screens/search.js'
import { registerUsers } from './screens/users.js'
import type { ResolvedTheme } from './theme.js'
import { registerUploadRoutes } from './upload.js'

const CONSENT_PATH = '/admin/consent'
const SETUP_FIELDS: readonly string[] = ['name', 'email', 'password', 'confirm'] satisfies SetupField[]

export interface AdminRouteOptions {
  service: AuthService
  core: Core
  baseUrl: string
  secret: string
  now: () => Date
  /** The upload limits, for the upload page. */
  uploads: { maxBytes: number; types: readonly string[] }
  /** `logo` is a site URL path, shown as an image in place of the name. */
  branding: { name: string; logo?: string; theme: ResolvedTheme }
  assets: AdminAssets
  /** What the host can do for the Releases screen (preview, activate); without it the screen can only list and upload. */
  host?: AdminHostHooks
  /** The release this site runs, when it is a stored release. */
  release?: { id: string; name: string } | null
  /** Nothing can be changed (a staged release's preview). */
  readOnly?: boolean
  /** The site's database and the folder releases are kept in: with both, owners get the Releases screen. */
  db?: Kysely<Database>
  releasesDir?: string
  /** The public keys an uploaded release must be signed with, when there is no `host` to check it. */
  trustedKeys?: readonly string[]
}

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
}

/** The largest urlencoded form the admin accepts; editor forms with rich text can be large. */
const FORM_LIMIT = 4 * 1024 * 1024

/**
 * The status of an error no route handled: 413 for a form or upload over a limit, 400 for any other request
 * Fastify or a plugin refused (`FST_*` with a 4xx status), 500 for anything else.
 */
function errorStatus(error: unknown): 400 | 413 | 500 {
  const { code, statusCode } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; statusCode?: unknown }
  if (typeof code !== 'string' || !code.startsWith('FST_') || typeof statusCode !== 'number') return 500
  if (statusCode === 413) return 413
  return statusCode >= 400 && statusCode < 500 ? 400 : 500
}

const ERROR_PAGES = {
  400: ['admin.error.badRequest.title', 'admin.error.badRequest'],
  413: ['admin.error.tooLarge.title', 'admin.error.tooLarge'],
  500: ['admin.error.title', 'admin.error'],
} as const satisfies Record<number, [MessageId, MessageId]>

/** The raw query string of `url`, without the `?`. */
function rawQuery(url: string): string | undefined {
  const q = url.indexOf('?')
  return q === -1 ? undefined : url.slice(q + 1)
}

/** The `url` of better-auth's JSON `{ redirect: true, url }`, which tells the browser where to go next. */
async function redirectOf(res: Response): Promise<string | undefined> {
  const json: unknown = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null
  if (typeof json === 'object' && json !== null && 'redirect' in json && json.redirect === true && 'url' in json) {
    if (typeof json.url === 'string') return json.url
  }
  return undefined
}

/** The raw query string when it carries a signed OAuth authorize request (`sig=`). */
function oauthQueryOf(raw: string | undefined): string | undefined {
  return raw !== undefined && /(?:^|&)sig=/.test(raw) ? raw : undefined
}

/**
 * The pages under `/admin`. They live in their own encapsulated plugin with a local form parser (a `URLSearchParams`),
 * and every response carries the security headers, `no-store` and `noindex`. Setup, login, consent, the upload link
 * and the assets work without a session; everything else is registered through `registerScreens`.
 */
export function registerAdminRoutes(app: FastifyInstance, opts: AdminRouteOptions): void {
  const { service, baseUrl } = opts

  /** Signs in through `auth.handler`, so better-auth's rate limits apply. */
  function signIn(request: FastifyRequest, input: { email: string; password: string; oauth_query?: string }): Promise<Response> {
    return service.auth.handler(
      toWebRequest(request, baseUrl, {
        path: `${AUTH_BASE_PATH}/sign-in/email`,
        body: JSON.stringify({ ...input, rememberMe: true }),
        headers: { 'content-type': 'application/json', accept: 'application/json' },
      }),
    )
  }

  const page = (reply: FastifyReply, status: number, body: string) => reply.code(status).type(HTML).send(body)
  const refuseOrigin = async (reply: FastifyReply) => page(reply, 403, await badOriginPage(opts))
  const consentFailed = async (reply: FastifyReply) =>
    page(reply, 400, await messagePage(opts, 'auth.consent.failed.title', 'auth.consent.failed'))
  const failed = async (reply: FastifyReply) => page(reply, 500, await messagePage(opts, 'site.error.title', 'site.error'))

  app.register(async (child) => {
    child.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: FORM_LIMIT },
      (_request, body, done) => done(null, new URLSearchParams(body as string)),
    )
    // Set before any handler, so a route's own headers (the logo's stricter CSP, an asset's caching) win.
    child.addHook('onRequest', async (_request, reply) => {
      reply.headers(SECURITY_HEADERS)
    })
    // Anything no route handled, including a form over the size limit: logged, and answered with a plain page.
    child.setErrorHandler(async (error, request, reply) => {
      const status = errorStatus(error)
      if (status === 500) request.log.error({ err: error }, 'admin request failed')
      else request.log.warn({ err: error }, 'admin request refused')
      const [title, body] = ERROR_PAGES[status]
      return reply.code(status).headers(SECURITY_HEADERS).type(HTML).send(await messagePage(opts, title, body))
    })

    child.get(SETUP_PATH, async (_request, reply) => {
      if (await service.hasOwner()) return reply.redirect(LOGIN_PATH, 302)
      return page(reply, 200, await setupPage(opts, {}))
    })

    child.post(SETUP_PATH, async (request, reply) => {
      if (!sameOrigin(request, baseUrl)) return refuseOrigin(reply)
      if (await service.hasOwner()) return reply.redirect(LOGIN_PATH, 302)
      const form = formOf(request)
      const input = { name: form.name ?? '', email: form.email ?? '', password: form.password ?? '' }
      const values = { name: input.name, email: input.email }
      if (input.password !== (form.confirm ?? '')) {
        return page(reply, 400, await setupPage(opts, { values, errors: { confirm: [t('auth.passwordsDiffer')] } }))
      }
      try {
        await service.createOwner(input)
      } catch (e) {
        if (!(e instanceof InlayError)) throw e
        if (e.messageId === 'error.ownerExists') return reply.redirect(LOGIN_PATH, 302)
        if (e.code !== 'validation') throw e
        const errors: Partial<Record<SetupField, string[]>> = {}
        for (const issue of e.details.issues ?? []) {
          const at = issue.path[0]
          const key = (typeof at === 'string' && SETUP_FIELDS.includes(at) ? at : 'email') as SetupField
          ;(errors[key] ??= []).push(issue.message)
        }
        return page(reply, 400, await setupPage(opts, { values, errors }))
      }
      const res = await signIn(request, { email: input.email.trim(), password: input.password })
      if (!res.ok) return reply.redirect(LOGIN_PATH, 302)
      copyCookies(reply, res)
      return reply.redirect('/admin', 302)
    })

    child.get(LOGIN_PATH, async (request, reply) => {
      const query = request.query as Record<string, unknown>
      const oauthQuery = oauthQueryOf(rawQuery(request.url))
      return page(reply, 200, await loginPage(opts, { next: safeNext(query.next), ...(oauthQuery !== undefined && { oauthQuery }) }))
    })

    child.post(LOGIN_PATH, async (request, reply) => {
      // Otherwise another site could sign a visitor in to an account of its choosing.
      if (!sameOrigin(request, baseUrl)) return refuseOrigin(reply)
      const form = formOf(request)
      const email = form.email ?? ''
      const next = safeNext(form.next)
      const oauthQuery = oauthQueryOf(form.oauth_query)
      const again = async (status: number, error: string) =>
        page(reply, status, await loginPage(opts, { email, next, error, ...(oauthQuery !== undefined && { oauthQuery }) }))

      const res = await signIn(request, {
        email,
        password: form.password ?? '',
        ...(oauthQuery !== undefined && { oauth_query: oauthQuery }),
      })
      if (res.status === 429) return again(429, t('auth.tooManyAttempts'))
      if (res.status >= 500) {
        request.log.error({ status: res.status }, await res.text())
        return failed(reply)
      }
      // Bad credentials (401), a banned user (403) or a malformed email (400) all read the same.
      if (!res.ok) return again(401, t('auth.loginFailed'))
      copyCookies(reply, res)
      // The OAuth redirect better-auth returns itself (the consent page or the client's redirect URI).
      const url = await redirectOf(res)
      return reply.redirect(url ?? next, 302)
    })

    child.get(CONSENT_PATH, async (request, reply) => {
      const query = rawQuery(request.url)
      const actor = await requestActor(request, service)
      if (!actor) return reply.redirect(query === undefined ? LOGIN_PATH : `${LOGIN_PATH}?${query}`, 302)
      const params = new URLSearchParams(query ?? '')
      const clientId = params.get('client_id')
      const client = clientId === null ? null : await service.oauthClient(clientId)
      if (!client) return page(reply, 400, await messagePage(opts, 'auth.consent.unknownClient.title', 'auth.consent.unknownClient'))
      const oauthQuery = oauthQueryOf(query)
      const host = hostOf(params.get('redirect_uri'))
      if (oauthQuery === undefined || host === undefined) return consentFailed(reply)
      const hosts = [...new Set(client.redirectUris.map(hostOf).filter((h) => h !== undefined))]
      const scopes = (params.get('scope') ?? '').split(' ').filter((s) => s !== '')
      return page(reply, 200, await consentPage(opts, { client: client.name, host, hosts, name: actor.name, scopes, oauthQuery }))
    })

    child.post(CONSENT_PATH, async (request, reply) => {
      if (!sameOrigin(request, baseUrl)) return refuseOrigin(reply)
      const form = formOf(request)
      const oauthQuery = oauthQueryOf(form.oauth_query)
      if (oauthQuery === undefined) return consentFailed(reply)
      // better-auth checks the session and the query's signature, and records the consent.
      const res = await service.auth.handler(
        toWebRequest(request, baseUrl, {
          path: `${AUTH_BASE_PATH}/oauth2/consent`,
          body: JSON.stringify({ accept: form.accept === 'true', oauth_query: oauthQuery }),
          headers: { 'content-type': 'application/json', accept: 'application/json' },
        }),
      )
      if (res.status === 401) return reply.redirect(`${LOGIN_PATH}?${oauthQuery}`, 302)
      if (res.status >= 500) {
        request.log.error({ status: res.status }, await res.text())
        return failed(reply)
      }
      if (!res.ok) return consentFailed(reply)
      copyCookies(reply, res)
      // The client's redirect URI, with a code or `error=access_denied`; better-auth built it from the signed query.
      const url = await redirectOf(res)
      return url === undefined ? consentFailed(reply) : reply.redirect(url, 302)
    })

    child.post('/admin/logout', async (request, reply) => {
      if (!sameOrigin(request, baseUrl)) return refuseOrigin(reply)
      const res = await service.auth.handler(
        toWebRequest(request, baseUrl, {
          path: `${AUTH_BASE_PATH}/sign-out`,
          body: '{}',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
        }),
      )
      copyCookies(reply, res)
      return reply.redirect(LOGIN_PATH, 302)
    })

    registerAssetRoutes(child, opts.assets)
    registerUploadRoutes(child, opts)

    registerScreens(child, opts, (authed) => {
      registerDashboard(authed, opts)
      registerLists(authed, opts)
      registerEditor(authed, opts)
      registerPreviewPane(authed, opts)
      registerHistory(authed, opts)
      registerMedia(authed, opts)
      registerPickers(authed, opts)
      registerRedirects(authed, opts)
      registerUsers(authed, opts)
      registerBackups(authed, opts)
      registerReleases(authed, opts)
      registerSecurity(authed, opts)
      registerPublishRoutes(authed, opts)
      registerSearch(authed, opts)
      // Any other address under /admin: the admin's own 404 page, after the session (and, for a POST, origin) check.
      authed.get('/admin/*', async (request, reply) => notFound(reply, opts, adminActor(request)))
      authed.post('/admin/*', async (request, reply) => notFound(reply, opts, adminActor(request)))
    })
  })
}
