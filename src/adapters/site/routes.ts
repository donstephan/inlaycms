import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { normalizeContent } from '../../core/content/schema.js'
import { readData } from '../../core/content/reader.js'
import type { Core } from '../../core/core.js'
import { t, type MessageId } from '../../core/messages/index.js'
import type { TemplateDef } from '../../core/registry/define.js'
import type { Registry } from '../../core/registry/registry.js'
import type { RouteContext, RouteDef, RouteRequest, RouteResponse } from '../../core/registry/route.js'
import { encodePath } from '../../core/site/paths.js'
import { publicAssets, type PublicAssets } from './assets.js'
import { queryApi } from './context.js'
import { catalogPage, renderTemplateData } from './render.js'

const BODY_LIMIT = 1024 * 1024
const HTML = 'text/html; charset=utf-8'
/** Headers a route never sees: routes run anonymous. */
const HIDDEN_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization', 'x-api-key'])

export interface ReleaseRouteOptions {
  core: Core
  registry: Registry
  baseUrl: string
  assets?: PublicAssets
  /** The site is a staged release's forced preview: its renders stay noindex, with no canonical. */
  preview?: boolean
  /** Host-supplied secret values; a route sees only the ones its site declares. */
  secrets: Readonly<Record<string, string>>
  log: FastifyBaseLogger
}

const ERROR_PAGES = {
  400: ['site.badRequest.title', 'site.badRequest'],
  413: ['site.tooLarge.title', 'site.tooLarge'],
  415: ['site.unsupported.title', 'site.unsupported'],
  500: ['site.error.title', 'site.error'],
} as const satisfies Record<number, [MessageId, MessageId]>

/** 413 and 415 as Fastify gave them, 400 for any other request it refused (`FST_*` with a 4xx status), else 500. */
function errorStatus(error: unknown): keyof typeof ERROR_PAGES {
  const { code, statusCode } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; statusCode?: unknown }
  if (typeof code !== 'string' || !code.startsWith('FST_') || typeof statusCode !== 'number') return 500
  if (statusCode === 413 || statusCode === 415) return statusCode
  return statusCode >= 400 && statusCode < 500 ? 400 : 500
}

function plainHeaders(raw: FastifyRequest['headers']): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    const key = name.toLowerCase()
    if (value === undefined || HIDDEN_HEADERS.has(key)) continue
    out[key] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

function plainQuery(url: string): Record<string, string> {
  const q = url.indexOf('?')
  return q === -1 ? {} : Object.fromEntries(new URLSearchParams(url.slice(q + 1)))
}

/** A registry whose every type is `template`, so content reading works for a template no type uses. */
function templateRegistry(registry: Registry, template: TemplateDef): Registry {
  return { ...registry, getType: () => ({ kind: 'global', name: template.name, label: template.name, template }) }
}

function send(reply: FastifyReply, res: RouteResponse): FastifyReply {
  const headers = res.headers ?? {}
  const typed = Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')
  const json = res.json !== undefined
  const body = json ? JSON.stringify(res.json) : res.body
  reply.headers(headers).code(res.status ?? (body === undefined ? 204 : 200))
  if (body === undefined) return reply.send()
  if (!typed) reply.type(json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8')
  return reply.send(body)
}

/**
 * Serves the site's routes in one encapsulated scope that reads only urlencoded forms and JSON (1 MB each). Any other
 * body is a 415, a body Fastify can't read a 400 or 413, and a handler throw a logged 500, each as a plain Inlay page.
 * The site lock still applies: its gate runs before these routes.
 */
export function registerReleaseRoutes(app: FastifyInstance, opts: ReleaseRouteOptions): void {
  const { core, registry, baseUrl, log } = opts
  const assets = opts.assets ?? publicAssets(null)
  const routes = registry.site.routes
  if (routes.length === 0) return
  const secrets: Record<string, string> = {}
  for (const name of registry.site.secrets) {
    const value = opts.secrets[name]
    if (value !== undefined) secrets[name] = value
  }
  Object.freeze(secrets)

  const localeOf = (value: unknown) =>
    typeof value === 'string' && registry.locales.includes(value) ? value : undefined

  app.register(async (scope) => {
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: BODY_LIMIT },
      scope.getDefaultJsonParser('error', 'error'),
    )
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: BODY_LIMIT },
      (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    )
    scope.setErrorHandler(async (error, request, reply) => {
      const status = errorStatus(error)
      const params = { method: request.method, path: request.url.split('?')[0] ?? request.url }
      if (status === 500) log.error({ err: error }, t('log.routeFailed', params))
      const [title, body] = ERROR_PAGES[status]
      return reply.code(status).type(HTML).send(catalogPage(title, body))
    })

    for (const route of routes) register(scope, route)
  })

  function register(scope: FastifyInstance, route: RouteDef): void {
    scope.route({
      method: route.method,
      url: route.path,
      handler: async (request, reply) => {
        const query = plainQuery(request.url)
        const type = request.headers['content-type'] ?? ''
        const form = /^application\/x-www-form-urlencoded\b/i.test(type)
        const body = route.method === 'POST' && request.body !== undefined ? request.body : null
        const fields = form && body !== null ? (body as Record<string, string>) : undefined
        const locale = localeOf(query.locale) ?? localeOf(fields?.locale) ?? registry.defaultLocale
        const req: RouteRequest = {
          method: route.method,
          path: route.path,
          query,
          headers: plainHeaders(request.headers),
          body,
          locale,
        }
        const ctx: RouteContext = {
          query: queryApi(core, { locale, baseUrl, assets }),
          async render(template, data = {}, o = {}) {
            const read = templateRegistry(registry, template)
            const doc = readData(read, template.name, normalizeContent(read, template.name, data), { fill: true }).data
            const canonical = route.sitemap === true && request.url.split('?')[0] === encodePath(route.path) ? route.path : null
            const html = await renderTemplateData(core, template, doc, { locale, path: route.path, baseUrl, canonical, assets, preview: opts.preview === true })
            return { status: o.status ?? 200, headers: { 'content-type': HTML }, body: html }
          },
          fetch: (input, init) => globalThis.fetch(input, init),
          secrets,
          redirect: (location, status = 303) => ({ status, headers: { location } }),
          baseUrl,
          asset: (path) => assets.url(path),
          locale,
        }
        return send(reply, await route.handler(req, ctx))
      },
    })
  }
}
