import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { packRelease } from '../src/core/release/pack.js'
import { readRelease } from '../src/core/release/read.js'

const example = resolve(import.meta.dirname, '../example')

describe('the example site as a release', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inlay-example-release-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('packs with the development key and reads back with its public key', async () => {
    const privateKey = await readFile(join(example, 'keys/dev.key'), 'utf8')
    const publicKey = (await readFile(join(example, 'keys/dev.pub'), 'utf8')).trim()
    const out = join(dir, 'example.tgz')
    await packRelease({ configFile: join(example, 'inlay.config.ts'), privateKey, out, name: 'example-test' })
    expect(existsSync(out)).toBe(true)

    const releaseDir = join(dir, 'release')
    await mkdir(releaseDir)
    const loaded = await readRelease(out, { dir: releaseDir, trustedKeys: [publicKey] })

    expect(loaded.site.routes.map((r) => `${r.method} ${r.path}`)).toContain('POST /contact')
    expect((loaded.manifest.integrations ?? []).map((i) => i.name)).toEqual(['visit-counter'])
    expect(loaded.site.integrations.map((i) => i.name)).toEqual(['visit-counter'])
    expect(existsSync(join(releaseDir, 'public/visits.js'))).toBe(true)
    expect(existsSync(join(releaseDir, 'public/consent-banner.js'))).toBe(true)
    expect(loaded.site.secrets).toContain('SLACK_WEBHOOK')
    expect(loaded.manifest.secrets).toContain('SLACK_WEBHOOK')
    expect(loaded.site.content.flatMap((c) => c.documents.map((d) => `${c.type}/${d.key}`))).toContain('home/home')

    const hero = pathToFileURL(join(example, 'assets/hero.jpg')).href
    const shipped = loaded.manifest.content.find((c) => c.source === hero)
    expect(shipped?.path).toMatch(/^content\/[0-9a-f]{64}\.jpg$/)
    expect(loaded.shippedFiles.get(hero)).toBe(join(releaseDir, shipped!.path))
    expect(existsSync(join(releaseDir, shipped!.path))).toBe(true)
    expect(loaded.publicDir).toBe(join(releaseDir, 'public'))

    const text = await readFile(join(releaseDir, 'site.js'), 'utf8')
    const specifiers = [...text.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)].map((m) => m[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      expect(['inlaycms/site', 'inlaycms/jsx-runtime', 'inlaycms/jsx-dev-runtime']).toContain(specifier)
    }
  })
})
