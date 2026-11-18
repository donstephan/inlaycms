import { randomBytes } from 'node:crypto'
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { createRenderContext } from '../../src/adapters/site/context.js'
import { loadConfig } from '../../src/config.js'
import type { Core } from '../../src/core/core.js'
import { InlayError } from '../../src/core/errors.js'
import type { CodeImage } from '../../src/core/registry/code-image.js'
import type { ResolvedImage } from '../../src/core/registry/render.js'
import { defineSingleton, defineSite, defineTemplate } from '../../src/core/registry/define.js'
import { f } from '../../src/core/fields/builtins.js'
import { generateKeyPair } from '../../src/core/release/keys.js'
import { packRelease } from '../../src/core/release/pack.js'
import { readRelease } from '../../src/core/release/read.js'
import type { Ctx, ImageValue } from '../../src/core/types.js'
import { createSiteApp, sourceFromConfig, type SiteSource } from '../../src/host/app.js'
import { ensureDataDir, readHostConfig } from '../../src/host/config.js'
import { createTestSite, type TestSite } from '../../src/testing.js'
import { z } from 'zod'
import { png, sha256 } from '../fixtures/media.js'
import { makeCore } from '../helpers/core.js'

const fixture = resolve(import.meta.dirname, '../fixtures/image-site')
const config = join(fixture, 'inlay.config.ts')
const owner: Ctx = { actor: { id: 'user-owner', name: 'Olivia Owner', role: 'owner' }, source: 'admin' }

let scratch: string
let site: TestSite | undefined
const apps: FastifyInstance[] = []
let sha: string

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'inlay-code-image-')))
  sha = sha256(await readFile(join(fixture, 'hero.jpg')))
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

const variant = (w: number) => `/media/files/${sha}/${w}.webp`

function expectHeroImg(body: string) {
  const img = /<img [^>]*>/.exec(body)?.[0] ?? ''
  const srcset = [320, 640, 960, 1280, 1920].map((w) => `${variant(w)} ${w}w`).join(', ')
  expect(img).toContain(`src="${variant(1280)}"`)
  expect(img).toContain(`srcset="${srcset}"`)
  expect(img).not.toContain('2560')
  expect(img).toContain('width="2000" height="1000" alt="A hero"')
}

describe('ctx.image for an imported image', () => {
  it('renders an imported image with variants', async () => {
    site = await createTestSite({ config })
    const res = await site.fetch('/')
    expect(res.status).toBe(200)
    expectHeroImg(await res.text())
    const made = await site.fetch(variant(1280))
    expect(made.status).toBe(200)
    expect(made.headers.get('content-type')).toBe('image/webp')
    const original = await site.fetch(`/media/files/${sha}.jpg`)
    expect(original.status).toBe(200)
    expect(original.headers.get('content-type')).toBe('image/jpeg')
  })

  it('the variant is behind the site password', async () => {
    const { app, core } = await boot(sourceFromConfig(await loadConfig(config)))
    expect((await app.inject({ url: '/' })).statusCode).toBe(200)
    expect((await app.inject({ url: variant(640) })).statusCode).toBe(200)
    await core.setSitePassword('letmein123', owner)
    await core.setSiteLock(true, owner)
    expect((await app.inject({ url: variant(640) })).statusCode).not.toBe(200)
    expect((await app.inject({ url: variant(320) })).statusCode).not.toBe(200)
  })

  it('from a release with the site folder gone', async () => {
    const copy = join(scratch, 'site')
    const releaseDir = join(scratch, 'release')
    const out = join(scratch, 'site.tgz')
    await cp(fixture, copy, { recursive: true })
    await mkdir(releaseDir)
    const keys = generateKeyPair()
    await packRelease({ configFile: join(copy, 'inlay.config.ts'), privateKey: keys.privateKey, out, name: 'img-1' })
    const loaded = await readRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey] })
    await rm(copy, { recursive: true, force: true })

    const { app } = await boot({ site: loaded.site, publicDir: loaded.publicDir, shippedFiles: loaded.shippedFiles, codeFiles: loaded.codeFiles })
    const made = await app.inject({ url: variant(960) })
    expect(made.statusCode).toBe(200)
    expect(made.headers['content-type']).toBe('image/webp')

    const res = await app.inject({ url: '/' })
    expect(res.statusCode).toBe(200)
    expectHeroImg(res.body)
  })

  it('a hand-built CodeImage naming a file outside the site folder never makes it servable', async () => {
    const { app, core } = await boot(sourceFromConfig(await loadConfig(config)))
    const outside = join(scratch, 'outside.jpg')
    await copyFile(join(fixture, 'hero.jpg'), outside)
    const fake = '0'.repeat(64)
    const ctx = createRenderContext(core, { locale: 'en', state: 'published', page: 1, baseUrl: 'http://localhost', alternates: [] })
    for (const source of ['file:///etc/passwd', pathToFileURL(outside).href]) {
      const v: CodeImage = { kind: 'codeImage', source, sha: fake, ext: '.jpg', mime: 'image/jpeg', width: 2000, height: 1000 }
      const img = ctx.image(v, { alt: 'x' })
      expect(img.url).toBe(`/media/files/${fake}.jpg`)
      expect((await app.inject({ url: img.url })).statusCode).toBe(404)
      expect((await app.inject({ url: img.src(640) })).statusCode).toBe(404)
    }
  })
})

