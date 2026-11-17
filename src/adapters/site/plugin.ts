import { dirname, join } from 'node:path'
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import type { AuthService } from '../../core/auth/service.js'
import { DEFAULT_KEEP, SCHEDULE_INTERVAL_MS } from '../../core/backup/schedule.js'
import { bootInlay } from '../../core/boot.js'
import { readOnlyCore, type Core } from '../../core/core.js'
import { InlayError } from '../../core/errors.js'
import { DEFAULT_MAX_BYTES, DEFAULT_UPLOAD_TYPES } from '../../core/media/detect.js'
import { t } from '../../core/messages/index.js'
import { externalTarget } from '../../core/redirects/rule.js'
import type { SiteDefinition } from '../../core/registry/define.js'
import { buildRegistry, type Registry } from '../../core/registry/registry.js'
import type { Entry, QueryOptions, QueryResult } from '../../core/registry/render.js'
import { encodePath, normalizePath, splitLocale } from '../../core/site/paths.js'
import type { LiveState, UploadLimits } from '../../core/types.js'
import type { AdminHostHooks } from '../../host/hooks.js'
import type { ActivationSummary } from '../../host/ipc.js'
import { loadAdminAssets } from '../admin/assets.js'
import { registerAdminRoutes } from '../admin/routes.js'
import { resolveTheme, themeContrastProblems } from '../admin/theme.js'
import { registerAuthHandler } from '../auth/handler.js'
import { AUTH_BASE_PATH } from '../../core/auth/auth.js'
import { LOGIN_PATH } from '../auth/request.js'
import { fetchRemoteFile } from '../mcp/fetch-url.js'
import { registerMcpRoute } from '../mcp/route.js'
import { createInlayMcpHandler } from '../mcp/server.js'
import { sendWebResponse, toWebRequest } from '../web.js'
import { publicAssets, type PublicAssets } from './assets.js'
import { cacheControl, etagMatches, PageCache, response, type CachedResponse, type CdnOptions } from './cache.js'
import { createRenderContext } from './context.js'
import { registerSiteHeaders, siteHeaders } from './headers.js'
import { startBackupSchedule, type BackupSchedule } from './backup-schedule.js'
import { isLockedRequest, registerSiteLockGate, registerUnlockRoute } from './lock.js'
import { registerMediaRoutes } from './media-routes.js'
import { registerPublicRoutes } from './public.js'
import { previewLink, readPreview, registerPreviewRoutes } from './preview.js'
import { catalogPage, renderPage } from './render.js'
import { registerReleaseRoutes } from './routes.js'
import { renderSitemap } from './sitemap.js'

export interface InlayOptions {
  site: SiteDefinition
  db: string
  /** The site's absolute http(s) origin, such as `https://example.com`. */
  baseUrl: string
  /** Signs preview links; at least 32 characters. */
  secret: string
  /** Defaults to `media` next to `db`. */
  media?: string
  /** Defaults to `backups` next to `db`. */
  backups?: string
  uploads?: UploadLimits
  cache?: { maxEntries?: number } | false
  /** How long CDNs and proxies may hold published pages. ETags are always sent. */
  cdn?: CdnOptions
  now?: () => Date
  /** Limits login attempts per client. Defaults to `true`; turn it off only in tests. */
  rateLimit?: boolean
  /** A daily backup, keeping the newest `keep` (default 14). Defaults to on; `false` turns it off. */
  backupSchedule?: { keep?: number } | false
  /** Absolute path of the folder served at `/public/*`. Without it that path is not served. */
  publicDir?: string
  /** Seconds browsers and CDNs may keep `/public/*` files (default 3600). */
  publicMaxAge?: number
  /** Secret values by name, such as API tokens. Routes see only the ones their site declares in `secrets`. */
  secrets?: Record<string, string>
  /** What routes get as `ctx.fetch`; the global `fetch` by default. */
  fetch?: typeof fetch
  /** `'apply'` (the default) applies the site's shipped content at boot; `'none'` leaves content to release activation. */
  content?: 'apply' | 'none'
  /**
   * Every content page answers a plain page instead of the site; the admin works as usual. `'empty'`: "no site yet"
   * (status 200, not indexed), for a host with no release. `'unavailable'`: "temporarily unavailable" (status 503
   * with Retry-After), for a site that is down, so search engines keep it.
   */
  noSite?: 'empty' | 'unavailable'
  /** Set by `inlaycms serve`: what the site can ask of the server it runs under. */
  host?: HostApi
  /** A loaded release's shipped files, by source as written in the site. */
  shippedFiles?: ReadonlyMap<string, string>
  /**
   * Nothing can be changed: every write through the core is refused with `error.previewReadOnly`, and the admin and
   * `/api/auth` answer their write requests (other than logging in and out) with 403. Boot still applies shipped
   * content and, with `release`, then runs the site's migration functions. Set for a staged release's preview, which
   * runs on a copy of the database.
   */
  readOnly?: boolean
  /**
   * `'forced'`: every content request renders in preview state (drafts as published, not cached, not indexed, with the
   * banner), cookie or not, and no answer may be stored by a browser or a shared cache.
   */
  preview?: 'forced'
  /** The release this site runs, when it is a stored release; a forced preview's banner names it. */
  release?: { id: string; name: string }
  /** The folder releases are kept in. With it, owners get the admin's Releases screen. */
  releasesDir?: string
  /** The public keys a release uploaded in the admin must be signed with, when there is no `adminHost`. */
  trustedKeys?: readonly string[]
  /** What the admin's Releases screen can ask of `inlaycms serve` (preview, activate, push checks). */
  adminHost?: AdminHostHooks
}

