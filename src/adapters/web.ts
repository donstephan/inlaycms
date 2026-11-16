import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { FastifyReply, FastifyRequest } from 'fastify'

/** The only header better-auth reads the client's IP from; Inlay always sets it itself. */
export const CLIENT_IP_HEADER = 'x-inlay-client-ip'

/** Request headers that describe the incoming connection or body, not the request, so they're never forwarded. */
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'expect', 'host', 'content-length'])

/** The request's headers as Web `Headers`, with `x-inlay-client-ip` set from Fastify's `request.ip`. */
export function webHeaders(request: FastifyRequest): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP.has(name) || name === CLIENT_IP_HEADER) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  headers.set(CLIENT_IP_HEADER, request.ip)
  return headers
}

/**
 * A Web `Request` for `request` at `baseUrl` (so better-auth sees the site's own origin), with its headers and the
 * client IP. `path` (default: the request's URL) and `body` replace the request's own; `headers` are set last.
 */
export function toWebRequest(
  request: FastifyRequest,
  baseUrl: string,
  opts: { path?: string; body?: string | Buffer; headers?: Record<string, string> } = {},
): Request {
  const headers = webHeaders(request)
  for (const [name, value] of Object.entries(opts.headers ?? {})) {
    if (name.toLowerCase() !== CLIENT_IP_HEADER) headers.set(name, value)
  }
  const { method } = request
  const hasBody = opts.body !== undefined && method !== 'GET' && method !== 'HEAD'
  return new Request(`${baseUrl}${opts.path ?? request.url}`, {
    method,
    headers,
    ...(hasBody && { body: typeof opts.body === 'string' ? opts.body : new Uint8Array(opts.body as Buffer) }),
  })
}

/** Copies every `set-cookie` of `res` onto `reply`, each as its own header. */
export function copyCookies(reply: FastifyReply, res: Response): void {
  const cookies = res.headers.getSetCookie()
  if (cookies.length > 0) reply.header('set-cookie', cookies)
}

/** Sends `res` through `reply`: status, headers (each `set-cookie` separately) and a streamed body. */
export async function sendWebResponse(reply: FastifyReply, res: Response): Promise<FastifyReply> {
  reply.code(res.status)
  res.headers.forEach((value, name) => {
    if (name !== 'set-cookie' && name !== 'transfer-encoding' && name !== 'connection') reply.header(name, value)
  })
  copyCookies(reply, res)
  if (res.body === null) return reply.send()
  return reply.send(Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>))
}

/** Whether the request's `Origin` header is exactly `baseUrl`. A missing `Origin` is not the same origin. */
export function sameOrigin(request: FastifyRequest, baseUrl: string): boolean {
  return request.headers.origin === baseUrl
}

const PROBE = 'http://inlay.invalid'

/** `raw` as a clean site-relative path (with its query), or `fallback` when it isn't one. */
export function safeNext(raw: unknown, fallback = '/admin'): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return fallback
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return fallback
  let url: URL
  try {
    url = new URL(raw, PROBE)
  } catch {
    return fallback
  }
  if (url.origin !== PROBE) return fallback
  const next = `${url.pathname}${url.search}`
  return next.startsWith('/') && !next.startsWith('//') ? next : fallback
}
