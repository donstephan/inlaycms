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
const dbFile = () => join(dir, 'data/inlay.db')
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inlay-cli-rb-'))
  await mkdir(join(dir, 'data'))
  const { db } = await bootInlay({ site, db: dbFile(), backups: join(dir, 'data/backups') })
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

async function postCount(): Promise<number> {
  const booted = await bootInlay({ site, db: dbFile(), backups: join(dir, 'data/backups') })
  try {
    return (await booted.core.listEntries('posts')).length
  } finally {
    await booted.db.destroy()
  }
}

async function addPost() {
  const booted = await bootInlay({ site, db: dbFile(), backups: join(dir, 'data/backups') })
  try {
    await booted.core.createEntry('posts', { fields: { title: 'Hello' } }, { actor: { id: 'u', name: 'U', role: 'editor' }, source: 'admin' })
  } finally {
    await booted.db.destroy()
  }
}

describe('inlaycms restore-backup', () => {
  it('reverts the content to a backup, by basename', async () => {
    expect((await run('backup')).code).toBe(0)
    const name = (await readdir(join(dir, 'data/backups'))).find((f) => f.includes('manual'))
    expect(name).toBeDefined()
    await addPost()
    expect(await postCount()).toBe(1)

    const r = await run('restore-backup', name ?? '')
    expect(r.code).toBe(0)
    expect(r.out).toContain('Restored the backup')
    expect(r.out).toContain('before-restore')
    expect(await postCount()).toBe(0)
  })

  it('names only the replaced files that existed', async () => {
    await run('backup')
    const name = (await readdir(join(dir, 'data/backups'))).find((f) => f.includes('manual')) ?? ''
    await rm(dbFile())
    await rm(join(dir, 'data/media'), { recursive: true, force: true })
    const r = await run('restore-backup', name)
    expect(r.code).toBe(0)
    expect(r.out).toContain('Restored the backup')
    expect(r.out).not.toContain('replaced')
  })

  it('exits 2 for a missing file', async () => {
    const r = await run('restore-backup', 'nope.tar.gz')
    expect(r.code).toBe(2)
  })

  it('needs exactly one file', async () => {
    expect((await run('restore-backup')).code).toBe(2)
  })

  it('refuses while the server is running unless --server-stopped', async () => {
    await run('backup')
    const name = (await readdir(join(dir, 'data/backups'))).find((f) => f.includes('manual')) ?? ''
    const live = openDatabase(dbFile())
    try {
      const refused = await run('restore-backup', name)
      expect(refused.code).toBe(2)
      expect(refused.err).toContain('--server-stopped')
      expect(existsSync(dbFile())).toBe(true)
    } finally {
      await live.destroy()
    }
  })
})
