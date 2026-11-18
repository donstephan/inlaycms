import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { InlayError } from '../../core/errors.js'

export interface ConsentAsset {
  url: string
  body: string
}

const PATH = '/_inlay/consent.js'

export async function loadConsentAsset(opts: { dir?: string } = {}): Promise<ConsentAsset> {
  const dir = opts.dir ?? fileURLToPath(new URL('../../../assets/site/', import.meta.url))
  let body: string
  try {
    body = await readFile(join(dir, 'consent.js'), 'utf8')
  } catch {
    throw new InlayError('config', 'config.siteAssetsMissing', { dir })
  }
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 12)
  return { url: `${PATH}?v=${hash}`, body }
}

export function registerConsentRoute(app: FastifyInstance, asset: ConsentAsset): void {
  const version = asset.url.slice(asset.url.indexOf('?v=') + 3)
  app.get<{ Querystring: { v?: string } }>(PATH, async (request, reply) => {
    const current = request.query.v === version
    reply.header('cache-control', current ? 'public, max-age=31536000, immutable' : 'no-cache').header('x-content-type-options', 'nosniff')
    return reply.type('text/javascript; charset=utf-8').send(asset.body)
  })
}
