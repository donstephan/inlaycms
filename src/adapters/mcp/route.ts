import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { MCP_PATH } from '../../core/auth/auth.js'
import type { AuthService } from '../../core/auth/service.js'
import { t, type MessageId } from '../../core/messages/index.js'
import type { Actor } from '../../core/types.js'

/** Who is calling `/mcp`, in the shape MCP's `AuthInfo` takes. */
export interface AuthInfo {
  token: string
  /** The OAuth client the token was issued to, or `'api-key'`. */
  clientId: string
  scopes: string[]
  /** Seconds since the epoch; absent for API keys. */
  expiresAt?: number
  extra: { actor: Actor }
}

export type McpHandle = (request: FastifyRequest, reply: FastifyReply, authInfo: AuthInfo) => Promise<FastifyReply>

export interface McpRouteOptions {
  service: AuthService
  baseUrl: string
  handle: McpHandle
}

/** The JSON-RPC error code MCP servers use for a request that isn't authenticated. */
const UNAUTHORIZED = -32001

const BEARER = /^Bearer\s+(\S+)\s*$/i

const header = (request: FastifyRequest, name: string): string | undefined => {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/**
 * The caller of an `/mcp` request: an OAuth access token (`Authorization: Bearer`) first, then an `x-api-key`.
 * Both are checked against the user's current row, so access that ended stops working at once.
 */
export async function authenticateMcp(
  request: FastifyRequest,
  service: AuthService,
): Promise<{ actor: Actor; authInfo: AuthInfo } | null> {
  const token = BEARER.exec(header(request, 'authorization') ?? '')?.[1]
  if (token !== undefined) {
    const bearer = await service.bearerActor(token)
    if (bearer) {
      const { actor, clientId, scopes, expiresAt } = bearer
      return { actor, authInfo: { token, clientId, scopes, expiresAt, extra: { actor } } }
    }
  }
  const key = header(request, 'x-api-key')
  if (key !== undefined && key !== '') {
    const found = await service.apiKeyActor(key)
    // A push token is for the push API only: one that leaks from CI must not read or change content.
    if (found?.permissions.release.includes('push')) return null
    if (found) return { actor: found.actor, authInfo: { token: key, clientId: 'api-key', scopes: [], extra: { actor: found.actor } } }
  }
  return null
}

const rpcError = (messageId: MessageId) => ({ jsonrpc: '2.0', error: { code: UNAUTHORIZED, message: t(messageId) }, id: null })

/**
 * `/mcp` (POST, GET and DELETE) behind the authentication gate: a foreign `Origin` gets a 403, a request without
 * valid credentials a 401 whose `WWW-Authenticate` points MCP clients at the protected-resource metadata.
 */
export function registerMcpRoute(app: FastifyInstance, opts: McpRouteOptions): void {
  const { service, baseUrl, handle } = opts
  const challenge = `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource${MCP_PATH}"`

  app.route({
    method: ['POST', 'GET', 'DELETE'],
    url: MCP_PATH,
    handler: async (request, reply) => {
      const origin = request.headers.origin
      if (origin !== undefined && origin !== baseUrl) return reply.code(403).send(rpcError('mcp.badOrigin'))
      const authed = await authenticateMcp(request, service)
      if (!authed) return reply.code(401).header('www-authenticate', challenge).send(rpcError('mcp.unauthorized'))
      return handle(request, reply, authed.authInfo)
    },
  })
}
