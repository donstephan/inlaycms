import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { HostApi } from '../adapters/site/plugin.js'
import { clearPreviewCookie, readPreview } from '../adapters/site/preview.js'
import { catalogPage } from '../adapters/site/render.js'
import { t } from '../core/messages/index.js'
import { PREVIEW_IDLE_MS } from './ipc.js'

/** Names the release a request was forwarded for, so the preview can tell it was meant for it. */
export const PREVIEW_RELEASE_HEADER = 'x-inlay-preview-release'

/** How often, at most, a preview in use is reported to the primary so it isn't stopped as idle. */
export const PREVIEW_TOUCH_MS = 60_000

/**
 * Paths the current site always answers itself, with everything under them: turning preview on and off, the push
 * API and the other `/_inlay` routes, the admin, logging in, MCP and the `.well-known` URLs. A preview only shows the
 * release's pages.
 */
const LOCAL_PREFIXES = ['/_inlay', '/admin', '/api/auth', '/mcp', '/.well-known']

function isLocal(path: string): boolean {
  return LOCAL_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

const problemOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Connection headers, which apply to one hop only. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'])

/**
 * The preview's caching headers, never passed on: its answers come under the live site's URLs, so none may be kept
 * by a browser or a shared cache, nor revalidated later.
 */
const CACHING = new Set(['cache-control', 'etag', 'last-modified', 'expires', 'vary'])

export interface PreviewProxyOptions {
  host: HostApi
  secret: string
  baseUrl: string
  now: () => Date
  /** Whether the release is still staged; one that isn't (deleted, or made live since) isn't previewed. */
  isStaged: (releaseId: string) => Promise<boolean>
}

/** How a forwarded request went: answered, or failed before any answer (`unreachable` when nothing listens on the socket). */
type Outcome = 'done' | 'unreachable' | 'failed'

/** Sends the request to the preview listening on `socketPath` and its answer back, as it comes. */
function forward(request: FastifyRequest, reply: FastifyReply, socketPath: string, releaseId: string): Promise<Outcome> {
  return new Promise((resolve) => {
    const headers: OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(request.raw.headers)) {
      if (value !== undefined && name !== 'host' && name !== PREVIEW_RELEASE_HEADER && !HOP_BY_HOP.has(name)) headers[name] = value
    }
    headers[PREVIEW_RELEASE_HEADER] = releaseId
    const out = reply.raw
    const upstream = httpRequest({ socketPath, method: request.raw.method, path: request.raw.url, headers })
    upstream.on('response', (res: IncomingMessage) => {
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        const name = res.rawHeaders[i]!
        const lower = name.toLowerCase()
        if (HOP_BY_HOP.has(lower) || CACHING.has(lower)) continue
        const value = res.rawHeaders[i + 1]!
        const had = out.getHeader(name)
        out.setHeader(name, had === undefined ? value : [...(Array.isArray(had) ? had : [String(had)]), value])
      }
      out.setHeader('cache-control', 'no-store')
      out.setHeader('vary', 'Cookie')
      out.writeHead(res.statusCode ?? 502)
      res.pipe(out)
      res.on('end', () => resolve('done'))
      res.on('error', () => {
        out.destroy()
        resolve('done')
      })
    })
    upstream.on('error', (e: NodeJS.ErrnoException) => {
      if (out.headersSent) {
        out.destroy()
        return resolve('done')
      }
      resolve(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'unreachable' : 'failed')
    })
    // A visitor who leaves stops the forwarded request too.
    out.on('close', () => {
      if (!out.writableFinished) upstream.destroy()
    })
    request.raw.pipe(upstream)
  })
}

/**
 * Sends every request whose preview cookie names a staged release to that release's preview worker, over its Unix
 * socket (spec §7, §8.4), from an `onRequest` hook of the current site: the request as it came (minus `Host`, plus
 * `x-inlay-preview-release`), the answer as it comes back with `Cache-Control: no-store` and `Vary: Cookie` in place
 * of the preview's caching headers. The host starts the preview on the first request and is
 * told it is still in use at most once a minute. A cookie naming a release that isn't staged any more, or whose
 * preview can't start, is cleared and the live site answers; a preview that doesn't answer gives a plain 502 page.
 * `/_inlay`, the admin, `/api/auth`, `/mcp` and `/.well-known` are always answered here.
 */
export function registerPreviewProxy(app: FastifyInstance, opts: PreviewProxyOptions): void {
  const { host } = opts
  /** The socket of each release's preview, and when it was last asked for or reported in use. */
  const previews = new Map<string, { socket: Promise<string>; touched: number }>()

  const socketOf = (releaseId: string, fresh: boolean): Promise<string> => {
    const at = opts.now().getTime()
    const known = previews.get(releaseId)
    // A preview unused for half the idle time may have been stopped: ask again (which also counts as use).
    if (known && !fresh && at - known.touched < PREVIEW_IDLE_MS / 2) {
      if (at - known.touched >= PREVIEW_TOUCH_MS) {
        known.touched = at
        host.touchPreview?.(releaseId)
      }
      return known.socket
    }
    const socket = host.startPreview!(releaseId)
    const entry = { socket, touched: at }
    previews.set(releaseId, entry)
    socket.catch(() => {
      if (previews.get(releaseId) === entry) previews.delete(releaseId)
    })
    return socket
  }

  const failed = (reply: FastifyReply) => {
    const out = reply.raw
    out.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', vary: 'Cookie', 'x-robots-tag': 'noindex' })
    out.end(catalogPage('preview.failed.title', 'preview.failed'))
  }

  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.cookie === undefined) return
    const path = request.url.split('?')[0] ?? request.url
    // The matched route as well: Fastify answers `/%61dmin/x` with the `/admin/x` route.
    if (isLocal(path) || (request.routeOptions.url !== undefined && isLocal(request.routeOptions.url))) return
    const { release } = readPreview(request, opts.secret, opts.now())
    if (release === null) return

    if (!(await opts.isStaged(release))) {
      if (previews.delete(release)) void host.stopPreview?.(release).catch(() => {})
      clearPreviewCookie(reply, opts.baseUrl)
      return
    }
    let socket: string
    try {
      socket = await socketOf(release, false)
    } catch (e) {
      request.log.warn({ err: e }, t('host.previewFailed', { id: release, problem: problemOf(e) }))
      clearPreviewCookie(reply, opts.baseUrl)
      return
    }

    reply.hijack()
    let outcome = await forward(request, reply, socket, release)
    // A preview stopped meanwhile: start it again, for a request without a body that can be sent again.
    if (outcome === 'unreachable' && (request.method === 'GET' || request.method === 'HEAD')) {
      previews.delete(release)
      try {
        outcome = await forward(request, reply, await socketOf(release, true), release)
      } catch (e) {
        request.log.warn({ err: e }, t('host.previewFailed', { id: release, problem: problemOf(e) }))
        outcome = 'failed'
      }
    }
    if (outcome !== 'done') {
      previews.delete(release)
      failed(reply)
    }
  })
}
