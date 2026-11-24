import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../../src/adapters/cli/main.js'
import { bootInlay } from '../../src/core/boot.js'
import { t } from '../../src/core/messages/index.js'
import { EMPTY_SITE } from '../../src/host/app.js'
import { turnOnTwoStep } from '../helpers/auth.js'

let dir: string
let data: string
const SECRET = 'a known secret for the sessions of this test file'
const PASSWORD = 'the old password'
const EMAIL = 'olivia@example.com'

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inlay-cli-two-factor-'))
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
  const code = await runCli(argv, { cwd: dir, out: (l) => out.push(l), err: (l) => err.push(l), readSecret: async () => PASSWORD })
  return { code, out, err: err.join('\n') }
}

type Auth = Awaited<ReturnType<typeof bootInlay>>['auth'] & object

async function withAuth<T>(use: (auth: Auth) => Promise<T>, folder = data): Promise<T> {
  const { db, auth } = await bootInlay({
    site: EMPTY_SITE,
    db: join(folder, 'inlay.db'),
    backups: join(folder, 'backups'),
    content: 'none',
    auth: { secret: SECRET, baseUrl: 'http://localhost', rateLimit: false },
  })
  try {
    return await use(auth)
  } finally {
    await db.destroy()
  }
}

/** Logs in through better-auth's own handler and returns the session's `Cookie` header. */
async function logIn(auth: Auth): Promise<string> {
  const res = await auth.auth.handler(
    new Request(`${auth.issuer}/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: new URL(auth.issuer).origin },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    }),
  )
  if (!res.ok) throw new Error(`Login failed with ${res.status}`)
  return res.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ')
}

/** Turns two-step login on for the owner through better-auth's endpoints. */
/** Returns the cookie of the session left open. */
const turnOn = () => withAuth(async (auth) => (await turnOnTwoStep(auth, await logIn(auth), PASSWORD)).cookie)

/** Whether a login with the password alone is told to give a code. */
const codeAsked = () =>
  withAuth(async (auth) => {
    const found = await auth.auth.api.signInEmail({ body: { email: EMAIL, password: PASSWORD } })
    return 'twoFactorRedirect' in found && found.twoFactorRedirect === true
  })

describe('inlaycms reset-two-factor', () => {
  let cookie: string

  beforeEach(async () => {
    expect((await run('create-owner', '--data', data, '--email', EMAIL, '--name', 'Olivia')).code).toBe(0)
    cookie = await turnOn()
  })

  it('turns two-step login off: the password alone logs in again', async () => {
    expect(await codeAsked()).toBe(true)
    const r = await run('reset-two-factor', '--data', data, '--email', EMAIL)
    expect(r.code, r.err).toBe(0)
    expect(r.out).toEqual([t('cli.twoFactorReset', { email: EMAIL })])
    expect(await codeAsked()).toBe(false)
  })

  it("ends the user's sessions and keeps their API keys", async () => {
    const sessionOf = () => withAuth((auth) => auth.auth.api.getSession({ headers: new Headers({ cookie }) }))
    expect(await sessionOf()).not.toBeNull()
    const made = await run('create-token', '--data', data, '--email', EMAIL, '--name', 'ci')
    const key = made.out[0]!
    expect((await run('reset-two-factor', '--data', data, '--email', EMAIL)).code).toBe(0)
    expect(await sessionOf()).toBeNull()
    expect(await withAuth((auth) => auth.apiKeyActor(key))).not.toBeNull()
  })

  it('finds the user whatever the case of the email', async () => {
    const r = await run('reset-two-factor', '--data', data, '--email', 'Olivia@Example.com')
    expect(r.code, r.err).toBe(0)
    expect(await codeAsked()).toBe(false)
  })

  it('refuses an unknown email', async () => {
    const r = await run('reset-two-factor', '--data', data, '--email', 'nobody@example.com')
    expect(r.code).toBe(1)
    expect(r.err).toBe(t('cli.resetNoUser', { email: 'nobody@example.com' }))
  })

  it("says so when the user doesn't have it on, and leaves their session alone", async () => {
    expect((await run('reset-two-factor', '--data', data, '--email', EMAIL)).code).toBe(0)
    const fresh = await withAuth((auth) => logIn(auth))
    const sessionOf = () => withAuth((auth) => auth.auth.api.getSession({ headers: new Headers({ cookie: fresh }) }))
    expect(await sessionOf()).not.toBeNull()
    const r = await run('reset-two-factor', '--data', data, '--email', EMAIL)
    expect(r.code).toBe(1)
    expect(r.err).toBe(t('cli.twoFactorNotOn', { email: EMAIL }))
    expect(await sessionOf()).not.toBeNull()
  })

  it('needs --email and takes no --name or --push', async () => {
    expect((await run('reset-two-factor', '--data', data)).code).toBe(2)
    expect((await run('reset-two-factor', '--data', data, '--email', EMAIL, '--name', 'x')).code).toBe(2)
    expect((await run('reset-two-factor', '--data', data, '--email', EMAIL, '--push')).code).toBe(2)
  })

  it('keeps two-step login on after reset-password', async () => {
    const r = await run('reset-password', '--data', data, '--email', EMAIL)
    expect(r.code, r.err).toBe(0)
    expect(await codeAsked()).toBe(true)
  })

  it('says when there is no database', async () => {
    const empty = join(dir, 'empty')
    await mkdir(empty)
    const r = await run('reset-two-factor', '--data', empty, '--email', EMAIL)
    expect(r.code).toBe(2)
    expect(r.err).toContain(join(empty, 'inlay.db'))
  })
})
