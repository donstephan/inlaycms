import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as tar from 'tar'
import { createCore } from '../../src/core/core.js'
import { openDatabase } from '../../src/core/db/connection.js'
import { migrateSystem } from '../../src/core/db/migrate.js'
import { InlayError } from '../../src/core/errors.js'
import { bundleSite } from '../../src/core/release/bundle.js'
import { fingerprint, generateKeyPair, sign } from '../../src/core/release/keys.js'
import { manifestOfRegistry, manifestSchema, satisfies, type ReleaseManifest } from '../../src/core/release/manifest.js'
import { packRelease } from '../../src/core/release/pack.js'
import { INLAY_ENTRIES, loadRelease, openRelease, readRelease } from '../../src/core/release/read.js'
import { defineSite } from '../../src/core/registry/define.js'
import { defineIntegration } from '../../src/core/registry/integration.js'
import { defineRoute } from '../../src/core/registry/route.js'
import { buildRegistry } from '../../src/core/registry/registry.js'
import { t } from '../../src/core/messages/index.js'
import { inlayVersion } from '../../src/core/version.js'
import { loadConfig } from '../../src/config.js'
import { redirectSite } from '../fixtures/code-redirects.js'
import { png, sha256 } from '../fixtures/media.js'

const fixtures = resolve(import.meta.dirname, '../fixtures')

async function rejection(p: Promise<unknown>): Promise<InlayError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(InlayError)
    return e as InlayError
  }
  throw new Error('expected a rejection')
}

async function entries(file: string): Promise<string[]> {
  const names: string[] = []
  await tar.t({ file, onReadEntry: (e) => names.push(e.path) })
  return names
}

