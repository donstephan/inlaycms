import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { realInside } from '../../core/content/shipped-images.js'
import type { Core } from '../../core/core.js'
import { detectType } from '../../core/media/detect.js'
import { MARKDOWN_IMAGE_TYPES } from '../../core/richtext/markdown-text.js'
import { etagMatches } from './cache.js'

export interface MarkdownFile {
  sha: string
  ext: string
  mime: string
  path: string
  url: string
}

export interface MarkdownFiles {
  /**
   * The file a Markdown image target (a `file:` URL) names, or null when it isn't a usable image: one whose extension
   * is in `MARKDOWN_IMAGE_TYPES` and whose bytes are of that type (so never SVG).
   */
  lookup(src: string): Promise<MarkdownFile | null>
  /** A known file by its `<sha><ext>` name. */
  get(name: string): MarkdownFile | undefined
}

const RELEASE_NAME = /^([0-9a-f]{64})(\.[a-z0-9]+)$/
const ROUTE_NAME = /^[0-9a-f]{64}\.[a-z0-9]+$/

function entry(sha: string, ext: string, mime: string, path: string): MarkdownFile {
  return { sha, ext, mime, path, url: `/media/files/${sha}${ext}` }
}

/**
 * The image files Markdown in templates names. A release lists them up front (`releaseFiles`, source URL to the file
 * in the release); from source they are read from the site folder, hashed, and known from then on.
 */
export function createMarkdownFiles(opts: { siteDir: string | null; releaseFiles?: ReadonlyMap<string, string> }): MarkdownFiles {
  const byName = new Map<string, MarkdownFile>()
  const bySrc = new Map<string, Promise<MarkdownFile | null>>()
  const { siteDir, releaseFiles } = opts

  if (releaseFiles) {
    for (const path of releaseFiles.values()) {
      const m = RELEASE_NAME.exec(basename(path))
      const mime = m?.[2] === undefined ? undefined : MARKDOWN_IMAGE_TYPES[m[2]]
      if (m?.[1] === undefined || m[2] === undefined || mime === undefined) continue
      byName.set(basename(path), entry(m[1], m[2], mime, path))
    }
  }

  async function resolve(src: string): Promise<MarkdownFile | null> {
    try {
      if (releaseFiles) {
        const path = releaseFiles.get(src)
        if (path === undefined) return null
        const file = byName.get(basename(path))
        if (!file) return null
        return detectType(await readFile(file.path), file.path) === file.mime ? file : null
      }
      if (siteDir === null || !/^file:/i.test(src)) return null
      const real = await realInside(fileURLToPath(src), siteDir)
      if (real === null) return null
      const bytes = await readFile(real)
      const ext = extname(real).toLowerCase()
      const mime = detectType(bytes, real)
      if (MARKDOWN_IMAGE_TYPES[ext] === undefined || mime !== MARKDOWN_IMAGE_TYPES[ext]) return null
      const file = entry(createHash('sha256').update(bytes).digest('hex'), ext, mime, real)
      byName.set(`${file.sha}${file.ext}`, file)
      return file
    } catch {
      return null
    }
  }

  return {
    lookup(src) {
      let found = bySrc.get(src)
      if (!found) {
        found = resolve(src)
        bySrc.set(src, found)
      }
      return found
    },
    get: (name) => byName.get(name),
  }
}

const perCore = new WeakMap<Core, MarkdownFiles>()

/** The one index of `core`'s Markdown image files, so every render path and the image route share it. */
export function markdownFilesFor(core: Core): MarkdownFiles {
  let files = perCore.get(core)
  if (!files) {
    files = createMarkdownFiles({ siteDir: core.registry.siteDir, ...(core.markdownFiles && { releaseFiles: core.markdownFiles }) })
    perCore.set(core, files)
  }
  return files
}

/** Serves the known files at `/media/files/:name`, GET and HEAD, never anything but a file in the index. */
export function registerMarkdownFileRoutes(app: FastifyInstance, files: MarkdownFiles): void {
  app.route({
    method: ['GET', 'HEAD'],
    url: '/media/files/:name',
    handler: async (request, reply) => {
      const name = (request.params as { name: string }).name
      const file = ROUTE_NAME.test(name) ? files.get(name) : undefined
      let bytes: Buffer | undefined
      if (file) {
        try {
          bytes = await readFile(file.path)
        } catch {
          bytes = undefined
        }
      }
      if (!file || !bytes) return reply.code(404).header('cache-control', 'no-store').type('text/plain; charset=utf-8').send('Not found')
      const etag = `"${file.sha.slice(0, 32)}"`
      reply.header('cache-control', 'public, max-age=31536000, immutable').header('etag', etag)
      if (etagMatches(request.headers['if-none-match'], etag)) return reply.code(304).send()
      reply.type(file.mime).header('x-content-type-options', 'nosniff')
      return request.method === 'HEAD' ? reply.header('content-length', bytes.length).send() : reply.send(bytes)
    },
  })
}
