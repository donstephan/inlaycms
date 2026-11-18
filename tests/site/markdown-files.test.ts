import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import { createMarkdownFiles, markdownFilesFor, registerMarkdownFileRoutes } from '../../src/adapters/site/markdown-files.js'
import { createCore } from '../../src/core/core.js'
import { openDatabase } from '../../src/core/db/connection.js'
import { site as fixtureSite } from '../fixtures/site.js'
import { makeCore } from '../helpers/core.js'
import { jpeg, png, sha256 } from '../fixtures/media.js'

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

describe('createMarkdownFiles', () => {
  it('from source: lookup hashes the file and get finds it', async () => {
    const files = createMarkdownFiles({ siteDir: siteUrl() })
    const file = await files.lookup(pathToFileURL(join(site, 'a.png')).href)
    expect(file).toMatchObject({ sha, ext: '.png', mime: 'image/png', url: `/media/files/${sha}.png` })
    expect(files.get(`${sha}.png`)).toBe(file)
  })

  it('from source: refuses a file outside the site folder, or not an image', async () => {
    const files = createMarkdownFiles({ siteDir: siteUrl() })
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
    const files = createMarkdownFiles({ siteDir: siteUrl() })
    for (const name of ['logo.svg', 'logo.png', 'photo.jfif', 'photo', 'photo.jpg']) {
      expect(await files.lookup(pathToFileURL(join(site, name)).href), name).toBeNull()
    }
  })

  it('from a release: leaves out a file whose extension is not on the list', () => {
    const svg = join(dir, 'content', `${sha}.svg`)
    const files = createMarkdownFiles({ siteDir: null, releaseFiles: new Map([['file:///x/a.svg', svg]]) })
    expect(files.get(`${sha}.svg`)).toBeUndefined()
  })

  it('from a release: get works before any lookup', () => {
    const path = join(dir, 'content', `${sha}.png`)
    const files = createMarkdownFiles({ siteDir: null, releaseFiles: new Map([['file:///x/a.png', path]]) })
    expect(files.get(`${sha}.png`)?.path).toBe(path)
  })
})

describe('markdownFilesFor', () => {
  it('gives one index per core', async () => {
    const { core } = await makeCore()
    const { core: other } = await makeCore()
    expect(markdownFilesFor(core)).toBe(markdownFilesFor(core))
    expect(markdownFilesFor(other)).not.toBe(markdownFilesFor(core))
  })

  it("indexes a loaded release's shipped files", () => {
    const path = join(dir, 'content', `${sha}.png`)
    const core = createCore({ site: fixtureSite, db: openDatabase(':memory:'), markdownFiles: new Map([['file:///x/a.png', path]]) })
    expect(markdownFilesFor(core).get(`${sha}.png`)?.path).toBe(path)
  })
})

describe('registerMarkdownFileRoutes', () => {
  async function serve() {
    const files = createMarkdownFiles({ siteDir: siteUrl() })
    await files.lookup(pathToFileURL(join(site, 'a.png')).href)
    app = Fastify()
    registerMarkdownFileRoutes(app, files)
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
    const files = createMarkdownFiles({ siteDir: siteUrl() })
    await files.lookup(pathToFileURL(join(site, 'a.png')).href)
    expect(await files.lookup(pathToFileURL(join(site, 'logo.svg')).href)).toBeNull()
    app = Fastify()
    registerMarkdownFileRoutes(app, files)
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
})
