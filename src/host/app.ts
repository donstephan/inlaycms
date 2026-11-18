import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { AUTH, inlay, type HostApi } from '../adapters/site/plugin.js'
import type { LoadedConfig } from '../config.js'
import { catalogPage } from '../adapters/site/render.js'
import type { Core } from '../core/core.js'
import { openDatabase } from '../core/db/connection.js'
import type { Database } from '../core/db/schema.js'
import { InlayError } from '../core/errors.js'
import { t } from '../core/messages/index.js'
import { defineSite, type SiteDefinition } from '../core/registry/define.js'
import type { HostConfig } from './config.js'
import { PREVIEW_RELEASE_HEADER, registerPreviewProxy } from './preview-proxy.js'
import { adminHostHooks } from './hooks.js'
import { registerPushRoutes, type ContentDiff, type PushOptions } from './push.js'
import { getRelease } from './store.js'

/** The site a host serves before it has a release: one locale, no types, only the admin. */
export const EMPTY_SITE: SiteDefinition = defineSite({
  locales: ['en'],
  defaultLocale: 'en',
  admin: { name: t('admin.title') },
})

/** What a site app serves: a loaded release, or a site `inlaycms dev` built from source. */
export interface SiteSource {
  site: SiteDefinition
  publicDir: string | null
  /** Each shipped file's source as the site names it, to the file to read. */
  shippedFiles?: ReadonlyMap<string, string>
  /** As `shippedFiles`, only the images `.md` files the site imports name. */
  markdownFiles?: ReadonlyMap<string, string>
}

/** The source of a site run from its code (`inlaycms dev` and `inlaycms/testing`): its `public/` folder, if it has one. */
export function sourceFromConfig(loaded: LoadedConfig): SiteSource {
  const publicDir = join(loaded.dir, 'public')
  return { site: loaded.config.site, publicDir: existsSync(publicDir) ? publicDir : null }
}

/**
 * The Fastify app for one site on the host, ready but not listening. With no `source` it serves the admin and, for
 * every content page, the `noSite` page: "no site yet" (`'empty'`, the default) for a host that has no release, or
 * "temporarily unavailable" (`'unavailable'`, status 503) for a site that is down. `host` is what the site may ask
 * of `inlaycms serve`; with it the app also serves the push API (`/_inlay/releases`, see `registerPushRoutes`) and
 * sends requests whose preview cookie names a staged release to that release's preview (`registerPreviewProxy`).
 *
 * A staged release's preview passes `readOnly`, `preview: 'forced'`, `release`, `backupSchedule: false` and `diff`:
 * it then refuses a request the proxy forwarded for another release (421), and serves `GET /_inlay/internal/diff`
 * (what `diff` gives) to requests that didn't come through the proxy.
 */
export async function createSiteApp(
  config: HostConfig,
  source: SiteSource | null,
  opts: {
    content: 'apply' | 'none'
    logger?: boolean
    now?: () => Date
    noSite?: 'empty' | 'unavailable'
    host?: HostApi
    readOnly?: boolean
    preview?: 'forced'
    release?: { id: string; name: string }
    backupSchedule?: false
    diff?: (core: Core) => Promise<ContentDiff>
    /** The largest release file a push may send (`PUSH_MAX_BYTES` by default); for tests. */
    pushMaxBytes?: number
    /** What routes get as `ctx.fetch`; the global `fetch` by default. */
    fetch?: typeof fetch
  },
): Promise<{ app: FastifyInstance; core: Core }> {
  // No plugin timeout: the site plugin boots the site (migrations, shipped content), which takes as long as it takes.
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: config.trustProxy, pluginTimeout: 0 })
  const now = opts.now ?? (() => new Date())
  // Opened once the site has booted (which creates and migrates the database), for the push API, admin and proxy.
  let db: Kysely<Database> | null = null
  try {
    if (opts.host?.startPreview) {
      // Before the site's own hooks (the site lock among them): the preview answers for the release it shows.
      registerPreviewProxy(app, {
        host: opts.host,
        secret: config.secret,
        baseUrl: config.baseUrl,
        now,
        isStaged: async (id) => db !== null && (await getRelease(db, id))?.state === 'staged',
      })
    }
    const release = opts.release
    if (opts.preview === 'forced' && release) {
      app.addHook('onRequest', async (request, reply) => {
        const forwarded = request.headers[PREVIEW_RELEASE_HEADER]
        if (forwarded === undefined || forwarded === release.id) return
        return reply
          .code(421)
          .header('cache-control', 'no-store')
          .type('text/html; charset=utf-8')
          .send(catalogPage('preview.misdirected.title', 'preview.misdirected'))
      })
    }
    // What the push API and the admin's Releases screen work with; read only once the site has booted.
    const push: (PushOptions & { host: HostApi }) | null = opts.host
      ? {
          get db() {
            if (db === null) throw new InlayError('invalid_operation', 'error.hostNotReady')
            return db
          },
          get registry() {
            return source === null ? null : app.inlay.core.registry
          },
          config,
          now,
          host: opts.host,
          log: (e) => app.log.warn({ err: e }, 'content diff'),
        }
      : null
    await app.register(inlay, {
      site: source?.site ?? EMPTY_SITE,
      ...(source === null && { noSite: opts.noSite ?? 'empty' }),
      db: config.paths.db,
      media: config.paths.media,
      backups: config.paths.backups,
      secret: config.secret,
      baseUrl: config.baseUrl,
      ...(config.uploads && { uploads: config.uploads }),
      rateLimit: config.rateLimit,
      backupSchedule: opts.backupSchedule ?? { keep: config.backupKeep },
      cdn: config.cdn,
      publicMaxAge: config.publicMaxAge,
      ...(source?.publicDir != null && { publicDir: source.publicDir }),
      secrets: config.secrets(source?.site.secrets ?? []),
      ...(opts.fetch && { fetch: opts.fetch }),
      content: opts.content,
      ...(source?.shippedFiles && { shippedFiles: source.shippedFiles }),
      ...(source?.markdownFiles && { markdownFiles: source.markdownFiles }),
      ...(opts.now && { now: opts.now }),
      ...(opts.host && { host: opts.host }),
      ...(opts.readOnly && { readOnly: true }),
      ...(opts.preview && { preview: opts.preview }),
      ...(opts.release && { release: opts.release }),
      releasesDir: config.paths.releases,
      trustedKeys: config.trustedKeys,
      ...(push && { adminHost: adminHostHooks(push) }),
    })
    if (push) {
      // Its own connection, so a push never waits behind the site's queries.
      const own = openDatabase(config.paths.db)
      db = own
      app.addHook('onClose', async () => own.destroy())
      registerPushRoutes(app, {
        ...push,
        db: own,
        service: app.inlay[AUTH],
        ...(opts.pushMaxBytes !== undefined && { maxBytes: opts.pushMaxBytes }),
      })
    }
    const { diff } = opts
    if (opts.preview === 'forced' && diff) {
      app.get('/_inlay/internal/diff', async (request, reply) => {
        // Only on the preview's own socket: not for a visitor's request the proxy forwarded.
        if (request.headers[PREVIEW_RELEASE_HEADER] !== undefined) return reply.callNotFound()
        return reply.header('cache-control', 'no-store').send(await diff(app.inlay.core))
      })
    }
    await app.ready()
  } catch (e) {
    await app.close()
    throw e
  }
  return { app, core: app.inlay.core }
}
