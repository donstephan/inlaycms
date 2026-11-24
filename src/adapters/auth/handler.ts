import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AUTH_BASE_PATH } from '../../core/auth/auth.js'
import type { AuthService } from '../../core/auth/service.js'
import { sendWebResponse, toWebRequest } from '../web.js'

/** The root `.well-known` URLs OAuth clients look up; better-auth answers them before checking its base path. */
const WELL_KNOWN = [
  '/.well-known/oauth-authorization-server/*',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/*',
]

/**
 * Metadata at the bare root, for clients that don't insert the issuer's path. better-auth only serves it under the
 * issuer (`/api/auth`), so these are forwarded there.
 */
const ISSUER_METADATA = ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']

const AUTHORIZE_PATH = `${AUTH_BASE_PATH}/oauth2/authorize`

/**
 * `params` with `prompt=consent` added (and `none` dropped). better-auth remembers consent per client and user, not
 * per redirect URI, so without this a client that registered a second host would get a code there silently. With
 * it, every authorize request that reaches a logged-in user shows the consent page (plan decision 7).
 */
function withConsentPrompt(params: URLSearchParams): URLSearchParams {
  const prompts = new Set(
    params
      .getAll('prompt')
      .flatMap((p) => p.split(' '))
      .filter((p) => p !== '' && p !== 'none'),
  )
  prompts.add('consent')
  const next = new URLSearchParams(params)
  next.set('prompt', [...prompts].join(' '))
  return next
}

/**
 * Endpoints better-auth's plugins add that no browser may reach.
 *
 * - The two-step login plugin's: the admin calls them through `auth.handler` itself; from a browser they would open
 *   backup codes, emailed codes and enabling or disabling without the admin's forms.
 * - The admin plugin's: Inlay manages users through `AuthService`, and these would let an owner's session act as
 *   another user or change their account (two-step login included) behind the Users screen's rules.
 */
const CLOSED_PREFIXES = [`${AUTH_BASE_PATH}/two-factor/`, `${AUTH_BASE_PATH}/admin/`]

/** `url`'s path as better-auth will see it: the URL parser resolves `.`, `..` and `%2e` segments. */
function resolvedPath(url: string): string {
  const q = url.indexOf('?')
  return new URL(q === -1 ? url : url.slice(0, q), 'http://inlay.invalid').pathname
}

/** Whether `url` reaches one of the closed endpoints (empty segments collapsed, to be safe). */
function closed(url: string): boolean {
  const path = resolvedPath(url).replace(/\/{2,}/g, '/')
  return CLOSED_PREFIXES.some((prefix) => path.startsWith(prefix))
}

/** An authorize request's URL and form body with consent forced; any other request unchanged. */
function forceConsent(url: string, body: Buffer | undefined): { url: string; body: Buffer | undefined } {
  const q = url.indexOf('?')
  const path = resolvedPath(url)
  if (path !== AUTHORIZE_PATH) return { url, body }
  const query = withConsentPrompt(new URLSearchParams(q === -1 ? '' : url.slice(q + 1)))
  const form = body && body.length > 0 ? Buffer.from(withConsentPrompt(new URLSearchParams(body.toString('utf8'))).toString()) : body
  return { url: `${path}?${query.toString()}`, body: form }
}

/**
 * Mounts better-auth: `/api/auth/*` and the `.well-known` URLs are forwarded to `auth.handler` with their raw body
 * and original content type. They live in their own encapsulated plugin, whose only body parser keeps the bytes.
 */
export function registerAuthHandler(app: FastifyInstance, opts: { service: AuthService; baseUrl: string }): void {
  const { service, baseUrl } = opts

  async function forward(request: FastifyRequest, reply: FastifyReply, path?: string): Promise<FastifyReply> {
    if (closed(path ?? request.url)) return reply.code(404).send()
    const forced = forceConsent(path ?? request.url, Buffer.isBuffer(request.body) ? request.body : undefined)
    const body = forced.body
    const res = await service.auth.handler(toWebRequest(request, baseUrl, { ...(body && { body }), path: forced.url }))
    return sendWebResponse(reply, res)
  }

  app.register(async (child) => {
    child.removeAllContentTypeParsers()
    child.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))
    child.route({ method: ['GET', 'POST'], url: `${AUTH_BASE_PATH}/*`, handler: (request, reply) => forward(request, reply) })
    for (const url of WELL_KNOWN) child.get(url, (request, reply) => forward(request, reply))
    for (const url of ISSUER_METADATA) {
      child.get(url, (request, reply) => forward(request, reply, `${AUTH_BASE_PATH}${request.url}`))
    }
  })
}
