import type { FastifyInstance } from 'fastify'

/**
 * What every response gets unless it sets the header itself: no MIME sniffing, no full URLs leaked to other sites,
 * and no framing by other sites. A site can't be given a whole CSP without knowing its templates, so the default
 * one only says who may frame it.
 */
const DEFAULTS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "frame-ancestors 'self'",
}

/** One year, without `includeSubDomains`, so other hosts under the same domain are left alone. */
const HSTS = 'max-age=31536000'

/** The headers for a site at `baseUrl`: the defaults (HSTS only over https) with the site's own laid over them. */
export function siteHeaders(baseUrl: string, own: Readonly<Record<string, string | false>>): Record<string, string> {
  const headers: Record<string, string | false> = { ...DEFAULTS }
  if (baseUrl.startsWith('https:')) headers['strict-transport-security'] = HSTS
  for (const [name, value] of Object.entries(own)) headers[name.toLowerCase()] = value
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== false))
}

/** Adds `headers` to every response that doesn't set them itself, so the admin's and a route's own headers win. */
export function registerSiteHeaders(app: FastifyInstance, headers: Readonly<Record<string, string>>): void {
  const entries = Object.entries(headers)
  app.addHook('onSend', async (_request, reply, payload) => {
    for (const [name, value] of entries) if (!reply.hasHeader(name)) reply.header(name, value)
    return payload
  })
}