describe('ctx.image for a library image', () => {
  it('opts.alt overrides a library image alt', async () => {
    const Holder = defineTemplate({
      name: 'holder',
      fields: z.object({ image: f.image({ label: 'Image' }) }),
      render: () => '',
    })
    const holder = defineSingleton({ name: 'holder', label: 'Holder', template: Holder, path: '/holder' })
    const { core, owner: who } = await makeCore({ site: defineSite({ locales: ['en'], defaultLocale: 'en', singletons: [holder] }), media: true })
    const media = (await core.addMedia({ data: await png(40, 20), filename: 'a.png' }, who)).media
    const v = { media: media.id, alt: 'Stored' }
    const ctx = createRenderContext(core, { locale: 'en', state: 'published', page: 1, baseUrl: 'http://localhost', alternates: [] })
    await ctx.preloadData(Holder, { fields: { image: v }, slots: {} })
    expect(ctx.image(v, { alt: 'Here' })!.alt).toBe('Here')
    expect(ctx.image(v, { alt: '' })!.alt).toBe('')
    expect(ctx.image(v)!.alt).toBe('Stored')
  })
})

describe('ctx.image for a value of either kind', () => {
  const hero: CodeImage = { kind: 'codeImage', source: 'file:///site/hero.jpg', sha: '0'.repeat(64), ext: '.jpg', mime: 'image/jpeg', width: 40, height: 20 }

  it('takes a value that may be an imported image, a library image or missing', async () => {
    const { core } = await makeCore()
    const ctx = createRenderContext(core, { locale: 'en', state: 'published', page: 1, baseUrl: 'http://localhost', alternates: [] })
    const maybe = hero as CodeImage | undefined
    const either = hero as CodeImage | ImageValue
    const nothing = undefined as CodeImage | ImageValue | null | undefined
    const a: ResolvedImage | null = ctx.image(maybe, { alt: 'A' })
    const b: ResolvedImage | null = ctx.image(either)
    const c: ResolvedImage | null = ctx.image(nothing)
    expect(a?.url).toBe(`/media/files/${hero.sha}.jpg`)
    expect(b?.alt).toBe('')
    expect(c).toBeNull()
  })

  it("refuses a value that isn't an image imported through Inlay", async () => {
    const { core } = await makeCore()
    const ctx = createRenderContext(core, { locale: 'en', state: 'published', page: 1, baseUrl: 'http://localhost', alternates: [] })
    const notImported = ['/assets/hero.4f2a.jpg', { kind: 'codeImage', source: hero.source }, { ...hero, width: '40' }]
    for (const v of notImported) {
      let thrown: unknown
      try {
        ctx.image(v as unknown as CodeImage)
      } catch (e) {
        thrown = e
      }
      expect(thrown, JSON.stringify(v)).toBeInstanceOf(InlayError)
      expect((thrown as InlayError).messageId).toBe('error.imageNotImported')
    }
  })
})
