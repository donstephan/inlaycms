import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AuthService } from '../../core/auth/service.js'
import type { Actor } from '../../core/types.js'
import { safeNext, webHeaders } from '../web.js'

export const LOGIN_PATH = '/admin/login'

/** The signed-in user of the request's session cookie, when they may still use Inlay. */
export function requestActor(request: FastifyRequest, service: AuthService): Promise<Actor | null> {
  return service.sessionActor(webHeaders(request))
}

/** `requestActor`, or `null` after redirecting to the login page, which comes back to this URL. */
export async function requireActor(
  request: FastifyRequest,
  reply: FastifyReply,
  service: AuthService,
): Promise<Actor | null> {
  const actor = await requestActor(request, service)
  if (actor) return actor
  reply.redirect(`${LOGIN_PATH}?${new URLSearchParams({ next: safeNext(request.url) }).toString()}`, 302)
  return null
}
