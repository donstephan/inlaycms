import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as tar from 'tar'
import { runCli } from '../../src/adapters/cli/main.js'
import { bootInlay } from '../../src/core/boot.js'
import { t } from '../../src/core/messages/index.js'
import { redirectSite } from '../fixtures/code-redirects.js'
import { site } from '../fixtures/site.js'

const fixture = (name: string) => pathToFileURL(resolve(import.meta.dirname, '../fixtures', name)).href

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inlay-cli-'))
  await mkdir(join(dir, 'data'))
  const { db } = await bootInlay({ site, db: join(dir, 'data/inlay.db'), backups: join(dir, 'data/backups') })
  await db.destroy()
})
afterEach(() => rm(dir, { recursive: true, force: true }))

async function writeConfig(body: string, name = 'inlay.config.ts') {
  await writeFile(join(dir, name), body)
}

const v1Config = () =>
  `import { site } from '${fixture('site.ts')}'\nexport default { site, db: './data/inlay.db' }\n`

async function run(...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli(argv, { cwd: dir, out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('inlaycms check', () => {
  it('passes for an up-to-date database', async () => {
    await writeConfig(v1Config())
    const r = await run('check')
    expect(r.code).toBe(0)
    expect(r.out).toContain('Everything is up to date.')
  })

  it('passes for a database saved under another schema', async () => {
    await writeConfig(
      `import { postSummarySite } from '${fixture('evolve.ts')}'\nexport default { site: postSummarySite, db: './data/inlay.db' }\n`,
    )
    const r = await run('check')
    expect(r.code).toBe(0)
    expect(r.out).toContain('Everything is up to date.')
  })

  it('prints JSON with --json', async () => {
    await writeConfig(v1Config())
    const r = await run('check', '--json')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).ok).toBe(true)
  })

  it('checks another file with --db', async () => {
    await writeConfig(`import { site } from '${fixture('site.ts')}'\nexport default { site, db: './data/missing.db' }\n`)
    await copyFile(join(dir, 'data/inlay.db'), join(dir, 'other.db'))
    expect((await run('check', '--db', 'other.db')).code).toBe(0)
  })

  it("checks the code alone when the config's database doesn't exist yet", async () => {
    await writeConfig(`import { site } from '${fixture('site.ts')}'\nexport default { site, db: './data/missing.db' }\n`)
    const r = await run('check')
    expect(r.code).toBe(0)
    expect(existsSync(join(dir, 'data/missing.db'))).toBe(false)
  })

  it('passes with a warning when a page hides a code rule', async () => {
    const owner = { actor: { id: 'u', name: 'Olivia Owner', role: 'owner' as const }, source: 'admin' as const }
    const { db, core } = await bootInlay({ site: redirectSite, db: join(dir, 'data/redirects.db'), backups: join(dir, 'data/backups') })
    const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] }
    const entry = await core.createEntry('pages', { slug: 'old-post', fields: { title: 'Old post', body } }, owner)
    await core.publish([entry.id], owner)
    await db.destroy()
    await writeConfig(
      `import { redirectSite } from '${fixture('code-redirects.ts')}'\nexport default { site: redirectSite, db: './data/redirects.db' }\n`,
    )
    const r = await run('check')
    expect(r.code).toBe(0)
    expect(r.out).toContain(t('report.warning', { message: t('report.redirectHidden', { from: '/old-post' }) }))
  })

  it('fails a malformed code rule', async () => {
    await writeConfig(
      `import { badRedirectSite } from '${fixture('code-redirects.ts')}'\nexport default { site: badRedirectSite, db: './data/inlay.db' }\n`,
    )
    const r = await run('check')
    expect(r.code).toBe(1)
    expect(r.err).toContain(t('definition.redirectFrom', { from: '/admin/x' }))
  })

  it('exits 2 when --db names a file that does not exist', async () => {
    await writeConfig(v1Config())
    const r = await run('check', '--db', 'missing.db')
    expect(r.code).toBe(2)
    expect(r.err).toContain(join(dir, 'missing.db'))
  })

  it('accepts --config', async () => {
    await writeConfig(v1Config(), 'custom.config.ts')
    expect((await run('check', '--config', 'custom.config.ts')).code).toBe(0)
  })
})

describe('inlaycms backup', () => {
  it('writes an archive under data/backups', async () => {
    await writeConfig(v1Config())
    const r = await run('backup')
    expect(r.code).toBe(0)
    const path = r.out.replace('Backup written to ', '').trim()
    expect(existsSync(path)).toBe(true)
    expect(path.startsWith(join(dir, 'data/backups'))).toBe(true)
  })

  it('includes data/media by default', async () => {
    await writeConfig(v1Config())
    await mkdir(join(dir, 'data/media'))
    await writeFile(join(dir, 'data/media/abc'), 'orig')
    const r = await run('backup')
    expect(r.code).toBe(0)
    const out = join(dir, 'out')
    await mkdir(out)
    await tar.x({ file: r.out.replace('Backup written to ', '').trim(), cwd: out })
    expect(await readdir(join(out, 'media'))).toEqual(['abc'])
  })

  it('fails when there is no database', async () => {
    await writeConfig(`import { site } from '${fixture('site.ts')}'\nexport default { site, db: './nope.db' }\n`)
    const r = await run('backup')
    expect(r.code).toBe(2)
    expect(r.err).toContain('no database')
  })
})

describe('usage errors', () => {
  it('prints usage for an unknown command', async () => {
    const r = await run('frobnicate')
    expect(r.code).toBe(2)
    expect(r.err).toContain('Usage: inlaycms')
  })

  it('prints usage for an unknown flag and for --help', async () => {
    expect((await run('check', '--bogus')).code).toBe(2)
    expect((await run('--help')).code).toBe(2)
    expect((await run()).code).toBe(2)
  })

  it('exits 2 with a message when the config file does not load', async () => {
    await writeConfig('export default {\n')
    const r = await run('check')
    expect(r.code).toBe(2)
    expect(r.err).toContain(join(dir, 'inlay.config.ts'))
  })

  it('exits 2 with a message when --db is not a database', async () => {
    await writeConfig(v1Config())
    await writeFile(join(dir, 'junk.db'), 'this is not a database, just some text that is long enough to have a header')
    const r = await run('check', '--db', 'junk.db')
    expect(r.code).toBe(2)
    expect(r.err).toContain(join(dir, 'junk.db'))
  })

  it('exits 2 with a message when backup finds a file that is not a database', async () => {
    await writeConfig(`import { site } from '${fixture('site.ts')}'\nexport default { site, db: './junk.db' }\n`)
    await writeFile(join(dir, 'junk.db'), 'this is not a database, just some text that is long enough to have a header')
    const r = await run('backup')
    expect(r.code).toBe(2)
    expect(r.err).toContain(join(dir, 'junk.db'))
  })

  it('exits 2 when no config file exists', async () => {
    const r = await run('check')
    expect(r.code).toBe(2)
    expect(r.err).toContain('config')
  })
})
