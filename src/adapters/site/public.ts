import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { extname, sep } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ASSET_VERSION_LENGTH, locate } from './assets.js'
import { etagMatches } from './cache.js'
import { catalogPage } from './render.js'

const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.map': 'application/json; charset=utf-8',
}

/** The request's path without its query or leading `/`, when its last segment has a `.`; null otherwise. */
export function rootPublicPath(rawUrl: string): string | null {
  const q = rawUrl.indexOf('?')
  const path = q === -1 ? rawUrl : rawUrl.slice(0, q)
  const last = path.slice(path.lastIndexOf('/') + 1)
  if (!last.includes('.')) return null
  return path.slice(1)
}

/** Sends the file `rawPath` names under `opts.dir`, or returns null, leaving `reply` alone, when nothing servable is there. */
export async function sendPublicFile(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: { dir: string; maxAge: number; autoHead?: boolean },
  rawPath: string,
): Promise<FastifyReply | null> {
  const file = locate(opts.dir, rawPath)
  if (file === null) return null
  let bytes: Buffer
  try {
    // A symlink is never followed: not as the file, nor as a folder on the way to it.
    if (!(await lstat(file)).isFile()) return null
    if (!(await realpath(file)).startsWith((await realpath(opts.dir)) + sep)) return null
    bytes = await readFile(file)
  } catch {
    return null
  }
  const rawUrl = request.raw.url ?? ''
  const q = rawUrl.indexOf('?')
  const hex = createHash('sha256').update(bytes).digest('hex')
  const etag = `"${hex.slice(0, 32)}"`
  const version = new URLSearchParams(q === -1 ? '' : rawUrl.slice(q + 1)).get('v')
  const cacheControl =
    version === hex.slice(0, ASSET_VERSION_LENGTH) ? 'public, max-age=31536000, immutable' : `public, max-age=${opts.maxAge}`
  reply.header('cache-control', cacheControl).header('etag', etag)
  if (etagMatches(request.headers['if-none-match'], etag)) return reply.code(304).send()
  const ext = extname(file).toLowerCase()
  reply.type(TYPES[ext] ?? 'application/octet-stream').header('x-content-type-options', 'nosniff')
  // An SVG opened on its own could run script on the site's origin.
  if (ext === '.svg') reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
  // Under a GET-only route Fastify answers HEAD itself, from the payload's length.
  return request.method === 'HEAD' && opts.autoHead !== true ? reply.header('content-length', bytes.length).send() : reply.send(bytes)
}

/** Serves the files under `opts.dir` at `/public/*`, GET and HEAD, never anything outside it. */
export function registerPublicRoutes(app: FastifyInstance, opts: { dir: string; maxAge: number }): void {
  app.route({
    method: ['GET', 'HEAD'],
    url: '/public/*',
    handler: async (request, reply) => {
      const wildcard = (request.params as { '*'?: string })['*'] ?? ''
      const rawUrl = request.raw.url ?? ''
      const q = rawUrl.indexOf('?')
      const rawPath = (q === -1 ? rawUrl : rawUrl.slice(0, q)).slice('/public/'.length)
      const sent = await sendPublicFile(request, reply, opts, rawPath === '' ? wildcard : rawPath)
      if (sent !== null) return sent
      return reply.code(404).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(catalogPage('site.notFound.title', 'site.notFound'))
    },
  })
}
