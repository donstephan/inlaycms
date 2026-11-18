import { randomBytes } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { loadConfig } from '../../src/config.js'
import type { Core } from '../../src/core/core.js'
import { generateKeyPair } from '../../src/core/release/keys.js'
import { packRelease } from '../../src/core/release/pack.js'
import { readRelease } from '../../src/core/release/read.js'
import { markdownHeadings } from '../../src/core/richtext/markdown-text.js'
import type { Ctx } from '../../src/core/types.js'
import { createSiteApp, sourceFromConfig, type SiteSource } from '../../src/host/app.js'
import { ensureDataDir, readHostConfig } from '../../src/host/config.js'
import { createRenderContext } from '../../src/adapters/site/context.js'
import { t } from '../../src/core/messages/index.js'
import { createTestSite, type TestSite } from '../../src/testing.js'
import { sha256 } from '../fixtures/media.js'

const fixture = resolve(import.meta.dirname, '../fixtures/markdown-site')
const config = join(fixture, 'inlay.config.ts')
const owner: Ctx = { actor: { id: 'user-owner', name: 'Olivia Owner', role: 'owner' }, source: 'admin' }

let scratch: string
let site: TestSite | undefined
const apps: FastifyInstance[] = []
let src: string
let variant: string
let size: { width: number; height: number }

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'inlay-markdown-')))
  const bytes = await readFile(join(fixture, 'pic.png'))
  src = `/media/files/${sha256(bytes)}.png`
  variant = `/media/files/${sha256(bytes)}/320.webp`
  const meta = await sharp(bytes).metadata()
  size = { width: meta.width!, height: meta.height! }
})
afterEach(async () => {
  await site?.close()
  site = undefined
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await rm(scratch, { recursive: true, force: true })
})

async function boot(source: SiteSource): Promise<{ app: FastifyInstance; core: Core }> {
  const data = join(scratch, `data-${apps.length}`)
  const host = readHostConfig({
    INLAY_DATA_DIR: data,
    INLAY_BASE_URL: 'http://localhost',
    INLAY_SECRET: randomBytes(32).toString('hex'),
    INLAY_RATE_LIMIT: 'off',
  })
  await ensureDataDir(host)
  const booted = await createSiteApp(host, source, { content: 'apply', backupSchedule: false })
  apps.push(booted.app)
  return booted
}

const img = () =>
  `<img src="${variant}" srcset="${variant} 320w" alt="Pic" width="${size.width}" height="${size.height}" loading="lazy">`

