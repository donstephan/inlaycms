import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import sharp from 'sharp'
import { realInside, realInsideSync } from '../../core/content/shipped-images.js'
import type { Core } from '../../core/core.js'
import { InlayError } from '../../core/errors.js'
import { detectType } from '../../core/media/detect.js'
import type { VariantFormat } from '../../core/media/variants.js'
import type { CodeImage } from '../../core/registry/code-image.js'
import { MARKDOWN_IMAGE_TYPES } from '../../core/richtext/markdown-text.js'
import { etagMatches } from './cache.js'
import { VARIANT } from './media-routes.js'

export interface CodeFile {
  sha: string
  ext: string
  mime: string
  path: string
  url: string
  /** The displayed size (after EXIF rotation), known once the file has been read or registered from an import. */
  width: number | null
  height: number | null
}

export interface CodeFiles {
  /**
   * The file an image target in a site's code (a `file:` URL) names, or null when it isn't a usable image: one whose extension
   * is in `MARKDOWN_IMAGE_TYPES` and whose bytes are of that type (so never SVG).
   */
  lookup(src: string): Promise<CodeFile | null>
  /** A known file by its `<sha><ext>` name. */
  get(name: string): CodeFile | undefined
  /** A known file by its sha256. */
  bySha(sha: string): CodeFile | undefined
  /**
   * The file an imported image names. From source, one inside the site folder whose bytes match its sha and type,
   * checked once per source and remembered; from a release, only one the release ships. Null otherwise.
   */
  register(image: CodeImage): CodeFile | null
}

const RELEASE_NAME = /^([0-9a-f]{64})(\.[a-z0-9]+)$/
const ROUTE_NAME = /^[0-9a-f]{64}\.[a-z0-9]+$/
const SHA = /^[0-9a-f]{64}$/

function entry(sha: string, ext: string, mime: string, path: string, size?: { width: number; height: number }): CodeFile {
  return { sha, ext, mime, path, url: `/media/files/${sha}${ext}`, width: size?.width ?? null, height: size?.height ?? null }
}

/** The displayed size of an image (EXIF orientations 5 to 8 swap width and height), or nulls when sharp can't read it. */
async function measure(bytes: Buffer): Promise<{ width: number | null; height: number | null }> {
  try {
    const meta = await sharp(bytes).metadata()
    const turned = meta.orientation !== undefined && meta.orientation >= 5 && meta.orientation <= 8
    return { width: (turned ? meta.height : meta.width) ?? null, height: (turned ? meta.width : meta.height) ?? null }
  } catch {
    return { width: null, height: null }
  }
}

/**
 * The image files site code names (Markdown in templates, or imports). A release lists them up front (`releaseFiles`, source URL to the file
 * in the release); from source they are read from the site folder, hashed, and known from then on.
 */