/** Unpacks `file`, lets `change` edit the files, and packs them back up. */
async function repack(file: string, change: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'inlay-repack-'))
  try {
    await tar.x({ file, cwd: dir })
    await change(dir)
    await tar.c({ gzip: true, cwd: dir, portable: true, file }, await readdir(dir))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

let dir: string
let siteDir: string
let releaseDir: string
let keys: { privateKey: string; publicKey: string }
let pic: Buffer
let out: string

beforeEach(async () => {
  // The real path: a site's folder is named with every link followed, and the temp dir may sit under one.
  dir = await realpath(await mkdtemp(join(tmpdir(), 'inlay-release-')))
  siteDir = join(dir, 'site')
  releaseDir = join(dir, 'release')
  await cp(join(fixtures, 'release'), siteDir, { recursive: true })
  await mkdir(join(siteDir, 'assets'))
  pic = await png(20, 10)
  await writeFile(join(siteDir, 'assets/pic.png'), pic)
  await mkdir(releaseDir)
  keys = generateKeyPair()
  out = join(dir, 'site.tgz')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const pack = () => packRelease({ configFile: join(siteDir, 'inlay.config.ts'), privateKey: keys.privateKey, out, name: 'test-1' })

describe('packRelease', () => {
  it('packs manifest, signature, bundle, content and public', async () => {
    const { manifest } = await pack()
    expect(existsSync(out)).toBe(true)
    const names = await entries(out)
    const image = `content/${sha256(pic)}.png`
    expect(names).toEqual(expect.arrayContaining(['manifest.json', 'manifest.sig', 'site.js', image, 'public/site.css']))
    expect(Object.keys(manifest.files).sort()).toEqual(['public/site.css', 'site.js', image].sort())
    expect(manifest.files[image]).toBe(sha256(pic))
    expect(manifest.content).toEqual([
      { source: pathToFileURL(join(siteDir, 'assets/pic.png')).href, path: image },
    ])
    expect(manifest.inlay.range).toBe('^' + inlayVersion())
    expect(manifest.inlay.version).toBe(inlayVersion())
    expect(manifest.secrets).toEqual(['HOOK'])
    expect(manifest.name).toBe('test-1')
    expect(manifest.format).toBe(1)
    expect(Object.keys(manifest.schema)).toEqual(['home'])
    expect(manifest.schema.home).toMatchObject({
      type: 'object',
      properties: { fields: { properties: { title: { title: 'Title' }, picture: { title: 'Picture' } } } },
    })
    expect(manifest.locales).toEqual(['en'])
    expect(manifest.types).toEqual({ home: { kind: 'singleton', slots: [] } })
    expect(manifest.routes).toEqual([{ method: 'GET', path: '/ping' }])
    expect(manifest.migrations).toEqual([])
    expect(manifest.redirects).toEqual([])
    // Files are hashed as the release keeps them, so the hash follows their bytes, not where the site sits.
    const canonical = JSON.stringify({ fields: { picture: { alt: 'A picture', file: image }, title: 'Hello' } })
    expect(manifest.shipped).toEqual([
      { type: 'home', key: 'home', edition: 1, locales: { en: createHash('sha256').update(canonical).digest('hex') } },
    ])
  })

  it('reads a manifest without redirects, as releases before 0.3 have', async () => {
    const { manifest } = await pack()
    const { redirects: _redirects, ...old } = manifest
    expect(manifestSchema.parse(old).redirects).toBeUndefined()
  })

  it("lists the site's code redirects in stored form", () => {
    const manifest = manifestOfRegistry(buildRegistry(redirectSite), { name: 'x', now: new Date(Date.UTC(2026, 10, 4)) })
    expect(manifest.redirects).toEqual([
      { from: '/old-post', to: '/blog', status: 301 },
      { from: '/g2', to: 'https://www.g2.com/products/example/reviews', status: 301 },
      { from: '/old-landing', to: '/', status: 302 },
      { from: '/2019/:slug', to: '/blog/:slug', status: 301 },
    ])
  })

  it('lists the site csp and its integrations, only when it has them', () => {
    const now = new Date(Date.UTC(2026, 10, 4))
    const site = defineSite({
      locales: ['en'],
      defaultLocale: 'en',
      csp: { 'img-src': ['https://i.example'] },
      integrations: [
        defineIntegration({ name: 'gtm', label: 'Tag Manager', consent: 'marketing', csp: { 'script-src': ['https://t.example'] }, head: () => '' }),
        defineIntegration({ name: 'chat', label: 'Chat', head: () => '' }),
      ],
    })
    const manifest = manifestOfRegistry(buildRegistry(site), { name: 'x', now })
    expect(manifest.csp).toEqual({ 'img-src': ['https://i.example'] })
    expect(manifest.integrations).toEqual([
      { name: 'gtm', label: 'Tag Manager', consent: 'marketing', csp: { 'script-src': ['https://t.example'] } },
      { name: 'chat', label: 'Chat' },
    ])
    expect(manifestSchema.parse(manifest)).toEqual(manifest)
    const plain = manifestOfRegistry(buildRegistry(defineSite({ locales: ['en'], defaultLocale: 'en' })), { name: 'x', now })
    expect(plain).not.toHaveProperty('csp')
    expect(plain).not.toHaveProperty('integrations')
    expect(manifestSchema.parse(plain)).toEqual(plain)
  })

  it('a release names the site folder it was packed from, and loading from source names it too', async () => {
    await pack()
    const loaded = await readRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey] })
    const expected = pathToFileURL(siteDir).href + '/'
    expect(loaded.site.siteDir).toBe(expected)
    expect(buildRegistry(loaded.site).siteDir).toBe(expected)
    expect((await loadConfig(join(siteDir, 'inlay.config.ts'))).config.site.siteDir).toBe(expected)
  })

  it('writes the same manifest a site running from source has, less its files', async () => {
    const { manifest } = await pack()
    const { config } = await loadConfig(join(siteDir, 'inlay.config.ts'))
    const now = new Date(manifest.createdAt)
    expect(manifestOfRegistry(buildRegistry(config.site), { name: 'test-1', now })).toEqual({ ...manifest, files: {}, content: [] })
  })

  it('marks sitemap routes in the manifest', () => {
    const site = defineSite({
      locales: ['en'],
      defaultLocale: 'en',
      routes: [
        defineRoute({ method: 'GET', path: '/calc', sitemap: true, handler: () => ({}) }),
        defineRoute({ method: 'POST', path: '/contact', handler: () => ({}) }),
      ],
    })
    const manifest = manifestOfRegistry(buildRegistry(site), { name: 'x', now: new Date(Date.UTC(2026, 10, 4)) })
    expect(manifest.routes).toEqual([{ method: 'GET', path: '/calc', sitemap: true }, { method: 'POST', path: '/contact' }])
    expect(manifest.routes[1]).not.toHaveProperty('sitemap')
    expect(manifestSchema.parse(manifest).routes).toEqual(manifest.routes)
    expect(manifestSchema.safeParse({ ...manifest, routes: [{ method: 'GET', path: '/calc', sitemap: false }] }).success).toBe(false)
  })

  it('site.js imports only the allow-list', async () => {
    await pack()
    await tar.x({ file: out, cwd: releaseDir })
    const text = await readFile(join(releaseDir, 'site.js'), 'utf8')
    const specifiers = [...text.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)].map((m) => m[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) expect(['inlaycms/site', 'inlaycms/jsx-runtime']).toContain(specifier)
  })

  it('refuses a site that imports a node built-in', async () => {
    const e = await rejection(
      packRelease({ configFile: join(fixtures, 'release-bad/inlay.config.ts'), privateKey: keys.privateKey, out }),
    )
    expect(e.code).toBe('release')
    expect(e.messageId).toBe('error.packImport')
    expect(e.message).toContain('node:fs')
    expect(existsSync(out)).toBe(false)
  })

  describe('refuses code that reaches for the server', () => {
    const cases: Array<[string, string, string, Record<string, string>]> = [
      ['process.getBuiltinModule', "export const fs = process.getBuiltinModule('node:fs')", 'error.packForbidden', { what: 'process' }],
      ['a computed import()', "const name = 'node:' + ['f', 's'].join('')\nexport const fs = import(name)", 'error.packForbidden', { what: 'import()' }],
      ['an import() of a built-in by concatenation', "export const fs = import('node:' + 'fs')", 'error.packImport', { specifier: 'node:fs' }],
      ['process.env', 'export const x = process.env.X', 'error.packForbidden', { what: 'process' }],
      ['inlaycms itself', "export { openDatabase } from 'inlaycms'", 'error.packImport', { specifier: 'inlaycms' }],
      ['inlaycms/testing', "export { createTestSite } from 'inlaycms/testing'", 'error.packImport', { specifier: 'inlaycms/testing' }],
      ['eval', "export const run = (s: string) => eval(s)", 'error.packForbidden', { what: 'eval' }],
      ['globalThis.Function', "export const f = globalThis.Function('x')", 'error.packForbidden', { what: 'globalThis.Function' }],
      ['global.eval', "export const run = (s: string) => global.eval(s)", 'error.packForbidden', { what: 'global.eval' }],
    ]
    for (const [name, code, messageId, params] of cases) {
      it(name, async () => {
        await writeFile(join(siteDir, 'extra.ts'), code + '\n')
        const config = join(siteDir, 'inlay.config.ts')
        await writeFile(config, `export * from './extra.js'\n` + (await readFile(config, 'utf8')))
        const e = await rejection(pack())
        expect(e.code).toBe('release')
        expect(e.messageId).toBe(messageId)
        expect(e.params).toMatchObject(params)
        expect(existsSync(out)).toBe(false)
      })
    }

    it('lets an import() of a template under a relative folder through', async () => {
      await mkdir(join(siteDir, 'locales'))
      await writeFile(join(siteDir, 'locales/en.js'), "export const hello = 'Hello'\n")
      await writeFile(join(siteDir, 'locales/fr.js'), "export const hello = 'Bonjour'\n")
      await writeFile(join(siteDir, 'extra.ts'), 'export const words = (l: string) => import(`./locales/${l}.js`)\n')
      const config = join(siteDir, 'inlay.config.ts')
      await writeFile(config, `export * from './extra.js'\n` + (await readFile(config, 'utf8')))
      await pack()
      await tar.x({ file: out, cwd: releaseDir })
      const text = await readFile(join(releaseDir, 'site.js'), 'utf8')
      expect(text).toContain('Bonjour')
    })

    it('leaves installed packages alone', async () => {
      await mkdir(join(siteDir, 'node_modules/helper'), { recursive: true })
      await writeFile(join(siteDir, 'node_modules/helper/package.json'), '{"name":"helper","type":"module","main":"index.js"}')
      await writeFile(join(siteDir, 'node_modules/helper/index.js'), 'export const F = Function\n')
      await writeFile(join(siteDir, 'extra.ts'), "export { F } from 'helper'\n")
      const config = join(siteDir, 'inlay.config.ts')
      await writeFile(config, `export * from './extra.js'\n` + (await readFile(config, 'utf8')))
      await pack()
      expect(existsSync(out)).toBe(true)
    })

    it('lets a local variable, a property or a string of the same name through', async () => {
      await writeFile(
        join(siteDir, 'extra.ts'),
        [
          'export const words = "process, require(x), eval and import(name) are only words here; so is import.meta.url"',
          'export const holder = { process: 1, require: 2 }',
          'export function f(process: { x: number }) { return process.x }',
          "export const mode = process.env.NODE_ENV",
        ].join('\n') + '\n',
      )
      const config = join(siteDir, 'inlay.config.ts')
      await writeFile(config, `export * from './extra.js'\n` + (await readFile(config, 'utf8')))
      await pack()
      await tar.x({ file: out, cwd: releaseDir })
      const text = await readFile(join(releaseDir, 'site.js'), 'utf8')
      expect(text).toContain('so is import.meta.url')
      expect(text).toContain('"production"')
    })
  })

  it('refuses a missing shipped file', async () => {
    await rm(join(siteDir, 'assets/pic.png'))
    const e = await rejection(pack())
    expect(e.messageId).toBe('error.packFile')
  })

  describe('images named in shipped markdown', () => {
    /** Writes the site's `content.ts` with `body` (a TypeScript expression) as the home page's body. */
    const writeBody = (at: string, body: string) =>
      writeFile(
        join(at, 'content.ts'),
        [
          "import { defineContent } from 'inlaycms/site'",
          '',
          'export const content = [',
          "  defineContent('home', {",
          '    edition: 1,',
          '    content: {',
          '      en: {',
          '        fields: {',
          "          title: 'Hello',",
          "          picture: { file: new URL('./assets/pic.png', import.meta.url), alt: 'A picture' },",
          `          body: ${body},`,
          '        },',
          '      },',
          '    },',
          '  }),',
          ']',
          '',
        ].join('\n'),
      )

    it('packs an image named by a relative path in shipped markdown, and applies it with the site folder gone', async () => {
      await writeBody(siteDir, "'![Pic](assets/pic.png)'")
      const { manifest } = await pack()
      const image = `content/${sha256(pic)}.png`
      expect(manifest.content).toEqual([{ source: pathToFileURL(join(siteDir, 'assets/pic.png')).href, path: image }])

      const loaded = await readRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey] })
      await rm(siteDir, { recursive: true, force: true })
      const media = await mkdtemp(join(tmpdir(), 'inlay-release-media-'))
      const db = openDatabase(':memory:')
      try {
        await migrateSystem(db)
        const core = createCore({ site: loaded.site, db, media, shippedFiles: loaded.shippedFiles })
        await core.applyShippedContent()
        const home = await core.findSingleton('home', 'en')
        const doc = await core.getDocument(home!.id, { state: 'published' })
        const body = (doc!.data.fields as { body: { content: Array<{ content?: Array<{ type: string; attrs?: unknown }> }> } }).body
        const images = body.content.flatMap((b) => (b.content ?? []).filter((n) => n.type === 'image').map((n) => n.attrs))
        expect(images).toEqual([{ media: sha256(pic), alt: 'Pic' }])
      } finally {
        await db.destroy()
        await rm(media, { recursive: true, force: true })
      }
    })

    it('names an image only markdown names, written three ways, in one manifest.content entry', async () => {
      const shot = await png(8, 4)
      await writeFile(join(siteDir, 'assets/shot.png'), shot)
      await writeBody(
        siteDir,
        "`![a](assets/shot.png) ![b](./assets/shot.png) ![c](${new URL('./assets/shot.png', import.meta.url)})`",
      )
      const { manifest } = await pack()
      const image = `content/${sha256(pic)}.png`
      const shotImage = `content/${sha256(shot)}.png`
      expect(manifest.content).toEqual([
        { source: pathToFileURL(join(siteDir, 'assets/pic.png')).href, path: image },
        { source: pathToFileURL(join(siteDir, 'assets/shot.png')).href, path: shotImage },
      ])
      expect(Object.keys(manifest.files).sort()).toEqual(['public/site.css', 'site.js', image, shotImage].sort())
    })

    it('leaves an image outside the site folder out of the release', async () => {
      const outside = await png(5, 5)
      await writeFile(join(dir, 'outside.png'), outside)
      await writeBody(siteDir, "'![x](../outside.png)'")
      const { manifest } = await pack()
      expect(manifest.content.map((c) => c.source)).toEqual([pathToFileURL(join(siteDir, 'assets/pic.png')).href])
      expect(JSON.stringify(manifest.content)).not.toContain('outside')
      expect(Object.keys(manifest.files)).not.toContain(`content/${sha256(outside)}.png`)
      expect(Object.values(manifest.files)).not.toContain(sha256(outside))
    })

    it('hashes shipped markdown the same wherever the site sits', async () => {
      const body = "`![Pic](${new URL('./assets/pic.png', import.meta.url)})`"
      await writeBody(siteDir, body)
      const other = join(dir, 'elsewhere', 'site')
      await cp(siteDir, other, { recursive: true })
      const first = await pack()
      const second = await packRelease({
        configFile: join(other, 'inlay.config.ts'),
        privateKey: keys.privateKey,
        out: join(dir, 'other.tgz'),
        name: 'test-1',
      })
      expect(first.manifest.content[0]!.source).not.toBe(second.manifest.content[0]!.source)
      expect(second.manifest.shipped).toEqual(first.manifest.shipped)
    })

    it("hashes an image named by a relative path by its bytes, so replacing them changes the document's hash", async () => {
      await writeBody(siteDir, "'Intro ![Chart](assets/chart.png) and `![a](assets/chart.png)` in code'")
      await writeFile(join(siteDir, 'assets/chart.png'), await png(8, 4))
      const first = await pack()
      await writeFile(join(siteDir, 'assets/chart.png'), await png(9, 4))
      const second = await packRelease({
        configFile: join(siteDir, 'inlay.config.ts'),
        privateKey: keys.privateKey,
        out: join(dir, 'other.tgz'),
        name: 'test-1',
      })
      expect(second.manifest.shipped).not.toEqual(first.manifest.shipped)
    })
  })

  describe('.md imports', () => {
    /** Writes `posts/hello.md` with `markdown`, and a `content.ts` that imports it as the home page's body. */
    const writePost = async (markdown: string) => {
      await mkdir(join(siteDir, 'posts'), { recursive: true })
      await writeFile(join(siteDir, 'posts/hello.md'), markdown)
      await writeFile(
        join(siteDir, 'content.ts'),
        [
          "import { defineContent } from 'inlaycms/site'",
          "import hello from './posts/hello.md'",
          '',
          'export const content = [',
          "  defineContent('home', {",
          '    edition: 1,',
          '    content: {',
          '      en: {',
          '        fields: {',
          "          title: 'Hello',",
          "          picture: { file: new URL('./assets/pic.png', import.meta.url), alt: 'A picture' },",
          '          body: hello,',
          '        },',
          '      },',
          '    },',
          '  }),',
          ']',
          '',
        ].join('\n'),
      )
    }

    /** Applies shipped content to a fresh database for `site`, and gives back the home page's body. */
    const appliedBody = async (site: Parameters<typeof createCore>[0]['site'], shippedFiles?: ReadonlyMap<string, string>) => {
      const media = await mkdtemp(join(tmpdir(), 'inlay-release-media-'))
      const db = openDatabase(':memory:')
      try {
        await migrateSystem(db)
        const core = createCore({ site, db, media, ...(shippedFiles ? { shippedFiles } : {}) })
        await core.applyShippedContent()
        const home = await core.findSingleton('home', 'en')
        const doc = await core.getDocument(home!.id, { state: 'published' })
        return (doc!.data.fields as { body: { content: Array<{ type: string; content?: Array<{ type: string; text?: string; attrs?: unknown }> }> } }).body
      } finally {
        await db.destroy()
        await rm(media, { recursive: true, force: true })
      }
    }

    it('packs a .md import as a string, with an image beside it', async () => {
      const beside = await png(6, 3)
      await writePost('Hello **there**.\n\n![Pic](./pic.png)\n')
      await writeFile(join(siteDir, 'posts/pic.png'), beside)
      const { manifest } = await pack()
      expect(manifest.content.map((c) => c.source)).toContain(pathToFileURL(join(siteDir, 'posts/pic.png')).href)

      const loaded = await readRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey] })
      await rm(siteDir, { recursive: true, force: true })
      const body = await appliedBody(loaded.site, loaded.shippedFiles)
      expect(body.content[0]!.content!.map((n) => n.text)).toEqual(['Hello ', 'there', '.'])
      const images = body.content.flatMap((b) => (b.content ?? []).filter((n) => n.type === 'image').map((n) => n.attrs))
      expect(images).toEqual([{ media: sha256(beside), alt: 'Pic' }])
    })

    it('refuses a .md image that leaves the site folder', async () => {
      await writeFile(join(dir, 'outside.png'), await png(5, 5))
      await writePost('![x](../../outside.png)\n')
      const { config } = await loadConfig(join(siteDir, 'inlay.config.ts'))
      const e = await rejection(appliedBody(config.site))
      const issues = e.details.issues as Array<{ message: string }>
      expect(issues.map((i) => i.message)).toEqual([
        t('issue.shippedImageOutside', { field: 'Body', line: 1, src: pathToFileURL(join(dir, 'outside.png')).href }),
      ])
    })

    it('applies and packs images in a site loaded through a symlink to its folder', async () => {
      const beside = await png(6, 3)
      const shot = await png(8, 4)
      await writePost('Hello.\n\n![Pic](./pic.png)\n')
      await writeFile(join(siteDir, 'posts/pic.png'), beside)
      await writeFile(join(siteDir, 'assets/shot.png'), shot)
      const content = await readFile(join(siteDir, 'content.ts'), 'utf8')
      await writeFile(
        join(siteDir, 'content.ts'),
        content.replace(
          'body: hello,',
          "body: `${hello}\n\n![Shot](${new URL('./assets/shot.png', import.meta.url)})`,",
        ),
      )
      const link = join(dir, 'link')
      await symlink(siteDir, link)
      const config = join(link, 'inlay.config.ts')

      const loaded = await loadConfig(config)
      expect(loaded.config.site.siteDir).toBe(pathToFileURL(siteDir).href + '/')
      const body = await appliedBody(loaded.config.site)
      const images = body.content.flatMap((b) => (b.content ?? []).filter((n) => n.type === 'image').map((n) => n.attrs))
      expect(images).toEqual([
        { media: sha256(beside), alt: 'Pic' },
        { media: sha256(shot), alt: 'Shot' },
      ])

      const { manifest } = await packRelease({ configFile: config, privateKey: keys.privateKey, out, name: 'test-1' })
      expect(manifest.content.map((c) => c.source)).toEqual(
        expect.arrayContaining([
          pathToFileURL(join(siteDir, 'posts/pic.png')).href,
          pathToFileURL(join(siteDir, 'assets/shot.png')).href,
        ]),
      )
      const released = await readRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey] })
      expect(released.site.siteDir).toBe(pathToFileURL(siteDir).href + '/')
    })

    it("refuses a .md image whose place in the file can't be found, naming the file and line", async () => {
      await writePost('Hi\n\nA\0 ![Pic](./pic.png)\n')
      const loading = await rejection(loadConfig(join(siteDir, 'inlay.config.ts')))
      expect(loading.message).toContain(t('error.markdownImageUnplaced', { file: 'posts/hello.md', line: 3 }))
    })

    it('refuses a reference-style image in a .md file, naming the file and line', async () => {
      await writePost('Hi\n\n![Pic][pic]\n\n[pic]: ./pic.png\n')
      const text = t('error.markdownImageReference', { file: 'posts/hello.md', line: 3 })
      const loading = await rejection(loadConfig(join(siteDir, 'inlay.config.ts')))
      expect(loading.message).toContain(text)
      // pack loads the config first, so it stops where loading does; bundling the release on its own says the same.
      expect((await rejection(pack())).message).toContain(text)
      const bundling = await rejection(bundleSite(join(siteDir, 'inlay.config.ts'), join(dir, 'site.js')))
      expect(bundling.messageId).toBe('error.packBundle')
      expect(bundling.message).toContain(text)
    })
  })
})

