import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { createCodeFiles, codeFilesFor, registerCodeFileRoutes } from '../../src/adapters/site/code-files.js'
import { createCore } from '../../src/core/core.js'
import { openDatabase } from '../../src/core/db/connection.js'
import { site as fixtureSite } from '../fixtures/site.js'
import { makeCore } from '../helpers/core.js'
import { jpeg, png, sha256 } from '../fixtures/media.js'
import type { CodeImage } from '../../src/core/registry/code-image.js'

let dir: string
let site: string
let bytes: Buffer
let sha: string
let app: FastifyInstance | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inlay-mdfiles-'))
  site = join(dir, 'site')
  await mkdir(site)
  bytes = await png(8, 8)
  sha = sha256(bytes)
  await writeFile(join(site, 'a.png'), bytes)
  await writeFile(join(site, 'note.png'), 'not an image')
  await writeFile(join(dir, 'outside.png'), bytes)
})
afterEach(async () => {
  await app?.close()
  app = undefined
  await rm(dir, { recursive: true, force: true })
})

const siteUrl = () => pathToFileURL(site).href + '/'

describe('createCodeFiles', () => {
  it('from source: lookup hashes the file and get finds it', async () => {
    const files = createCodeFiles({ siteDir: siteUrl() })
    const file = await files.lookup(pathToFileURL(join(site, 'a.png')).href)
    expect(file).toMatchObject({ sha, ext: '.png', mime: 'image/png', url: `/media/files/${sha}.png` })
    expect(files.get(`${sha}.png`)).toBe(file)
  })

  it('from source: refuses a file outside the site folder, or not an image', async () => {
    const files = createCodeFiles({ siteDir: siteUrl() })
    expect(await files.lookup(pathToFileURL(join(dir, 'outside.png')).href)).toBeNull()
    expect(await files.lookup(pathToFileURL(join(site, 'note.png')).href)).toBeNull()
    expect(await files.lookup(pathToFileURL(join(site, 'missing.png')).href)).toBeNull()
  })

  it('from source: refuses SVG, an extension not on the list, and bytes of another type than the extension says', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
    await writeFile(join(site, 'logo.svg'), svg)
    await writeFile(join(site, 'logo.png'), svg)
    await writeFile(join(site, 'photo.jfif'), await jpeg(4, 4))
    await writeFile(join(site, 'photo'), bytes)
    await writeFile(join(site, 'photo.jpg'), bytes)
    const files = createCodeFiles({ siteDir: siteUrl() })
    for (const name of ['logo.svg', 'logo.png', 'photo.jfif', 'photo', 'photo.jpg']) {
      expect(await files.lookup(pathToFileURL(join(site, name)).href), name).toBeNull()
    }
  })

  it('from a release: leaves out a file whose extension is not on the list', () => {
    const svg = join(dir, 'content', `${sha}.svg`)
    const files = createCodeFiles({ siteDir: null, releaseFiles: new Map([['file:///x/a.svg', svg]]) })
    expect(files.get(`${sha}.svg`)).toBeUndefined()
  })

  it('from source: lookup measures the displayed size, swapped for an EXIF-rotated photo', async () => {
    await writeFile(join(site, 'turned.jpg'), await jpeg(80, 40, { orientation: 6 }))
    const files = createCodeFiles({ siteDir: siteUrl() })
    expect(await files.lookup(pathToFileURL(join(site, 'a.png')).href)).toMatchObject({ width: 8, height: 8 })
    expect(await files.lookup(pathToFileURL(join(site, 'turned.jpg')).href)).toMatchObject({ width: 40, height: 80 })
  })

  const image = (over: Partial<CodeImage> = {}): CodeImage => ({
    kind: 'codeImage',
    source: pathToFileURL(join(site, 'a.png')).href,
    sha,
    ext: '.png',
    mime: 'image/png',
    width: 8,
    height: 8,
    ...over,
  })

  it('from source: register records an image inside the site folder, and bySha finds it', () => {
    const files = createCodeFiles({ siteDir: siteUrl() })
    const file = files.register(image())
    expect(file).toMatchObject({ sha, ext: '.png', mime: 'image/png', width: 8, height: 8, url: `/media/files/${sha}.png` })
    expect(files.bySha(sha)).toBe(file)
    expect(files.get(`${sha}.png`)).toBe(file)
  })

  it('from source: register refuses a file outside the site folder or a hand-built source', () => {
    const files = createCodeFiles({ siteDir: siteUrl() })
    expect(files.register(image({ source: 'file:///etc/passwd' }))).toBeNull()
    expect(files.register(image({ source: pathToFileURL(join(dir, 'outside.png')).href }))).toBeNull()
    expect(files.register(image({ source: 'https://example.com/a.png' }))).toBeNull()
    expect(files.register(image({ ext: '.svg', mime: 'image/svg+xml' }))).toBeNull()
    expect(files.bySha(sha)).toBeUndefined()
  })

  it("from source: register refuses a hand-built image whose sha isn't its file's, and a text file named .png", () => {
    const files = createCodeFiles({ siteDir: siteUrl() })
    expect(files.register(image({ sha: 'f'.repeat(64) }))).toBeNull()
    expect(files.bySha('f'.repeat(64))).toBeUndefined()
    const note = Buffer.from('not an image')
    expect(files.register(image({ source: pathToFileURL(join(site, 'note.png')).href, sha: sha256(note) }))).toBeNull()
    expect(files.bySha(sha256(note))).toBeUndefined()
  })

  it('from source: register reads a file once, then remembers it', async () => {
    const files = createCodeFiles({ siteDir: siteUrl() })
    const file = files.register(image())
    expect(file).not.toBeNull()
    await rm(join(site, 'a.png'))
    expect(files.register(image())).toBe(file)
  })

  it('from source: a later registration never moves a known file to another path', async () => {
    await writeFile(join(site, 'b.png'), bytes)
    const files = createCodeFiles({ siteDir: siteUrl() })
    const first = files.register(image())
    expect(files.register(image({ source: pathToFileURL(join(site, 'b.png')).href }))).toBe(first)
    expect(files.get(`${sha}.png`)?.path).toBe(first?.path)
  })

  it('from a release: bySha works before any lookup or register, and register adds nothing', () => {
    const path = join(dir, 'content', `${sha}.png`)
    const files = createCodeFiles({ siteDir: null, releaseFiles: new Map([['file:///x/a.png', path]]) })
    expect(files.bySha(sha)).toMatchObject({ path, width: null, height: null })
    const other = 'f'.repeat(64)
    expect(files.register(image({ sha: other }))).toBeNull()
    expect(files.bySha(other)).toBeUndefined()
    expect(files.register(image({ source: 'file:///elsewhere/a.png' }))).toBe(files.bySha(sha))
  })

  it('from a release: lookup fills in the size', async () => {
    const path = join(dir, 'content', `${sha}.png`)
    await mkdir(join(dir, 'content'))
    await writeFile(path, bytes)
    const files = createCodeFiles({ siteDir: null, releaseFiles: new Map([['file:///x/a.png', path]]) })
    expect(await files.lookup('file:///x/a.png')).toMatchObject({ width: 8, height: 8 })
    expect(files.bySha(sha)).toMatchObject({ width: 8, height: 8 })
  })

  it('from a release: get works before any lookup', () => {
    const path = join(dir, 'content', `${sha}.png`)
    const files = createCodeFiles({ siteDir: null, releaseFiles: new Map([['file:///x/a.png', path]]) })
    expect(files.get(`${sha}.png`)?.path).toBe(path)
  })
})

