import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { runCli } from '../../src/adapters/cli/main.js'
import { bootInlay } from '../../src/core/boot.js'
import { site } from '../fixtures/site.js'

const fixture = (name: string) => pathToFileURL(resolve(import.meta.dirname, '../fixtures', name)).href

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inlay-owner-'))
  await mkdir(join(dir, 'data'))
  await writeFile(
    join(dir, 'inlay.config.ts'),
    `import { site } from '${fixture('site.ts')}'\nexport default { site, db: './data/inlay.db' }\n`,
  )
})
afterEach(() => rm(dir, { recursive: true, force: true }))

async function run(password: string | undefined, ...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli(argv, {
    cwd: dir,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...(password !== undefined && { readSecret: async () => password }),
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

const args = ['create-owner', '--email', 'olivia@example.com', '--name', 'Olivia']

describe('inlaycms create-owner', () => {
  it('creates the owner', async () => {
    const r = await run('a-long-password', ...args)
    expect(r.code).toBe(0)
    expect(r.out).toContain('olivia@example.com')
    const { db, auth } = await bootInlay({
      site,
      db: join(dir, 'data/inlay.db'),
      backups: join(dir, 'data/backups'),
      auth: { secret: randomBytes(32).toString('hex'), baseUrl: 'http://localhost' },
    })
    try {
      expect(await auth!.hasOwner()).toBe(true)
    } finally {
      await db.destroy()
    }
  })

  it('refuses a second owner', async () => {
    await run('a-long-password', ...args)
    const r = await run('a-long-password', ...args)
    expect(r.code).toBe(1)
    expect(r.err).toContain('already has an owner')
  })

  it('rejects a short password', async () => {
    const r = await run('short', ...args)
    expect(r.code).toBe(1)
    expect(r.err).not.toBe('')
  })

  it('shows usage without an email', async () => {
    const r = await run('a-long-password', 'create-owner', '--name', 'Olivia')
    expect(r.code).toBe(2)
    expect(r.err).toContain('Usage:')
  })

  it('reports an error when no secret input is available', async () => {
    const r = await run(undefined, ...args)
    expect(r.code).toBe(2)
  })
})