describe('readRelease', () => {
  it('reads a release back', async () => {
    const { manifest } = await pack()
    const loaded = await readRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey] })
    expect(loaded.manifest).toEqual(manifest)
    expect(loaded.signedBy).toBe(fingerprint(keys.publicKey))
    expect(loaded.site.locales).toEqual(['en'])
    expect(loaded.site.secrets).toEqual(['HOOK'])
    expect(loaded.site.routes.map((r) => r.path)).toEqual(['/ping'])
    const source = pathToFileURL(join(siteDir, 'assets/pic.png')).href
    expect(loaded.shippedFiles.get(source)).toBe(join(releaseDir, `content/${sha256(pic)}.png`))
    expect(loaded.publicDir).toBe(join(releaseDir, 'public'))
    expect(await readFile(join(releaseDir, 'public/site.css'), 'utf8')).toContain('color')
  })

  it('refuses an untrusted signature before reading anything', async () => {
    await pack()
    const load = vi.fn()
    const e = await rejection(readRelease(out, { dir: releaseDir, trustedKeys: [generateKeyPair().publicKey], load }))
    expect(e.code).toBe('release')
    expect(e.messageId).toBe('error.releaseSignature')
    expect(await readdir(releaseDir)).toEqual([])
    expect(load).not.toHaveBeenCalled()
    await openRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey] })
    expect(await readdir(releaseDir)).toEqual(expect.arrayContaining(['manifest.json', 'site.js']))
  })

  it('refuses a folder that does not exist', async () => {
    await pack()
    const missing = join(dir, 'missing')
    const e = await rejection(openRelease(out, { dir: missing, trustedKeys: [keys.publicKey] }))
    expect(e.code).toBe('release')
    expect(e.messageId).toBe('error.releaseDirMissing')
    expect(e.params).toEqual({ dir: missing })
  })

  it('refuses a tampered file before loading it', async () => {
    await pack()
    await repack(out, (d) => writeFile(join(d, 'site.js'), 'export default {}\n'))
    const load = vi.fn()
    const e = await rejection(readRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey], load }))
    expect(e.messageId).toBe('error.releaseChecksum')
    expect(e.params.path).toBe('site.js')
    expect(load).not.toHaveBeenCalled()
  })

  it('refuses a file the manifest does not list', async () => {
    await pack()
    await repack(out, (d) => writeFile(join(d, 'public/extra.css'), 'x'))
    const load = vi.fn()
    const e = await rejection(readRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey], load }))
    expect(e.messageId).toBe('error.releaseInvalid')
    expect(load).not.toHaveBeenCalled()
  })

  it('refuses a release built for another version', async () => {
    await pack()
    await repack(out, async (d) => {
      const manifest = JSON.parse(await readFile(join(d, 'manifest.json'), 'utf8')) as ReleaseManifest
      manifest.inlay.range = '^99.0.0'
      const bytes = Buffer.from(JSON.stringify(manifest, null, 2))
      await writeFile(join(d, 'manifest.json'), bytes)
      await writeFile(join(d, 'manifest.sig'), sign(keys.privateKey, bytes))
    })
    const e = await rejection(readRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey] }))
    expect(e.messageId).toBe('error.releaseVersion')
    expect(e.params).toEqual({ range: '^99.0.0', need: '99.0.0', series: '99.x', version: inlayVersion() })
    expect(e.message).toBe(`This release needs Inlay 99.0.0 or a later 99.x version, but this server runs Inlay ${inlayVersion()}.`)
  })

  it('opens without loading, and loads after opening', async () => {
    const { manifest } = await pack()
    const load = vi.fn()
    const opened = await openRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey] })
    expect(opened).toEqual({ manifest, signedBy: fingerprint(keys.publicKey) })
    expect(load).not.toHaveBeenCalled()
    expect(existsSync(join(releaseDir, 'site.js'))).toBe(true)
    expect(existsSync(join(releaseDir, 'node_modules'))).toBe(false)
    const loaded = await loadRelease(releaseDir)
    expect(loaded.manifest).toEqual(manifest)
    expect(loaded.site.routes.map((r) => r.path)).toEqual(['/ping'])
  })

  it('points the release at the running inlaycms', async () => {
    await pack()
    await openRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey] })
    await loadRelease(releaseDir)
    const shim = join(releaseDir, 'node_modules/inlaycms')
    const require = createRequire(join(releaseDir, 'site.js'))
    for (const [specifier, file] of Object.entries(INLAY_ENTRIES)) {
      expect(existsSync(file), specifier).toBe(true)
      const target = require.resolve(specifier)
      expect(target.startsWith(shim), specifier).toBe(true)
      expect(await readFile(target, 'utf8')).toContain(`export * from ${JSON.stringify(pathToFileURL(file).href)}`)
    }
    expect(INLAY_ENTRIES.inlaycms).toBe(resolve(import.meta.dirname, '../../src/index.ts'))
  })

  it('leaves a shim that is already right alone, and replaces one that is not', async () => {
    await pack()
    await openRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey] })
    await loadRelease(releaseDir)
    const shim = join(releaseDir, 'node_modules/inlaycms')
    const index = join(shim, 'index.js')
    const before = (await stat(index)).ino
    await loadRelease(releaseDir)
    expect((await stat(index)).ino).toBe(before)

    await writeFile(index, 'export {}\n')
    await loadRelease(releaseDir)
    expect(await readFile(index, 'utf8')).toContain(JSON.stringify(pathToFileURL(INLAY_ENTRIES.inlaycms!).href))
    expect((await readdir(join(releaseDir, 'node_modules'))).sort()).toEqual(['inlaycms'])
  })

  it('concurrent loads repair a shim file by file, never leaving one missing or a temporary file behind', async () => {
    await pack()
    await openRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey] })
    await loadRelease(releaseDir)
    const shim = join(releaseDir, 'node_modules/inlaycms')
    const names = (await readdir(shim)).sort()
    expect(names).toEqual(['index.js', 'jsx-dev-runtime.js', 'jsx-runtime.js', 'package.json', 'site.js', 'testing.js'])
    const right = await readFile(join(shim, 'index.js'), 'utf8')
    await writeFile(join(shim, 'index.js'), 'export {}\n')
    await rm(join(shim, 'site.js'))
    await Promise.all([loadRelease(releaseDir), loadRelease(releaseDir), loadRelease(releaseDir)])
    expect((await readdir(shim)).sort()).toEqual(names)
    expect(await readFile(join(shim, 'index.js'), 'utf8')).toBe(right)
    expect((await readdir(releaseDir)).filter((n) => n.includes('.tmp'))).toEqual([])
  })

  it('refuses a site that asks for other secrets than the manifest lists', async () => {
    await pack()
    await repack(out, async (d) => {
      const manifest = JSON.parse(await readFile(join(d, 'manifest.json'), 'utf8')) as ReleaseManifest
      manifest.secrets = []
      const bytes = Buffer.from(JSON.stringify(manifest, null, 2))
      await writeFile(join(d, 'manifest.json'), bytes)
      await writeFile(join(d, 'manifest.sig'), sign(keys.privateKey, bytes))
    })
    await openRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey] })
    const e = await rejection(loadRelease(releaseDir))
    expect(e.messageId).toBe('error.releaseSecretsMismatch')
    expect(e.params).toEqual({ manifest: '-', site: 'HOOK' })
  })

  it('refuses a folder that is not empty', async () => {
    await pack()
    await writeFile(join(releaseDir, 'left-over'), 'x')
    const e = await rejection(openRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey] }))
    expect(e.messageId).toBe('error.releaseDirNotEmpty')
  })

  it('refuses an oversized manifest before checking the signature', async () => {
    await pack()
    await repack(out, (d) => writeFile(join(d, 'manifest.json'), Buffer.alloc(1024 ** 2 + 1, 0x20)))
    const e = await rejection(openRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey] }))
    expect(e.messageId).toBe('error.releaseInvalid')
  })

  it('refuses a site.js without a site', async () => {
    await pack()
    await openRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey] })
    const e = await rejection(loadRelease(releaseDir, { load: async () => ({ default: {} }) }))
    expect(e.messageId).toBe('error.releaseNoSite')
  })

  it('applies shipped content from a loaded release', async () => {
    await pack()
    const loaded = await readRelease(out, { dir: releaseDir, trustedKeys: [keys.publicKey] })
    // The source files are gone: only the release's copies can be read.
    await rm(siteDir, { recursive: true, force: true })
    const media = await mkdtemp(join(tmpdir(), 'inlay-release-media-'))
    const db = openDatabase(':memory:')
    try {
      await migrateSystem(db)
      const core = createCore({ site: loaded.site, db, media, shippedFiles: loaded.shippedFiles })
      await core.applyShippedContent()
      const home = await core.findSingleton('home', 'en')
      const doc = await core.getDocument(home!.id, { state: 'published' })
      expect((doc!.data.fields as { picture: unknown }).picture).toEqual({ media: sha256(pic), alt: 'A picture' })
      expect(createHash('sha256').update(await readFile(join(loaded.dir, loaded.manifest.content[0]!.path))).digest('hex')).toBe(
        sha256(pic),
      )
    } finally {
      await db.destroy()
      await rm(media, { recursive: true, force: true })
    }
  })
})

describe('satisfies', () => {
  it('reads caret ranges', () => {
    expect(satisfies('0.3.5', '^0.3.1')).toBe(true)
    expect(satisfies('0.3.0', '^0.3.1')).toBe(false)
    expect(satisfies('0.4.0', '^0.3.1')).toBe(false)
    expect(satisfies('1.9.9', '^1.2.0')).toBe(true)
    expect(satisfies('1.1.9', '^1.2.0')).toBe(false)
    expect(satisfies('2.0.0', '^1.2.0')).toBe(false)
    expect(satisfies('1.2.0', '1.2.0')).toBe(false)
  })
})
