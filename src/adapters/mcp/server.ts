import { createMcpHandler, McpServer, type AuthInfo, type McpHttpHandler } from '@modelcontextprotocol/server'
import type { Core } from '../../core/core.js'
import { InlayError } from '../../core/errors.js'
import { t } from '../../core/messages/index.js'
import type { Actor, Ctx } from '../../core/types.js'
import { inlayVersion } from '../../core/version.js'
import { createNonceStore, requestStateCodec, type NonceStore } from './request-state.js'
import type { ErrorLog } from './results.js'
import * as history from './tools/history.js'
import * as media from './tools/media.js'
import * as publish from './tools/publish.js'
import * as read from './tools/read.js'
import * as redirects from './tools/redirects.js'
import * as write from './tools/write.js'

/** Downloads a file for `upload_media_from_url`, refusing anything over `maxBytes`. */
export type FetchFile = (url: string, opts: { maxBytes: number }) => Promise<{ data: Uint8Array; filename: string }>

export interface McpDeps {
  core: Core
  /** The site's origin, such as `https://example.com`. */
  baseUrl: string
  /** Signs preview links and request state. */
  secret: string
  now: () => Date
  fetchFile: FetchFile
  uploads: { maxBytes: number }
  /** Where unexpected tool failures are reported. */
  log: ErrorLog
  /** The request-state nonces already acted on, so a publish confirmation can't be replayed. */
  confirmations: NonceStore
  /** The stored release this site runs; `null` or absent when it isn't one (such as under `inlaycms dev`). */
  release?: { id: string; name: string } | null
}

/** What `createInlayMcpHandler` needs; it makes its own nonce store when none is given. */
export type McpHandlerOptions = Omit<McpDeps, 'confirmations'> & Partial<Pick<McpDeps, 'confirmations'>>

/** What each tool module exports: registers its tools on `server`, acting as `ctx.actor`. */
export type RegisterTools = (server: McpServer, deps: McpDeps, ctx: Ctx) => void

const TOOLS: RegisterTools[] = [read.register, write.register, history.register, publish.register, media.register, redirects.register]

function instructions(deps: McpDeps): string {
  const { guide } = deps.core.registry.site
  const parts = [t('mcp.instructions')]
  if (guide !== undefined && guide.trim() !== '') parts.push(`${t('mcp.siteGuide')}\n${guide}`)
  return parts.join('\n\n')
}

/** The MCP server for one request, with every tool acting as `actor`. */
export function buildServer(deps: McpDeps, actor: Actor): McpServer {
  const { verify } = requestStateCodec(deps.secret)
  const server = new McpServer(
    { name: 'inlay', version: inlayVersion() },
    { instructions: instructions(deps), requestState: { verify } },
  )
  const ctx: Ctx = { actor, source: 'mcp' }
  for (const register of TOOLS) register(server, deps, ctx)
  return server
}

function isActor(value: unknown): value is Actor {
  if (typeof value !== 'object' || value === null) return false
  const { id, name, role } = value as Record<string, unknown>
  return (id === null || typeof id === 'string') && typeof name === 'string' && (role === 'owner' || role === 'editor')
}

/** The actor `/mcp` authenticated, from `authInfo.extra.actor`. */
function actorOf(authInfo: AuthInfo | undefined): Actor {
  const actor = authInfo?.extra?.actor
  if (!isActor(actor)) throw new InlayError('forbidden', 'error.forbidden')
  return actor
}

/**
 * The stateless `/mcp` handler: a fresh server per request, serving 2026-era clients and, without sessions,
 * 2025-era ones. Authentication happens before it; `authInfo.extra.actor` says who is calling.
 */
export function createInlayMcpHandler(opts: McpHandlerOptions): McpHttpHandler {
  const deps: McpDeps = { ...opts, confirmations: opts.confirmations ?? createNonceStore() }
  return createMcpHandler(({ authInfo }) => buildServer(deps, actorOf(authInfo)), { legacy: 'stateless' })
}
