import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as tar from 'tar'
import { runCli } from '../../src/adapters/cli/main.js'
import { generateKeyPair } from '../../src/core/release/keys.js'
import { png } from '../fixtures/media.js'

const fixtures = resolve(import.meta.dirname, '../fixtures')

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inlay-pack-'))
  await cp(join(fixtures, 'release'), dir, { recursive: true })
  await mkdir(join(dir, 'assets'))
  await writeFile(join(dir, 'assets/pic.png'), await png(8, 8))
  await writeFile(join(dir, 'inlay.key'), generateKeyPair().privateKey)
})
afterEach(() => {
  delete process.env.INLAY_SIGNING_KEY
  return rm(dir, { recursive: true, force: true })
})

async function run(...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli(argv, { cwd: dir, out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('inlaycms pack', () => {
  it('pack with --key writes the tarball and prints its name', async () => {
    const r = await run('pack', '--key', 'inlay.key', '--name', 'r1')
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(existsSync(join(dir, 'r1.tgz'))).toBe(true)
    expect(r.out).toContain('r1')
    const names: string[] = []
    await tar.t({ file: join(dir, 'r1.tgz'), onReadEntry: (e) => names.push(e.path) })
    expect(names).toContain('site.js')
  })

  it('takes the key from INLAY_SIGNING_KEY and the file from --out', async () => {
    process.env.INLAY_SIGNING_KEY = join(dir, 'inlay.key')
    const r = await run('pack', '--out', 'out/site.tgz')
    expect(r.code).toBe(0)
    expect(existsSync(join(dir, 'out/site.tgz'))).toBe(true)
  })

  it('refuses an empty --name', async () => {
    const r = await run('pack', '--key', 'inlay.key', '--name', '')
    expect(r.code).toBe(2)
    expect(r.err).toContain('--name')
    expect(existsSync(join(dir, '.tgz'))).toBe(false)
  })

  it('pack without a key exits 2', async () => {
    delete process.env.INLAY_SIGNING_KEY
    const r = await run('pack')
    expect(r.code).toBe(2)
    expect(r.err).toContain('INLAY_SIGNING_KEY')
  })
})

describe('inlaycms pack public files', () => {
  it('pack refuses a public file that clashes with a root address', async () => {
    await writeFile(join(dir, 'public/robots.txt'), 'User-agent: *\n')
    const r = await run('pack', '--key', 'inlay.key', '--name', 'r1')
    expect(r.code).toBe(1)
    expect(r.out + r.err).toContain('public/robots.txt')
    expect(existsSync(join(dir, 'r1.tgz'))).toBe(false)
  })
})

describe('inlaycms pack type check', () => {
  // The site's own TypeScript, found as Node finds the package (no node_modules/.bin), and run with the running Node.
  beforeEach(async () => {
    await mkdir(join(dir, 'node_modules'))
    await symlink(resolve(import.meta.dirname, '../../node_modules/typescript'), join(dir, 'node_modules/typescript'), 'dir')
    const tsconfig = { compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ['checked.ts'] }
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig))
  })

  it('refuses a site with a type error', async () => {
    await writeFile(join(dir, 'checked.ts'), 'export const n: number = "not a number"\n')
    const r = await run('pack', '--key', 'inlay.key', '--name', 'r1')
    expect(r.code).toBe(1)
    expect(r.err).toContain('checked.ts')
    expect(r.err).toContain('type errors')
    expect(existsSync(join(dir, 'r1.tgz'))).toBe(false)
  })

  it('packs a site that type-checks', async () => {
    await writeFile(join(dir, 'checked.ts'), 'export const n: number = 1\n')
    const r = await run('pack', '--key', 'inlay.key', '--name', 'r1')
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
  })
})

describe('inlaycms check without a database', () => {
  it('check reports a built-in import as a problem and exits 1', async () => {
    const r = await run('check', '--config', join(fixtures, 'release-bad/inlay.config.ts'))
    expect(r.code).toBe(1)
    expect(r.out).toContain('node:fs')
  })

  it('check reports code that reaches for the server as a release_forbidden problem', async () => {
    await writeFile(join(dir, 'extra.ts'), 'export const x = process.env.X\n')
    await writeFile(join(dir, 'forbidden.config.ts'), "export * from './extra.js'\nexport { default } from './inlay.config.js'\n")
    const r = await run('check', '--json', '--config', 'forbidden.config.ts')
    expect(r.code).toBe(1)
    expect(JSON.parse(r.out).problems.map((p: { code: string }) => p.code)).toEqual(['release_forbidden'])
  })

  it('check passes a site that bundles', async () => {
    const r = await run('check')
    expect(r.code).toBe(0)
  })

  it('check reports a public file that clashes with a root address', async () => {
    await writeFile(join(dir, 'public/robots.txt'), 'User-agent: *\n')
    const r = await run('check', '--json')
    expect(r.code).not.toBe(0)
    const report = JSON.parse(r.out) as { problems: { code: string; message: string }[] }
    expect(report.problems).toContainEqual(expect.objectContaining({ code: 'public_clash', message: expect.stringContaining('public/robots.txt') }))
  })

  it('check refuses a definition error', async () => {
    await writeFile(
      join(dir, 'bad.config.ts'),
      [
        "import { defineConfig, defineSite } from 'inlaycms/site'",
        "import { site } from './site.js'",
        "export default defineConfig({ site: defineSite({ ...site, secrets: ['bad-name'] }) })",
      ].join('\n'),
    )
    const r = await run('check', '--config', 'bad.config.ts')
    expect(r.code).toBe(1)
    expect(r.err).toContain('bad-name')
  })

  it('check validates shipped content without a database', async () => {
    await writeFile(
      join(dir, 'bad.config.ts'),
      [
        "import { defineConfig, defineContent, defineSite } from 'inlaycms/site'",
        "import { site } from './site.js'",
        "const content = [defineContent('home', { edition: 1, content: { en: { fields: { title: 42 } } } })]",
        'export default defineConfig({ site: defineSite({ ...site, content }) })',
      ].join('\n'),
    )
    const r = await run('check', '--config', 'bad.config.ts')
    expect(r.code).toBe(1)
    expect(r.out).toContain('Home')
  })

  it('commands that need a database say so', async () => {
    const r = await run('backup')
    expect(r.code).toBe(2)
    expect(r.err).toContain('--db')
  })
})
