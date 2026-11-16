import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runCli } from '../../src/adapters/cli/main.js'
import { bootInlay } from '../../src/core/boot.js'
import { openDatabase } from '../../src/core/db/connection.js'
import { site } from '../fixtures/site.js'

const fixture = (name: string) => pathToFileURL(resolve(import.meta.dirname, '../fixtures', name)).href

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inlay-cli-ei-'))
  await mkdir(join(dir, 'data'))
  const { db } = await bootInlay({ site, db: join(dir, 'data/inlay.db'), backups: join(dir, 'data/backups') })
  await db.destroy()
  await writeFile(
    join(dir, 'inlay.config.ts'),
    `import { site } from '${fixture('site.ts')}'\nexport default { site, db: './data/inlay.db' }\n`,
  )
})
afterEach(() => rm(dir, { recursive: true, force: true }))

async function run(...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli(argv, { cwd: dir, out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

/**
 * Exports the content and writes `broken.config.ts`: the fixture site plus a pricing page whose
 * shipped content doesn't fit, so the export can't be imported into it.
 */
async function incompatibleExport(): Promise<string> {
  await run('export', '--out', 'x.tar.gz')
  await writeFile(
    join(dir, 'broken.config.ts'),
    `import { site } from '${fixture('site.ts')}'\n` +
      `const about = site.singletons.find((s) => s.name === 'about')\n` +
      `const pricing = { ...about, name: 'pricing', label: 'Pricing', path: '/pricing' }\n` +
      `const content = [...site.content, { type: 'pricing', via: 'content', documents: [{ key: 'pricing', edition: 1, content: { en: { fields: {} } } }] }]\n` +
      `export default { site: { ...site, singletons: [...site.singletons, pricing], content }, db: './data/inlay.db' }\n`,
  )
  return 'x.tar.gz'
}

describe('inlaycms export', () => {
  it('writes a default-named file in the current directory', async () => {
    const r = await run('export')
    expect(r.code).toBe(0)
    const files = (await readdir(dir)).filter((f) => /^inlay-export-.+\.tar\.gz$/.test(f))
    expect(files).toHaveLength(1)
    expect(r.out).toContain('Export written to')
  })

  it('writes to --out', async () => {
    const r = await run('export', '--out', 'x.tar.gz')
    expect(r.code).toBe(0)
    expect(existsSync(join(dir, 'x.tar.gz'))).toBe(true)
  })

  it('exits 2 when there is no database', async () => {
    await rm(join(dir, 'data'), { recursive: true })
    const r = await run('export')
    expect(r.code).toBe(2)
    expect(r.err).toContain('no database')
  })

  it('rejects extra arguments and import-only flags', async () => {
    expect((await run('export', 'extra')).code).toBe(2)
    expect((await run('export', '--dry-run')).code).toBe(2)
  })
})

describe('inlaycms check --export', () => {
  it('passes for a compatible export', async () => {
    await run('export', '--out', 'x.tar.gz')
    const r = await run('check', '--export', 'x.tar.gz')
    expect(r.code).toBe(0)
  })

  it('fails for an export the site cannot import', async () => {
    const file = await incompatibleExport()
    const r = await run('check', '--export', file, '--config', 'broken.config.ts')
    expect(r.code).toBe(1)
    expect(r.out).toContain('Pricing')
  })

  it('does not combine with --db', async () => {
    await run('export', '--out', 'x.tar.gz')
    expect((await run('check', '--export', 'x.tar.gz', '--db', 'data/inlay.db')).code).toBe(2)
  })
})

describe('inlaycms import --dry-run', () => {
  it('lists each type for a compatible export', async () => {
    await run('export', '--out', 'x.tar.gz')
    const r = await run('import', 'x.tar.gz', '--dry-run')
    expect(r.code).toBe(0)
    for (const label of ['Home']) expect(r.out).toContain(label)
  })

  it('prints JSON with --json', async () => {
    await run('export', '--out', 'x.tar.gz')
    const r = await run('import', 'x.tar.gz', '--dry-run', '--json')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).ok).toBe(true)
  })

  it('exits 1 for an incompatible export', async () => {
    const file = await incompatibleExport()
    expect((await run('import', file, '--dry-run', '--config', 'broken.config.ts')).code).toBe(1)
  })

  it('works while the server is running', async () => {
    await run('export', '--out', 'x.tar.gz')
    const live = openDatabase(join(dir, 'data/inlay.db'))
    try {
      expect((await run('import', 'x.tar.gz', '--dry-run')).code).toBe(0)
    } finally {
      await live.destroy()
    }
  })
})

describe('inlaycms import', () => {
  it('restores a compatible export and takes a pre-import backup', async () => {
    await run('export', '--out', 'x.tar.gz')
    const r = await run('import', 'x.tar.gz')
    expect(r.code).toBe(0)
    expect(r.out).toContain('Content restored from')
    const backups = await readdir(join(dir, 'data/backups'))
    expect(backups.some((f) => f.includes('pre-import'))).toBe(true)
  })

  it('no longer takes --force-compatible', async () => {
    await run('export', '--out', 'x.tar.gz')
    expect((await run('import', 'x.tar.gz', '--force-compatible')).code).toBe(2)
  })

  it('refuses while the server is running unless --server-stopped', async () => {
    await run('export', '--out', 'x.tar.gz')
    const live = openDatabase(join(dir, 'data/inlay.db'))
    try {
      const refused = await run('import', 'x.tar.gz')
      expect(refused.code).toBe(2)
      expect(refused.err).toContain('--server-stopped')
    } finally {
      await live.destroy()
    }
    const forced = await (async () => {
      const live2 = openDatabase(join(dir, 'data/inlay.db'))
      try {
        return await run('import', 'x.tar.gz', '--server-stopped')
      } finally {
        await live2.destroy()
      }
    })()
    expect(forced.code).toBe(0)
  })

  it('needs exactly one file', async () => {
    expect((await run('import')).code).toBe(2)
    expect((await run('import', 'a', 'b')).code).toBe(2)
  })

  it('exits 2 for a file that is not an export', async () => {
    await writeFile(join(dir, 'bad.tar.gz'), 'nope')
    expect((await run('import', 'bad.tar.gz')).code).toBe(2)
  })
})
