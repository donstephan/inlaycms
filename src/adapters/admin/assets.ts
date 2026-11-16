import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { InlayError } from '../../core/errors.js'

export type AssetName = 'admin.css' | 'admin.js' | 'editor.js'

export interface AdminAssets {
  url(name: AssetName): string
  read(name: AssetName): Promise<{ body: Buffer; type: string; hash: string } | null>
}

const NAMES: readonly string[] = ['admin.css', 'admin.js', 'editor.js']
const TYPES: Record<AssetName, string> = {
  'admin.css': 'text/css; charset=utf-8',
  'admin.js': 'text/javascript; charset=utf-8',
  'editor.js': 'text/javascript; charset=utf-8',
}

interface Entry {
  path: string
  type: string
  mtime: number
  body: Buffer
  hash: string
}

const hashOf = (body: Buffer) => createHash('sha256').update(body).digest('hex').slice(0, 10)

export async function loadAdminAssets(opts: { dir?: string } = {}): Promise<AdminAssets> {
  const dir = opts.dir ?? fileURLToPath(new URL('../../../assets/admin/', import.meta.url))
  const entries = new Map<string, Entry>()

  async function load(name: string, path: string, type: string): Promise<Entry | null> {
    try {
      const info = await stat(path)
      const cached = entries.get(name)
      if (cached && cached.mtime === info.mtimeMs) return cached
      const body = await readFile(path)
      const entry = { path, type, mtime: info.mtimeMs, body, hash: hashOf(body) }
      entries.set(name, entry)
      return entry
    } catch {
      return null
    }
  }

  for (const name of ['admin.css', 'admin.js'] as const) {
    if (!(await load(name, join(dir, name), TYPES[name]))) {
      throw new InlayError('config', 'config.adminAssetsMissing', { dir })
    }
  }
  await load('editor.js', join(dir, 'editor.js'), TYPES['editor.js'])

  async function read(name: AssetName) {
    const entry = await load(name, join(dir, name), TYPES[name])
    return entry ? { body: entry.body, type: entry.type, hash: entry.hash } : null
  }

  return {
    read,
    url(name) {
      const entry = entries.get(name)
      return `/admin/assets/${name}${entry ? `?v=${entry.hash}` : ''}`
    },
  }
}

export function registerAssetRoutes(scope: FastifyInstance, assets: AdminAssets): void {
  scope.get<{ Params: { name: string }; Querystring: { v?: string } }>('/admin/assets/:name', async (request, reply) => {
    const { name } = request.params
    if (!NAMES.includes(name)) return reply.code(404).send()
    const asset = await assets.read(name as AssetName)
    if (!asset) return reply.code(404).send()
    const current = request.query.v === asset.hash
    reply
      .header('cache-control', current ? 'public, max-age=31536000, immutable' : 'no-cache')
      .header('x-content-type-options', 'nosniff')
      .header('x-robots-tag', 'noindex')
    return reply.type(asset.type).send(asset.body)
  })
}
