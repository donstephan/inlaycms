import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as tar from 'tar'
import { createCore } from '../../src/core/core.js'
import { openDatabase } from '../../src/core/db/connection.js'
import { migrateSystem } from '../../src/core/db/migrate.js'
import { InlayError } from '../../src/core/errors.js'
import { fingerprint, generateKeyPair, sign } from '../../src/core/release/keys.js'
import { manifestOfRegistry, manifestSchema, satisfies, type ReleaseManifest } from '../../src/core/release/manifest.js'
import { packRelease } from '../../src/core/release/pack.js'
import { INLAY_ENTRIES, loadRelease, openRelease, readRelease } from '../../src/core/release/read.js'
import { buildRegistry } from '../../src/core/registry/registry.js'
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
  dir = await mkdtemp(join(tmpdir(), 'inlay-release-'))
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
      { from: '/g2', to: 'https://www.g2.com/products/realciso/reviews', status: 301 },
      { from: '/old-landing', to: '/', status: 302 },
      { from: '/2019/:slug', to: '/blog/:slug', status: 301 },
    ])
  })

  it('writes the same manifest a site running from source has, less its files', async () => {
    const { manifest } = await pack()
    const { config } = await loadConfig(join(siteDir, 'inlay.config.ts'))
    const now = new Date(manifest.createdAt)
    expect(manifestOfRegistry(buildRegistry(config.site), { name: 'test-1', now })).toEqual({ ...manifest, files: {}, content: [] })
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
    expect(names).toEqual(['index.js', 'jsx-dev-runtime.js', 'jsx-runtime.js', 'package.json', 'site.js'])
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