/** What a site running under `inlaycms serve` can ask of the server. */
export interface HostApi {
  /**
   * Makes a stored release live: resolves with what the activation did once the new release is serving; rejects
   * with the activation's error, the previous release still live.
   */
  requestActivation(releaseId: string): Promise<ActivationSummary>
  /**
   * Starts (or finds) the preview worker of a staged release and resolves with the Unix socket it listens on. `dir`:
   * the push's scratch folder the release is in, for a dry run (recorded as staged only in the preview's copy).
   */
  startPreview?(releaseId: string, opts?: { dir?: string }): Promise<string>
  /** The staged release's preview worker is no longer needed. */
  stopPreview?(releaseId: string): Promise<void>
  /** The staged release's preview is still in use, so its worker isn't stopped as idle. */
  touchPreview?(releaseId: string): void
}

/** Where tests find the plugin's `AuthService` on `app.inlay`; not part of the public API. */
export const AUTH = Symbol('inlay.auth')

export interface InlayApi {
  core: Core
  /** Published content: singletons and globals by type, entries by slug. */
  getDocument<F = Record<string, unknown>>(
    type: string,
    opts?: { locale?: string; slug?: string },
  ): Promise<Entry<F> | null>
  /** Published entries of `collection`, filtered, sorted and paginated as in a template's `ctx.query`. */
  query<F = Record<string, unknown>>(
    collection: string,
    opts?: QueryOptions<F> & { locale?: string },
  ): Promise<QueryResult<F>>
  previewUrl(path?: string): string
  /** Clears the page cache. */
  clearCache(): void
  /** The server the site runs under, with `inlaycms serve`; null otherwise. */
  host: HostApi | null
  /** @internal The plugin's auth service (non-enumerable). */
  readonly [AUTH]: AuthService
}

declare module 'fastify' {
  interface FastifyInstance {
    inlay: InlayApi
  }
}

const HTML = 'text/html; charset=utf-8'
const PAGE = /^[1-9][0-9]{0,8}$/

/** The origin of `value` when it's an absolute http(s) URL with nothing after the host. */
function checkBaseUrl(value: unknown): string {
  const fail = () => new InlayError('config', 'config.baseUrl', { value: String(value) })
  if (typeof value !== 'string') throw fail()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw fail()
  }
  const bare = url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '' && url.password === ''
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !bare || !/^https?:\/\/[^/?#]+\/?$/i.test(value)) {
    throw fail()
  }
  return url.origin
}

function checkOptions(opts: InlayOptions, registry: Registry): string {
  const baseUrl = checkBaseUrl(opts.baseUrl)
  if (typeof opts.secret !== 'string' || opts.secret.length < 32) throw new InlayError('config', 'config.secret')
  const keep = opts.backupSchedule === false ? undefined : opts.backupSchedule?.keep
  if (keep !== undefined && (!Number.isInteger(keep) || keep < 1)) {
    throw new InlayError('config', 'config.backupKeep', { value: String(keep) })
  }
  for (const def of registry.types.values()) {
    const routed =
      def.kind === 'singleton' ? def.path !== null : def.kind === 'collection' && (def.route !== null || def.customPaths)
    if (routed && !def.template.render) throw new InlayError('config', 'config.renderMissing', { name: def.template.name })
  }
  return baseUrl
}

