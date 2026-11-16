import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../../src/adapters/cli/main.js'
import { canPush } from '../../src/core/auth/roles.js'
import { bootInlay } from '../../src/core/boot.js'
import { t } from '../../src/core/messages/index.js'
import { EMPTY_SITE } from '../../src/host/app.js'

let dir: string
let data: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inlay-cli-token-'))
  data = join(dir, 'data')
  vi.stubEnv('INLAY_DATA_DIR', '')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

async function run(...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli(argv, { cwd: dir, out: (l) => out.push(l), err: (l) => err.push(l), readSecret: async () => 'a-long-password' })
  return { code, out, err: err.join('\n') }
}

/** The data folder's auth service, as the server would have it (with another secret). */
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

describe('inlaycms create-token', () => {
  beforeEach(async () => {
    expect((await run('create-owner', '--data', data, '--email', 'olivia@example.com', '--name', 'Olivia')).code).toBe(0)
  })

  it('prints a push token, alone on standard output, that the server accepts for pushing', async () => {
    const r = await run('create-token', '--data', data, '--email', 'olivia@example.com', '--name', 'ci', '--push')
    expect(r.code).toBe(0)
    expect(r.out).toHaveLength(1)
    expect(r.err).toBe(t('cli.pushTokenCreated', { name: 'ci', email: 'olivia@example.com' }))
    const found = await withAuth((auth) => auth.apiKeyActor(r.out[0]!))
    expect(found?.actor.role).toBe('owner')
    expect(canPush(found!.actor, found!.permissions)).toBe(true)
  })

  it('without --push makes a key that may not push', async () => {
    const r = await run('create-token', '--data', data, '--email', 'olivia@example.com', '--name', 'plain')
    expect(r.code).toBe(0)
    expect(r.err).toBe(t('cli.tokenCreated', { name: 'plain', email: 'olivia@example.com' }))
    const found = await withAuth((auth) => auth.apiKeyActor(r.out[0]!))
    expect(found).not.toBeNull()
    expect(canPush(found!.actor, found!.permissions)).toBe(false)
  })

  it('refuses an unknown email and a push token for an editor', async () => {
    const unknown = await run('create-token', '--data', data, '--email', 'nobody@example.com', '--name', 'ci', '--push')
    expect(unknown.code).toBe(1)
    expect(unknown.err).toBe(t('cli.tokenNoUser', { email: 'nobody@example.com' }))
    expect(unknown.out).toEqual([])

    await withAuth((auth) =>
      auth.createUser({ email: 'eddie@example.com', name: 'Eddie', password: 'a-long-password', role: 'editor' }),
    )
    const editor = await run('create-token', '--data', data, '--email', 'eddie@example.com', '--name', 'ci', '--push')
    expect(editor.code).toBe(1)
    expect(editor.err).toBe(t('cli.tokenNotOwner', { email: 'eddie@example.com' }))
  })

  it('refuses a name that is too long', async () => {
    const r = await run('create-token', '--data', data, '--email', 'olivia@example.com', '--name', 'x'.repeat(40), '--push')
    expect(r.code).toBe(1)
    expect(r.out).toEqual([])
  })

  it('shows usage without an email or a name, and --push elsewhere', async () => {
    expect((await run('create-token', '--data', data, '--name', 'ci')).code).toBe(2)
    expect((await run('create-token', '--data', data, '--email', 'olivia@example.com')).code).toBe(2)
    expect((await run('backup', '--data', data, '--push')).code).toBe(2)
  })
})

it('inlaycms create-token needs a database', async () => {
  const r = await run('create-token', '--data', data, '--email', 'olivia@example.com', '--name', 'ci')
  expect(r.code).toBe(2)
  expect(r.err).toContain(join(data, 'inlay.db'))
})