export function createCodeFiles(opts: { siteDir: string | null; releaseFiles?: ReadonlyMap<string, string> }): CodeFiles {
  const byName = new Map<string, CodeFile>()
  const shas = new Map<string, CodeFile>()
  const bySrc = new Map<string, Promise<CodeFile | null>>()
  const registered = new Map<string, CodeFile | null>()
  const { siteDir, releaseFiles } = opts

  if (releaseFiles) {
    for (const path of releaseFiles.values()) {
      const m = RELEASE_NAME.exec(basename(path))
      const mime = m?.[2] === undefined ? undefined : MARKDOWN_IMAGE_TYPES[m[2]]
      if (m?.[1] === undefined || m[2] === undefined || mime === undefined) continue
      add(entry(m[1], m[2], mime, path))
    }
  }

  function add(file: CodeFile): CodeFile {
    const name = `${file.sha}${file.ext}`
    const known = byName.get(name)
    if (known) return known
    byName.set(name, file)
    if (!shas.has(file.sha)) shas.set(file.sha, file)
    return file
  }

  /**
   * The file an imported image names, read once: only one inside the site folder whose bytes hash to `image.sha` and
   * are the type its extension names.
   */
  function fromSource(image: CodeImage): CodeFile | null {
    const ext = image.ext.toLowerCase()
    const mime = MARKDOWN_IMAGE_TYPES[ext]
    if (siteDir === null || mime === undefined || image.mime !== mime || !/^file:/i.test(image.source)) return null
    try {
      const real = realInsideSync(fileURLToPath(image.source), siteDir)
      if (real === null || extname(real).toLowerCase() !== ext) return null
      const bytes = readFileSync(real)
      if (createHash('sha256').update(bytes).digest('hex') !== image.sha || detectType(bytes, real) !== mime) return null
      return add(entry(image.sha, ext, mime, real, { width: image.width, height: image.height }))
    } catch {
      return null
    }
  }

  async function resolve(src: string): Promise<CodeFile | null> {
    try {
      if (releaseFiles) {
        const path = releaseFiles.get(src)
        if (path === undefined) return null
        const file = byName.get(basename(path))
        if (!file) return null
        const bytes = await readFile(file.path)
        if (detectType(bytes, file.path) !== file.mime) return null
        if (file.width === null || file.height === null) Object.assign(file, await measure(bytes))
        return file
      }
      if (siteDir === null || !/^file:/i.test(src)) return null
      const real = await realInside(fileURLToPath(src), siteDir)
      if (real === null) return null
      const bytes = await readFile(real)
      const ext = extname(real).toLowerCase()
      const mime = detectType(bytes, real)
      if (MARKDOWN_IMAGE_TYPES[ext] === undefined || mime !== MARKDOWN_IMAGE_TYPES[ext]) return null
      const file = add(entry(createHash('sha256').update(bytes).digest('hex'), ext, mime, real))
      if (file.width === null || file.height === null) Object.assign(file, await measure(bytes))
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
    bySha: (sha) => shas.get(sha),
    register(image) {
      if (!SHA.test(image.sha)) return null
      if (releaseFiles) return byName.get(`${image.sha}${image.ext}`) ?? null
      // By everything the check reads, so a hand-built value naming the same file can't stand in for the real one.
      const key = JSON.stringify([image.source, image.sha, image.ext, image.mime])
      let found = registered.get(key)
      if (found === undefined) {
        found = fromSource(image)
        registered.set(key, found)
      }
      return found
    },
  }
}

const perCore = new WeakMap<Core, CodeFiles>()

/** The one index of `core`'s images named by site code, so every render path and the image route share it. */
export function codeFilesFor(core: Core): CodeFiles {
  let files = perCore.get(core)
  if (!files) {
    files = createCodeFiles({ siteDir: core.registry.siteDir, ...(core.codeFiles && { releaseFiles: core.codeFiles }) })
    perCore.set(core, files)
  }
  return files
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).header('cache-control', 'no-store').type('text/plain; charset=utf-8').send('Not found')
}

function send(request: FastifyRequest, reply: FastifyReply, bytes: Buffer, mime: string, etag: string): FastifyReply {
  reply.header('cache-control', 'public, max-age=31536000, immutable').header('etag', etag)
  if (etagMatches(request.headers['if-none-match'], etag)) return reply.code(304).send()
  reply.type(mime).header('x-content-type-options', 'nosniff')
  return request.method === 'HEAD' ? reply.header('content-length', bytes.length).send() : reply.send(bytes)
}

async function read(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch {
    return undefined
  }
}

/**
 * Serves the known files at `/media/files/:name`, and their resized variants at `/media/files/:sha/:width.:format`,
 * GET and HEAD, never anything but a file in the index.
 */
export function registerCodeFileRoutes(app: FastifyInstance, files: CodeFiles, core: Core): void {
  app.route({
    method: ['GET', 'HEAD'],
    url: '/media/files/:name',
    handler: async (request, reply) => {
      const name = (request.params as { name: string }).name
      const file = ROUTE_NAME.test(name) ? files.get(name) : undefined
      const bytes = file && (await read(file.path))
      if (!file || !bytes) return notFound(reply)
      return send(request, reply, bytes, file.mime, `"${file.sha.slice(0, 32)}"`)
    },
  })

  app.route({
    method: ['GET', 'HEAD'],
    url: '/media/files/:sha/:variant',
    handler: async (request, reply) => {
      const { sha, variant } = request.params as { sha: string; variant: string }
      const file = SHA.test(sha) ? files.bySha(sha) : undefined
      const m = VARIANT.exec(variant)
      if (!file || !m) return notFound(reply)
      let made: { path: string; mime: string }
      try {
        made = await core.codeImageVariant(file, { width: Number(m[1]), format: m[2] as VariantFormat })
      } catch (e) {
        if (e instanceof InlayError && (e.code === 'not_found' || e.messageId === 'error.mediaUnreadable')) return notFound(reply)
        throw e
      }
      const bytes = await read(made.path)
      if (!bytes) return notFound(reply)
      return send(request, reply, bytes, made.mime, `"${sha.slice(0, 32)}-${m[1]}.${m[2]}"`)
    },
  })
}
