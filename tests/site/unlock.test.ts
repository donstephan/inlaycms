import type { FastifyInstance } from 'fastify'
import { passwordHasher, setTestPasswordHasher, type PasswordHasher } from '../../src/core/auth/auth.js'
import { makeApp } from '../helpers/app.js'

const PASSWORD = 'letmein123'
const FORM = { 'content-type': 'application/x-www-form-urlencoded' }

const open: FastifyInstance[] = []

const fastHasher = passwordHasher()

afterEach(async () => {
  setTestPasswordHasher(fastHasher)
  await Promise.all(open.splice(0).map((a) => a.close()))
})

/** The fast test hasher, but each verify waits for `release` (or a short timeout when there isn't one). */
function slowHasher(release?: Promise<void>): { hasher: PasswordHasher; entered: Promise<void> } {
  let enter = () => {}
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const hasher: PasswordHasher = {
    hash: fastHasher.hash,
    verify: async (args) => {
      enter()
      await (release ?? new Promise((resolve) => setTimeout(resolve, 20)))
      return fastHasher.verify(args)
    },
  }
  return { hasher, entered }
}

async function setup(opts: { rateLimit?: boolean; locked?: boolean } = {}) {
  const made = await makeApp({ withOwner: true, ...(opts.rateLimit !== undefined && { rateLimit: opts.rateLimit }) })
  open.push(made.app)
  if (opts.locked !== false) {
    await made.core.setSitePassword(PASSWORD, made.owner)
    await made.core.setSiteLock(true, made.owner)
  }
  const post = (password: string, next?: string) =>
    made.app.inject({
      method: 'POST',
      url: '/_inlay/unlock',
      headers: FORM,
      payload: new URLSearchParams({ password, ...(next !== undefined && { next }) }).toString(),
    })
  return { ...made, post }
}

describe('POST /_inlay/unlock', () => {
  it('unlocks with the right password and returns to next', async () => {
    const { app, post } = await setup()
    const res = await post(PASSWORD, '/about')
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/about')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-robots-tag']).toBe('noindex')
    const cookie = String(res.headers['set-cookie'])
    for (const part of ['inlay_unlock=', 'HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/', 'Max-Age=2592000']) {
      expect(cookie).toContain(part)
    }
    const page = await app.inject({ url: '/about', headers: { cookie: cookie.split(';')[0] ?? '' } })
    expect(page.statusCode).toBe(200)
  })

  it('says so when the password is wrong', async () => {
    const { post } = await setup()
    const res = await post('nope-nope', '/about')
    expect(res.statusCode).toBe(401)
    expect(res.body).toContain('That password isn&#39;t right. Check it and try again.')
    expect(res.body).toContain('name="next" value="/about"')
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-robots-tag']).toBe('noindex')
  })

  it('slows down repeated wrong guesses', async () => {
    const { post } = await setup({ rateLimit: true })
    for (let i = 0; i < 5; i++) expect((await post('wrong-guess')).statusCode).toBe(401)
    const res = await post(PASSWORD)
    expect(res.statusCode).toBe(429)
    expect(res.body).toContain('Too many tries. Wait a minute and try again.')
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-robots-tag']).toBe('noindex')
  })

  it('counts concurrent guesses before checking them', async () => {
    const { post } = await setup({ rateLimit: true })
    setTestPasswordHasher(slowHasher().hasher)
    const codes = (await Promise.all(Array.from({ length: 20 }, () => post('wrong-guess')))).map((r) => r.statusCode)
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(5)
    expect(codes.filter((c) => c !== 401 && c !== 429)).toEqual([])
  })

  it('does not count the right password against the limit', async () => {
    const { post } = await setup({ rateLimit: true })
    for (let i = 0; i < 4; i++) expect((await post('wrong-guess')).statusCode).toBe(401)
    for (let i = 0; i < 3; i++) expect((await post(PASSWORD)).statusCode).toBe(303)
    expect((await post('wrong-guess')).statusCode).toBe(401)
    expect((await post('wrong-guess')).statusCode).toBe(429)
  })

  it('never unlocks the new password with the old one', async () => {
    const { app, core, owner, post } = await setup()
    let release = () => {}
    const held = slowHasher(
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    setTestPasswordHasher(held.hasher)
    const pending = post(PASSWORD)
    await held.entered
    await core.setSitePassword('another-pass', owner)
    release()
    const res = await pending
    const cookie = String(res.headers['set-cookie'] ?? '').split(';')[0] ?? ''
    const page = await app.inject({ url: '/', headers: { cookie } })
    expect(page.statusCode).toBe(401)
  })

  it('does not count guesses when rateLimit is off', async () => {
    const { post } = await setup()
    for (let i = 0; i < 10; i++) expect((await post('wrong-guess')).statusCode).toBe(401)
    expect((await post(PASSWORD)).statusCode).toBe(303)
  })

  it('just redirects when the site is public', async () => {
    const { post } = await setup({ locked: false })
    const res = await post('anything', '/about')
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/about')
    expect(res.headers['x-robots-tag']).toBe('noindex')
  })

  it('never redirects off the site', async () => {
    const { post } = await setup()
    for (const next of ['//evil.example', 'https://evil.example/x', '/\\evil.example']) {
      const res = await post(PASSWORD, next)
      expect(res.statusCode).toBe(303)
      expect(res.headers.location).toBe('/')
    }
  })
})