function splitUrl(url: string): { path: string; search: string } {
  const q = url.indexOf('?')
  return q === -1 ? { path: url, search: '' } : { path: url.slice(0, q), search: url.slice(q) }
}

function createApi(
  core: Core,
  cache: PageCache | undefined,
  service: AuthService,
  opts: { baseUrl: string; secret: string; now: () => Date; host: HostApi | null; assets: PublicAssets },
): InlayApi {
  const { baseUrl } = opts
  const context = (locale: string | undefined) =>
    createRenderContext(core, {
      locale: locale ?? core.registry.defaultLocale,
      state: 'published',
      page: 1,
      baseUrl,
      alternates: [],
      assets: opts.assets,
    })

  const api: Omit<InlayApi, typeof AUTH> = {
    core,
    async getDocument<F>(type: string, opts: { locale?: string; slug?: string } = {}) {
      const def = core.registry.getType(type)
      const ctx = context(opts.locale)
      if (def.kind === 'collection') {
        const { slug } = opts
        if (slug === undefined) return null
        const found = await ctx.query(type, { filter: (e) => e.slug === slug, limit: 1 })
        return (found.items[0] as Entry<F> | undefined) ?? null
      }
      const doc = await core.liveSingleton(type, ctx.locale)
      if (!doc) return null
      await ctx.preload([doc])
      const [entry] = await ctx.entries<F>(doc.groupId)
      return entry ?? null
    },
    async query<F>(collection: string, opts: QueryOptions<F> & { locale?: string } = {}) {
      const { locale, ...rest } = opts
      return (await context(locale).query(collection, rest as QueryOptions)) as QueryResult<F>
    },
    previewUrl(path = '/') {
      return previewLink(opts, path)
    },
    clearCache() {
      cache?.clear()
    },
    host: opts.host,
  }
  return Object.defineProperty(api, AUTH, { value: service, enumerable: false }) as InlayApi
}

