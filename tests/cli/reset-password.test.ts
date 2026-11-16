import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../../src/adapters/cli/main.js'
import { bootInlay } from '../../src/core/boot.js'
import { t } from '../../src/core/messages/index.js'
import { EMPTY_SITE } from '../../src/host/app.js'

let dir: string
let data: string
const OLD = 'the old password'

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inlay-cli-reset-'))
  data = join(dir, 'data')
  vi.stubEnv('INLAY_DATA_DIR', '')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

async function run(secret: string, ...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli(argv, { cwd: dir, out: (l) => out.push(l), err: (l) => err.push(l), readSecret: async () => secret })
  return { code, out, err: err.join('\n') }
}

async function withAuth<T>(use: (auth: Awaited<ReturnType<typeof bootInlay>>['auth'] & object) => Promise<T>): Promise<T> {
  const { db, auth } = await bootInlay({
    site: EMPTY_SITE,
    db: join(data, 'inlay.db'),
    backups: join(data, 'backups'),
    content: 'none',
    auth: { secret: randomBytes(32).toString('hex'), baseUrl: 'http://localhost' },
  })
  try {
    return await use(auth)
  } finally {
    await db.destroy()
  }
}

const signIn = (password: string) =>
  withAuth((auth) => auth.auth.api.signInEmail({ body: { email: 'olivia@example.com', password } }))

describe('inlaycms reset-password', () => {
  beforeEach(async () => {
    expect((await run(OLD, 'create-owner', '--data', data, '--email', 'olivia@example.com', '--name', 'Olivia')).code).toBe(0)
  })

  it('sets a new password: the new one signs in and the old one does not', async () => {
    const r = await run('a brand new password', 'reset-password', '--data', data, '--email', 'olivia@example.com')
    expect(r.code).toBe(0)
    expect(r.out).toEqual([t('cli.passwordReset', { email: 'olivia@example.com' })])
    await expect(signIn('a brand new password')).resolves.toBeTruthy()
    await expect(signIn(OLD)).rejects.toThrow()
  })

  it("ends the user's API keys", async () => {
    const made = await run(OLD, 'create-token', '--data', data, '--email', 'olivia@example.com', '--name', 'ci')
    const key = made.out[0]!
    expect(await withAuth((auth) => auth.apiKeyActor(key))).not.toBeNull()
    expect((await run('a brand new password', 'reset-password', '--data', data, '--email', 'olivia@example.com')).code).toBe(0)
    expect(await withAuth((auth) => auth.apiKeyActor(key))).toBeNull()
  })

  it('finds the user whatever the case of the email', async () => {
    const r = await run('a brand new password', 'reset-password', '--data', data, '--email', 'Olivia@Example.com')
    expect(r.code).toBe(0)
    await expect(signIn('a brand new password')).resolves.toBeTruthy()
  })

  it('refuses an unknown email', async () => {
    const r = await run('a brand new password', 'reset-password', '--data', data, '--email', 'nobody@example.com')
    expect(r.code).toBe(1)
    expect(r.err).toBe(t('cli.resetNoUser', { email: 'nobody@example.com' }))
  })

  it('refuses a too-short password and keeps the old one', async () => {
    const r = await run('short', 'reset-password', '--data', data, '--email', 'olivia@example.com')
    expect(r.code).toBe(1)
    expect(r.err.split('\n').length).toBeGreaterThan(1)
    await expect(signIn(OLD)).resolves.toBeTruthy()
  })

  it('needs --email and takes no --name or --push', async () => {
    expect((await run('a brand new password', 'reset-password', '--data', data)).code).toBe(2)
    expect((await run('a brand new password', 'reset-password', '--data', data, '--email', 'olivia@example.com', '--name', 'x')).code).toBe(2)
    expect((await run('a brand new password', 'reset-password', '--data', data, '--email', 'olivia@example.com', '--push')).code).toBe(2)
  })
})

it('inlaycms reset-password says when there is no database', async () => {
  const empty = join(dir, 'empty')
  await mkdir(empty)
  const r = await run('a brand new password', 'reset-password', '--data', empty, '--email', 'olivia@example.com')
  expect(r.code).toBe(2)
  expect(r.err).toContain(join(empty, 'inlay.db'))
  expect(existsSync(join(empty, 'inlay.db'))).toBe(false)
})