describe('ctx.markdown', () => {
  it('renders an imported .md with its image served from the site folder', async () => {
    site = await createTestSite({ config })
    const res = await site.fetch('/page')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<h1>')
    expect(body).toContain('<table>')
    expect(body).toContain(img())
    const image = await site.fetch(src)
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    const resized = await site.fetch(variant)
    expect(resized.status).toBe(200)
    expect(resized.headers.get('content-type')).toBe('image/webp')
  })

  it('heading ids match markdownHeadings', async () => {
    site = await createTestSite({ config })
    const body = await (await site.fetch('/page-ids')).text()
    const headings = markdownHeadings(await readFile(join(fixture, 'page.md'), 'utf8'), { prefix: 'h-' })
    expect(headings.length).toBeGreaterThan(2)
    for (const { id } of headings) expect(body).toContain(`id="${id}"`)
  })

  it('the image is behind the site password', async () => {
    const { app, core } = await boot(sourceFromConfig(await loadConfig(config)))
    expect((await app.inject({ url: '/page' })).statusCode).toBe(200)
    expect((await app.inject({ url: src })).statusCode).toBe(200)
    await core.setSitePassword('letmein123', owner)
    await core.setSiteLock(true, owner)
    const res = await app.inject({ url: src })
    expect(res.statusCode).toBe(401)
    expect(res.headers['content-type']).toMatch(/^text\/html/)
  })

  it('from a release, with the site folder gone', async () => {
    const copy = join(scratch, 'site')
    const releaseDir = join(scratch, 'release')
    const out = join(scratch, 'site.tgz')
    await cp(fixture, copy, { recursive: true })
    await mkdir(releaseDir)
    const keys = generateKeyPair()
    await packRelease({ configFile: join(copy, 'inlay.config.ts'), privateKey: keys.privateKey, out, name: 'md-1' })
    const loaded = await readRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey] })
    await rm(copy, { recursive: true, force: true })

    const source = { site: loaded.site, publicDir: loaded.publicDir, shippedFiles: loaded.shippedFiles, codeFiles: loaded.codeFiles }
    const fresh = await boot(source)
    const image = await fresh.app.inject({ url: src })
    expect(image.statusCode).toBe(200)
    expect(image.headers['content-type']).toBe('image/png')

    const res = await fresh.app.inject({ url: '/page' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(img())
  })

  it('from a release, the same .md shows its image both as shipped rich text and through ctx.markdown', async () => {
    const copy = join(scratch, 'site')
    const releaseDir = join(scratch, 'release')
    const out = join(scratch, 'site.tgz')
    await cp(fixture, copy, { recursive: true })
    await mkdir(releaseDir)
    const keys = generateKeyPair()
    await packRelease({ configFile: join(copy, 'inlay.config.ts'), privateKey: keys.privateKey, out, name: 'md-1' })
    const loaded = await readRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey] })
    await rm(copy, { recursive: true, force: true })

    const { app, core } = await boot({ site: loaded.site, publicDir: loaded.publicDir, shippedFiles: loaded.shippedFiles, codeFiles: loaded.codeFiles })
    const sha = sha256(await readFile(join(fixture, 'pic.png')))
    const [note] = await core.listEntries('note')
    const doc = await core.getDocument(note!.id, { state: 'published' })
    const body = (doc!.data.fields as { body: { content: Array<{ content?: Array<{ type: string; attrs?: unknown }> }> } }).body
    const images = body.content.flatMap((b) => (b.content ?? []).filter((n) => n.type === 'image').map((n) => n.attrs))
    expect(images).toEqual([{ media: sha, alt: 'Pic' }])

    const shipped = await app.inject({ url: '/notes/field-notes' })
    expect(shipped.statusCode).toBe(200)
    expect(shipped.body).toContain(`/media/${sha}`)
    expect((await app.inject({ url: `/media/${sha}` })).statusCode).toBe(200)

    const page = await app.inject({ url: '/page' })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain(img())
    expect((await app.inject({ url: src })).statusCode).toBe(200)
  })

  describe('inlay:key links', () => {
    const fresh = async () => boot(sourceFromConfig(await loadConfig(config)))
    const links = async (app: FastifyInstance) => (await app.inject({ url: '/links' })).body

    it('links a live page and leaves an unknown key as plain text', async () => {
      const { app } = await fresh()
      const body = await links(app)
      expect(body).toContain('<a href="/pages/about">About</a>')
      expect(body).toContain('Gone')
      expect(body).not.toMatch(/<a[^>]*>Gone/)
    })

    it('shows an unpublished page as plain text', async () => {
      const { app, core } = await fresh()
      const [doc] = await core.listEntries('page')
      expect((await core.groupIdsByKey([{ type: 'page', key: 'about' }])).get('page/about')).toBe(doc!.groupId)
      await core.unpublish([doc!.id], owner)
      const body = await links(app)
      expect(body).toContain('About')
      expect(body).not.toContain('<a href="/pages/about">')
    })
  })

  it('answers with an error, not a page, for text that does not parse', async () => {
    site = await createTestSite({ config })
    const res = await site.fetch('/broken')
    expect(res.status).toBe(500)
    const body = await res.text()
    expect(body).toContain('Something went wrong')
    expect(body).not.toContain('<div>')
  })

  it('throws error.markdownRender with the line, once', async () => {
    const { core } = await boot(sourceFromConfig(await loadConfig(config)))
    const ctx = createRenderContext(core, { locale: 'en', state: 'published', page: 1, baseUrl: 'http://localhost', alternates: [] })
    const problem = t('richtext.unsupported', { line: 3, feature: t('richtext.feature.html') })
    await expect(ctx.markdown('ok\n\n<div>x</div>\n')).rejects.toMatchObject({
      messageId: 'error.markdownRender',
      params: { line: 3 },
      message: `This page's Markdown couldn't be shown. ${problem}`,
    })
  })

  it('throws for an image that is neither a media library image nor a file from an imported .md', async () => {
    const { core } = await boot(sourceFromConfig(await loadConfig(config)))
    const ctx = createRenderContext(core, { locale: 'en', state: 'published', page: 1, baseUrl: 'http://localhost', alternates: [] })
    for (const [text, src] of [
      ['![x](./a.png)', './a.png'],
      ['Hi\n\n![x](https://example.com/a.png)', 'https://example.com/a.png'],
      [`![x](${pathToFileURL(join(fixture, 'missing.png')).href})`, pathToFileURL(join(fixture, 'missing.png')).href],
    ] as const) {
      const line = text.startsWith('Hi') ? 3 : 1
      await expect(ctx.markdown(text), text).rejects.toMatchObject({
        messageId: 'error.markdownRenderImage',
        message: t('error.markdownRenderImage', { line, src }),
      })
    }
  })
})