function registerSiteRoutes(
  app: FastifyInstance,
  core: Core,
  cache: PageCache | undefined,
  opts: {
    baseUrl: string
    secret: string
    now: () => Date
    cdn?: CdnOptions
    noSite?: 'empty' | 'unavailable'
    preview?: 'forced'
    /** The name of the release a forced preview shows. */
    release?: string
    assets: PublicAssets
  },
): void {
  const { registry } = core
  const { notFound } = registry.site
  const { baseUrl, cdn, assets } = opts
  const banner = opts.release === undefined ? {} : { release: opts.release }

  async function notFoundPage(locale: string, state: LiveState): Promise<string> {
    if (notFound !== null) {
      const doc = await core.liveSingleton(notFound, locale, { state })
      if (doc) return renderPage(core, doc, { state, page: 1, baseUrl, assets, ...banner })
    }
    return catalogPage('site.notFound.title', 'site.notFound')
  }

  function localeOf(rawPath: string): string {
    const path = normalizePath(rawPath)
    return path === null ? registry.defaultLocale : splitLocale(registry, path).locale
  }

  const control = cacheControl(cdn)

  /** Sends a published response with the headers shared caches need, or a 304 when the client already has it. */
  function send(request: FastifyRequest, reply: FastifyReply, res: CachedResponse, hit: boolean | undefined): FastifyReply {
    if (hit !== undefined) reply.header('x-inlay-cache', hit ? 'hit' : 'miss')
    reply.header('cache-control', control).header('vary', 'Cookie').header('etag', res.etag)
    if (etagMatches(request.headers['if-none-match'], res.etag)) return reply.code(304).send()
    return reply.code(res.status).type(res.type).send(res.body)
  }

  /** Preview responses are never stored or revalidated. */
  function sendPreview(reply: FastifyReply, status: number, body: string): FastifyReply {
    return reply.code(status).type(HTML).send(body)
  }

  /** Serves `key` from the cache, or renders it and stores the result unless a live change landed meanwhile. */
  async function cached(
    request: FastifyRequest,
    reply: FastifyReply,
    key: string,
    status: number,
    type: string,
    render: () => Promise<string>,
  ): Promise<FastifyReply> {
    if (!cache) return send(request, reply, response(status, await render(), type), undefined)
    const hit = cache.get(key)
    if (hit) return send(request, reply, hit, true)
    const generation = cache.generation
    const res = response(status, await render(), type)
    cache.set(key, res, generation)
    return send(request, reply, res, false)
  }

  const missing = async (request: FastifyRequest, reply: FastifyReply, locale: string, state: LiveState) =>
    state === 'preview'
      ? sendPreview(reply, 404, await notFoundPage(locale, state))
      : cached(request, reply, `404:${locale}`, 404, HTML, () => notFoundPage(locale, state))

  /** A cookie that previews a staged release reaches this app only when that preview isn't available: the live site answers. */
  function stateOf(request: FastifyRequest): LiveState {
    if (request.headers.cookie === undefined) return 'published'
    const found = readPreview(request, opts.secret, opts.now())
    return found.release === null ? found.state : 'published'
  }

  async function handle(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const { path, search } = splitUrl(request.url)
    const state = opts.preview === 'forced' ? 'preview' : stateOf(request)
    const preview = state === 'preview'
    if (preview) reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex')
    try {
      const params = new URLSearchParams(search)
      const pageParam = params.get('page')
      if (pageParam !== null && !PAGE.test(pageParam)) return await missing(request, reply, localeOf(path), state)
      const pageNumber = Number(pageParam ?? 1)
      const normalized = normalizePath(path)
      const canonical = normalized !== null && encodePath(normalized) === path
      const key =
        preview || normalized === null || !canonical
          ? null
          : pageNumber > 1
            ? `${normalized}?page=${pageNumber}`
            : normalized
      const hit = key === null ? undefined : cache?.get(key)
      if (hit) return send(request, reply, hit, true)
      const generation = cache?.generation ?? 0
      const match = await core.resolvePath(path, { state })
      if (match.kind === 'redirect') {
        if (match.external === true && externalTarget(match.location) === match.location) {
          return reply.redirect(match.location, match.status)
        }
        if (match.external !== true && match.location.startsWith('/') && !match.location.startsWith('//')) {
          return reply.redirect(`${match.location}${search}`, match.status)
        }
      }
      if (match.kind === 'page') {
        const html = await renderPage(core, match.document, { state, page: pageNumber, baseUrl, assets, ...banner })
        if (preview) return sendPreview(reply, 200, html)
        const res = response(200, html, HTML)
        if (cache && key !== null) {
          cache.set(key, res, generation)
          return send(request, reply, res, false)
        }
        return send(request, reply, res, undefined)
      }
      if (match.kind === 'not_found' && match.loop) {
        request.log.warn({ loop: match.loop }, t('log.redirectLoop', { path, rules: match.loop.join(', ') }))
      }
      return await missing(request, reply, match.kind === 'not_found' ? match.locale : registry.defaultLocale, state)
    } catch (err) {
      request.log.error({ err }, t('log.renderFailed', { path }))
      return reply.code(500).type(HTML).send(catalogPage('site.error.title', 'site.error'))
    }
  }

  async function unavailable(_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    reply.header('cache-control', 'no-store').header('retry-after', '60')
    return reply.code(503).type(HTML).send(catalogPage('site.unavailable.title', 'site.unavailable'))
  }

  // A site that is down has no sitemap to give: an empty one would tell search engines its pages are gone.
  app.get('/sitemap.xml', async (request, reply) =>
    opts.noSite === 'unavailable'
      ? unavailable(request, reply)
      : cached(request, reply, 'sitemap.xml', 200, 'application/xml', async () =>
          renderSitemap(await core.sitemapEntries(), baseUrl),
        ),
  )
  app.get('/robots.txt', async (request, reply) => {
    reply.type('text/plain; charset=utf-8')
    if (isLockedRequest(request)) return reply.header('cache-control', 'no-store').send('User-agent: *\nDisallow: /\n')
    return reply.send(`User-agent: *\nDisallow: /_inlay/\nSitemap: ${baseUrl}/sitemap.xml\n`)
  })
  async function noSite(_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex')
    return reply.code(200).type(HTML).send(catalogPage('site.noSite.title', 'site.noSite'))
  }

  const content = opts.noSite === 'empty' ? noSite : opts.noSite === 'unavailable' ? unavailable : handle
  app.get('/', content)
  app.get('/*', content)
}

/**
 * Logs one warning when Fastify's `trustProxy` isn't set on a site served over https by something else (most likely
 * a reverse proxy): better-auth's login limits key on the client IP. Fastify doesn't expose `trustProxy` on
 * `initialConfig`, but `request.ips` exists only when it is set, so the first request tells.
 */
