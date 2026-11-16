import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { FastifyInstance } from 'fastify'
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

const ENCODED = /%2e|%2f|%5c/i

/** The absolute path under `dir` that the raw wildcard names, or null when it is empty, tricky or outside `dir`. */
function locate(dir: string, rawPath: string): string | null {
  if (rawPath === '' || ENCODED.test(rawPath) || rawPath.includes('\\')) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null
  const segments = decoded.split('/')
  if (segments.some((s) => s === '' || s.startsWith('.'))) return null
  const root = resolve(dir)
  const file = resolve(root, ...segments)
  return file.startsWith(root + sep) ? file : null
}

/** Serves the files under `opts.dir` at `/public/*`, GET and HEAD, never anything outside it. */
export function registerPublicRoutes(app: FastifyInstance, opts: { dir: string; maxAge: number }): void {
  app.route({
    method: ['GET', 'HEAD'],
    url: '/public/*',
    handler: async (request, reply) => {
      const missing = () =>
        reply.code(404).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(catalogPage('site.notFound.title', 'site.notFound'))
      const wildcard = (request.params as { '*'?: string })['*'] ?? ''
      const q = request.raw.url?.indexOf('?') ?? -1
      const rawUrl = request.raw.url ?? ''
      const rawPath = (q === -1 ? rawUrl : rawUrl.slice(0, q)).slice('/public/'.length)
      const file = locate(opts.dir, rawPath === '' ? wildcard : rawPath)
      if (file === null) return missing()
      let bytes: Buffer
      try {
        // A symlink is never followed: not as the file, nor as a folder on the way to it.
        if (!(await lstat(file)).isFile()) return missing()
        if (!(await realpath(file)).startsWith((await realpath(opts.dir)) + sep)) return missing()
        bytes = await readFile(file)
      } catch {
        return missing()
      }
      const etag = `"${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}"`
      reply.header('cache-control', `public, max-age=${opts.maxAge}`).header('etag', etag)
      if (etagMatches(request.headers['if-none-match'], etag)) return reply.code(304).send()
      const ext = extname(file).toLowerCase()
      reply.type(TYPES[ext] ?? 'application/octet-stream').header('x-content-type-options', 'nosniff')
      // An SVG opened on its own could run script on the site's origin.
      if (ext === '.svg') reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
      return request.method === 'HEAD' ? reply.header('content-length', bytes.length).send() : reply.send(bytes)
    },
  })
}