describe('codeFilesFor', () => {
  it('gives one index per core', async () => {
    const { core } = await makeCore()
    const { core: other } = await makeCore()
    expect(codeFilesFor(core)).toBe(codeFilesFor(core))
    expect(codeFilesFor(other)).not.toBe(codeFilesFor(core))
  })

  it("indexes a loaded release's shipped files", () => {
    const path = join(dir, 'content', `${sha}.png`)
    const core = createCore({ site: fixtureSite, db: openDatabase(':memory:'), codeFiles: new Map([['file:///x/a.png', path]]) })
    expect(codeFilesFor(core).get(`${sha}.png`)?.path).toBe(path)
  })
})

describe('registerCodeFileRoutes', () => {
  async function serve() {
    const files = createCodeFiles({ siteDir: siteUrl() })
    await files.lookup(pathToFileURL(join(site, 'a.png')).href)
    const { core } = await makeCore({ media: true })
    app = Fastify()
    registerCodeFileRoutes(app, files, core)
    return app
  }

  it('serves a known file with immutable caching, and 304 on its etag', async () => {
    const res = await (await serve()).inject({ url: `/media/files/${sha}.png` })
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.equals(bytes)).toBe(true)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    const etag = res.headers.etag as string
    const again = await app!.inject({ url: `/media/files/${sha}.png`, headers: { 'if-none-match': etag } })
    expect(again.statusCode).toBe(304)
  })

  it('answers HEAD with the length', async () => {
    const res = await (await serve()).inject({ method: 'HEAD', url: `/media/files/${sha}.png` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-length']).toBe(String(bytes.length))
  })

  it('answers 404 for an .svg name, even with the hash of a file in the site folder', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    await writeFile(join(site, 'logo.svg'), svg)
    const files = createCodeFiles({ siteDir: siteUrl() })
    await files.lookup(pathToFileURL(join(site, 'a.png')).href)
    expect(await files.lookup(pathToFileURL(join(site, 'logo.svg')).href)).toBeNull()
    const { core } = await makeCore({ media: true })
    app = Fastify()
    registerCodeFileRoutes(app, files, core)
    for (const url of [`/media/files/${sha256(svg)}.svg`, `/media/files/${sha}.svg`]) {
      const res = await app.inject({ url })
      expect(res.statusCode, url).toBe(404)
    }
  })

  it('answers 404 for a bad name, a path trick or an unknown hash', async () => {
    const a = await serve()
    for (const url of ['/media/files/nothex.png', '/media/files/..%2fsite.js', `/media/files/${'0'.repeat(64)}.png`]) {
      const res = await a.inject({ url })
      expect(res.statusCode, url).toBe(404)
      expect(res.headers['cache-control']).toBe('no-store')
    }
  })

  describe('variants', () => {
    let big: Buffer
    let bigSha: string

    async function serveBig() {
      big = await png(2000, 1000)
      bigSha = sha256(big)
      await writeFile(join(site, 'big.png'), big)
      const files = createCodeFiles({ siteDir: siteUrl() })
      files.register({ kind: 'codeImage', source: pathToFileURL(join(site, 'big.png')).href, sha: bigSha, ext: '.png', mime: 'image/png', width: 2000, height: 1000 })
      const { core } = await makeCore({ media: true })
      app = Fastify()
      registerCodeFileRoutes(app, files, core)
      return app
    }

    it('serves a resized variant with immutable caching, and 304 on its etag', async () => {
      const a = await serveBig()
      const res = await a.inject({ url: `/media/files/${bigSha}/640.webp` })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toBe('image/webp')
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(await sharp(res.rawPayload).metadata()).toMatchObject({ format: 'webp', width: 640, height: 320 })
      const again = await a.inject({ url: `/media/files/${bigSha}/640.webp`, headers: { 'if-none-match': res.headers.etag as string } })
      expect(again.statusCode).toBe(304)
      const head = await a.inject({ method: 'HEAD', url: `/media/files/${bigSha}/640.webp` })
      expect(head.statusCode).toBe(200)
      expect(head.headers['content-length']).toBe(String(res.rawPayload.length))
    })

    it('serves a release image before any lookup or register', async () => {
      big = await png(2000, 1000)
      bigSha = sha256(big)
      const path = join(dir, 'content', `${bigSha}.png`)
      await mkdir(join(dir, 'content'))
      await writeFile(path, big)
      const files = createCodeFiles({ siteDir: null, releaseFiles: new Map([['file:///x/big.png', path]]) })
      const { core } = await makeCore({ media: true })
      app = Fastify()
      registerCodeFileRoutes(app, files, core)
      const res = await app.inject({ url: `/media/files/${bigSha}/960.jpeg` })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toBe('image/jpeg')
    })

    it("answers 404 when the file can't be read as a picture", async () => {
      const cut = (await png(2000, 1000)).subarray(0, 64)
      await writeFile(join(site, 'cut.png'), cut)
      const files = createCodeFiles({ siteDir: siteUrl() })
      const cutSha = sha256(cut)
      expect(files.register({ kind: 'codeImage', source: pathToFileURL(join(site, 'cut.png')).href, sha: cutSha, ext: '.png', mime: 'image/png', width: 2000, height: 1000 })).not.toBeNull()
      const { core } = await makeCore({ media: true })
      app = Fastify()
      registerCodeFileRoutes(app, files, core)
      const res = await app.inject({ url: `/media/files/${cutSha}/640.webp` })
      expect(res.statusCode).toBe(404)
      expect(res.headers['cache-control']).toBe('no-store')
    })

    it('answers 404 for a bad width or format, an unknown hash or a bad name', async () => {
      const a = await serveBig()
      for (const url of [
        `/media/files/${bigSha}/333.webp`,
        `/media/files/${bigSha}/640.gif`,
        `/media/files/${bigSha}/640`,
        `/media/files/${'0'.repeat(64)}/640.webp`,
        '/media/files/notahash/640.webp',
        `/media/files/${bigSha.toUpperCase()}/640.webp`,
      ]) {
        const res = await a.inject({ url })
        expect(res.statusCode, url).toBe(404)
        expect(res.headers['cache-control'], url).toBe('no-store')
      }
    })
  })
})