function warnWithoutTrustProxy(app: FastifyInstance, baseUrl: string): void {
  let checked = false
  app.addHook('onRequest', async (request) => {
    if (checked) return
    checked = true
    if (request.ips === undefined) app.log.warn(t('log.noTrustProxy', { baseUrl }))
  })
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`)

/**
 * Whether a write to `path` changes something: anything under the admin or `/api/auth` but logging in and out. `route`
 * is the matched route, which Fastify finds for a percent-encoded path too (`/%61dmin/x` is the `/admin/x` route).
 */
function isWrite(path: string, route: string | undefined): boolean {
  const admin = under(path, '/admin') || (route !== undefined && under(route, '/admin'))
  const auth = under(path, AUTH_BASE_PATH) || (route !== undefined && under(route, AUTH_BASE_PATH))
  if (admin) return path !== LOGIN_PATH && path !== '/admin/logout'
  if (auth) return !under(path, `${AUTH_BASE_PATH}/sign-in`) && path !== `${AUTH_BASE_PATH}/sign-out`
  return false
}

/** For a read-only site: the admin's and `/api/auth`'s write requests answer 403, except logging in and out. */
function refuseWrites(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return
    // As better-auth reads it: `.`, `..` and `%2e` segments resolved.
    let path: string
    try {
      path = new URL(splitUrl(request.url).path, 'http://inlay.invalid').pathname
    } catch {
      path = splitUrl(request.url).path
    }
    if (!isWrite(path, request.routeOptions.url)) return
    return reply
      .code(403)
      .header('cache-control', 'no-store')
      .type(HTML)
      .send(catalogPage('preview.readOnly.title', 'error.previewReadOnly'))
  })
}

/** For a forced preview: nothing it answers may be kept by a browser or a shared cache, nor revalidated later. */
function neverStore(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store').removeHeader('etag').removeHeader('last-modified').removeHeader('expires')
    return payload
  })
}

const plugin: FastifyPluginAsync<InlayOptions> = async (app, opts) => {
  const registry = buildRegistry(opts.site)
  const baseUrl = checkOptions(opts, registry)
  const { admin, publicPaths } = registry.site
  const theme = resolveTheme(admin.theme)
  const assets = await loadAdminAssets()
  if (typeof admin.theme === 'object') {
    for (const { pair, ratio } of themeContrastProblems(admin.theme.colors, admin.theme.base)) {
      app.log.warn(t('log.adminContrast', { first: pair[0], second: pair[1], ratio: ratio.toFixed(2) }))
    }
  }
  const next = (dir: string) => join(dirname(opts.db), dir)
  const { secret } = opts
  const booted = await bootInlay({
    site: opts.site,
    db: opts.db,
    backups: opts.backups ?? next('backups'),
    media: opts.media ?? next('media'),
    ...(opts.uploads && { uploads: opts.uploads }),
    ...(opts.now && { now: opts.now }),
    ...(opts.content && { content: opts.content }),
    ...(opts.shippedFiles && { shippedFiles: opts.shippedFiles }),
    auth: { secret, baseUrl, ...(opts.rateLimit !== undefined && { rateLimit: opts.rateLimit }) },
  })
  const { db, report, auth } = booted
  // A release's preview runs its migration functions on its copy, as activation would, before it turns read-only.
  if (opts.readOnly && opts.release && opts.site.migrations.length > 0) {
    let running: string | null = null
    const tracked = opts.site.migrations.map((m) => ({
      name: m.name,
      run: async (ctx: Parameters<typeof m.run>[0]) => {
        running = m.name
        await m.run(ctx)
        running = null
      },
    }))
    try {
      await booted.core.runReleaseMigrations(opts.release.id, tracked)
    } catch (e) {
      await db.destroy()
      if (running === null || e instanceof InlayError) throw e
      throw new InlayError('release', 'error.releaseMigration', { name: running, problem: e instanceof Error ? e.message : String(e) })
    }
  }
  const core = opts.readOnly ? readOnlyCore(booted.core) : booted.core
  for (const warning of report.warnings) app.log.warn('document' in warning ? { document: warning.document } : { redirect: warning.redirect }, warning.message)
  for (const warning of report.shipped.warnings ?? []) app.log.warn(warning.message)
  const now = opts.now ?? (() => new Date())
  registerSiteHeaders(app, siteHeaders(baseUrl, registry.site.headers))
  const lockOptions = { db, service: auth, secret, baseUrl, now, publicPaths }
  registerSiteLockGate(app, { ...lockOptions, ...(opts.preview === 'forced' && opts.release && { release: opts.release.id }) })
  registerUnlockRoute(app, { ...lockOptions, rateLimit: opts.rateLimit !== false })
  let schedule: BackupSchedule | undefined
  if (opts.backupSchedule !== false) {
    const keep = opts.backupSchedule?.keep ?? DEFAULT_KEEP
    app.addHook('onReady', async () => {
      schedule = startBackupSchedule(
        async () => {
          const made = await core.scheduledBackup(keep)
          if (made) app.log.info({ backup: made.path }, t(made.reason === 'scheduled' ? 'log.scheduledBackup' : 'log.publishBackup'))
        },
        { intervalMs: SCHEDULE_INTERVAL_MS, onError: (err) => app.log.error({ err }, t('log.scheduledBackupFailed')) },
      )
    })
  }
  app.addHook('onClose', async () => {
    await schedule?.stop()
    await db.destroy()
  })

  const siteAssets = publicAssets(opts.publicDir ?? null)
  const cache = opts.cache === false ? undefined : new PageCache(opts.cache?.maxEntries ?? 500)
  if (cache) {
    const stop = core.onLiveChange(() => cache.clear())
    app.addHook('onClose', async () => stop())
  }

  if (baseUrl.startsWith('https:') && !app.initialConfig.https) warnWithoutTrustProxy(app, baseUrl)

  app.decorate('inlay', createApi(core, cache, auth, { baseUrl, secret, now, host: opts.host ?? null, assets: siteAssets }))
  registerAuthHandler(app, { service: auth, baseUrl })
  if (opts.readOnly) refuseWrites(app)
  if (opts.preview === 'forced') neverStore(app)
  const uploads = {
    maxBytes: opts.uploads?.maxBytes ?? DEFAULT_MAX_BYTES,
    types: opts.uploads?.types ?? DEFAULT_UPLOAD_TYPES,
  }
  registerAdminRoutes(app, {
    service: auth,
    core,
    baseUrl,
    secret,
    now,
    uploads,
    branding: { name: admin.name ?? t('admin.title'), ...(admin.logo !== undefined && { logo: admin.logo }), theme },
    assets,
    db,
    release: opts.release ?? null,
    ...(opts.readOnly && { readOnly: true }),
    ...(opts.releasesDir !== undefined && { releasesDir: opts.releasesDir }),
    ...(opts.trustedKeys && { trustedKeys: opts.trustedKeys }),
    ...(opts.adminHost && { host: opts.adminHost }),
  })
  const mcp = createInlayMcpHandler({
    core,
    baseUrl,
    secret,
    now,
    fetchFile: (url, o) => fetchRemoteFile(url, o),
    uploads: { maxBytes: uploads.maxBytes },
    log: (err) => app.log.error({ err }, t('log.mcpFailed')),
    release: opts.release ?? null,
  })
  app.addHook('onClose', async () => mcp.close())
  registerMcpRoute(app, {
    service: auth,
    baseUrl,
    handle: async (request, reply, authInfo) => {
      const body = request.body === undefined ? undefined : JSON.stringify(request.body)
      const res = await mcp.fetch(toWebRequest(request, baseUrl, { ...(body !== undefined && { body }) }), { authInfo })
      return sendWebResponse(reply, res)
    },
  })
  registerMediaRoutes(app, core)
  if (opts.publicDir !== undefined) registerPublicRoutes(app, { dir: opts.publicDir, maxAge: opts.publicMaxAge ?? 3600 })
  registerReleaseRoutes(app, { core, registry, baseUrl, assets: siteAssets, secrets: opts.secrets ?? {}, fetch: opts.fetch ?? ((input, init) => globalThis.fetch(input, init)), log: app.log, preview: opts.preview === 'forced' })
  registerPreviewRoutes(app, { secret, baseUrl, now })
  registerSiteRoutes(app, core, cache, {
    baseUrl,
    secret,
    now,
    assets: siteAssets,
    ...(opts.cdn && { cdn: opts.cdn }),
    ...(opts.noSite && { noSite: opts.noSite }),
    ...(opts.preview && { preview: opts.preview }),
    // Only a staged release's preview names its release in the banner; the live site's preview links to publishing.
    ...(opts.preview === 'forced' && opts.release && { release: opts.release.name }),
  })
}

/** The Fastify plugin: boots the content core and serves the public site. */
export const inlay = fp(plugin, { name: 'inlaycms', fastify: '5.x' })
