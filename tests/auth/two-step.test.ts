import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { sql } from 'kysely'
import { t } from '../../src/core/messages/index.js'
import { escapeHtml } from '../../src/jsx/html.js'
import { parseHtml, signIn, totpCode } from '../helpers/admin.js'
import { makeApp, OWNER_PASSWORD } from '../helpers/app.js'
import { makeAuth, turnOnTwoStep } from '../helpers/auth.js'

const ORIGIN = 'https://example.com'
const RESOURCE = 'https://example.com/mcp'
const REDIRECT = 'http://localhost:7777/cb'
const OWNER = 'owner@example.com'

const open: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()))
})

async function withOwner() {
  const made = await makeApp({ withOwner: true })
  open.push(made.app)
  return made
}

/** An app whose owner has two-step login on, and the owner's key. */
async function withTwoStep() {
  const made = await withOwner()
  const client = await signIn(made.app, OWNER)
  const { key } = await turnOnTwoStep(made.service, client.cookie)
  return { ...made, key }
}

/** Keeps the cookies responses set, as a browser would. */
class Jar {
  readonly cookies = new Map<string, string>()

  store(res: LightMyRequestResponse): this {
    const header = res.headers['set-cookie']
    const lines = header === undefined ? [] : Array.isArray(header) ? header : [header]
    for (const line of lines) {
      const [pair = '', ...attrs] = line.split(';')
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === ''
      if (expired) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    return this
  }

  header(): Record<string, string> {
    if (this.cookies.size === 0) return {}
    return { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
  }
}

async function get(a: FastifyInstance, url: string, jar?: Jar) {
  const res = await a.inject({ method: 'GET', url, headers: jar?.header() ?? {} })
  jar?.store(res)
  return res
}

async function postForm(a: FastifyInstance, url: string, fields: Record<string, string>, opts: { jar?: Jar; origin?: string } = {}) {
  const res = await a.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: opts.origin ?? ORIGIN, ...opts.jar?.header() },
    payload: new URLSearchParams(fields).toString(),
  })
  opts.jar?.store(res)
  return res
}

const location = (res: LightMyRequestResponse) => String(res.headers.location ?? '')
const queryOf = (url: string) => url.slice(url.indexOf('?') + 1)

/** Posts the owner's password to the login form, into `jar`. */
function logIn(a: FastifyInstance, jar: Jar, fields: Record<string, string> = {}) {
  return postForm(a, '/admin/login', { email: OWNER, password: OWNER_PASSWORD, ...fields }, { jar })
}

/** A six-digit code the plugin won't accept now (it allows one step either side). */
function wrongCode(key: string): string {
  const now = Date.now()
  const valid = new Set([-30_000, 0, 30_000].map((d) => totpCode(key, now + d)))
  return ['000000', '111111', '222222', '333333'].find((c) => !valid.has(c))!
}

/** The status of a JSON POST sent over a real socket with `path` exactly as written (`inject` would normalize it). */
async function rawPost(a: FastifyInstance, path: string, cookie: string, body: unknown): Promise<number> {
  const address = a.server.address() ?? (await a.listen({ port: 0, host: '127.0.0.1' }), a.server.address())
  const { port } = address as AddressInfo
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), origin: ORIGIN, cookie },
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

/** Follows a redirect to the login page and returns it. */
async function loginPageAt(a: FastifyInstance, res: LightMyRequestResponse) {
  expect(res.statusCode, res.body).toBe(302)
  expect(location(res)).toMatch(/^\/admin\/login\?/)
  const page = await get(a, location(res))
  expect(page.statusCode).toBe(200)
  return page
}

describe('totpCode', () => {
  it('matches the RFC 6238 SHA-1 test vector', () => {
    expect(totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082')
  })
})

describe('two-step login', () => {
  it('logs in with the password alone when two-step login is off', async () => {
    const { app } = await withOwner()
    const login = await logIn(app, new Jar())
    expect(login.statusCode, login.body).toBe(302)
    expect(location(login)).toBe('/admin')
  })

  it('gives no session after the password when it is on', async () => {
    const { app } = await withTwoStep()
    const jar = new Jar()
    const login = await logIn(app, jar)
    expect(login.statusCode, login.body).toBe(302)
    expect(location(login)).toMatch(/^\/admin\/login\/code(\?|$)/)
    const admin = await get(app, '/admin', jar)
    expect(admin.statusCode).toBe(302)
    expect(location(admin)).toMatch(/^\/admin\/login(\?|$)/)
  })

  it('shows the code page', async () => {
    const { app } = await withOwner()
    const page = await get(app, '/admin/login/code?next=%2Fadmin%2Fpublish')
    expect(page.statusCode).toBe(200)
    const doc = parseHtml(page.body)
    const code = doc.querySelector('input[name="code"]')
    expect(code?.getAttribute('autocomplete')).toBe('one-time-code')
    expect(code?.getAttribute('inputmode')).toBe('numeric')
    expect(doc.querySelector('input[type="hidden"][name="next"]')?.getAttribute('value')).toBe('/admin/publish')
    expect(page.body).toContain(escapeHtml(t('auth.code.lostPhone')))
  })

  it('signs in with the right code and goes to next', async () => {
    const { app, key } = await withTwoStep()
    const jar = new Jar()
    await logIn(app, jar, { next: '/admin/publish' })
    const code = await postForm(app, '/admin/login/code', { code: totpCode(key), next: '/admin/publish' }, { jar })
    expect(code.statusCode, code.body).toBe(302)
    expect(location(code)).toBe('/admin/publish')
    expect((await get(app, '/admin', jar)).statusCode).toBe(200)
  })

  it('refuses a wrong code and lets the person try again', async () => {
    const { app, key } = await withTwoStep()
    const jar = new Jar()
    await logIn(app, jar)
    const wrong = await postForm(app, '/admin/login/code', { code: wrongCode(key) }, { jar })
    expect(wrong.statusCode).toBe(401)
    expect(wrong.body).toContain(escapeHtml(t('auth.code.wrong')))
    const right = await postForm(app, '/admin/login/code', { code: totpCode(key) }, { jar })
    expect(right.statusCode, right.body).toBe(302)
    expect((await get(app, '/admin', jar)).statusCode).toBe(200)
  })

  it('sends the person back to log in when the pending cookie is gone', async () => {
    const { app, key } = await withTwoStep()
    const code = await postForm(app, '/admin/login/code', { code: totpCode(key), next: '/admin/publish' })
    const page = await loginPageAt(app, code)
    expect(new URLSearchParams(queryOf(location(code))).get('next')).toBe('/admin/publish')
    expect(page.body).toContain(escapeHtml(t('auth.code.expired')))
  })

  it('stops after five wrong codes in one attempt', async () => {
    const { app, key } = await withTwoStep()
    const jar = new Jar()
    await logIn(app, jar)
    for (let i = 0; i < 5; i++) {
      const wrong = await postForm(app, '/admin/login/code', { code: wrongCode(key) }, { jar })
      expect(wrong.statusCode).toBe(401)
    }
    const sixth = await postForm(app, '/admin/login/code', { code: totpCode(key) }, { jar })
    const page = await loginPageAt(app, sixth)
    expect(page.body).toContain(escapeHtml(t('auth.tooManyAttempts')))
    expect(location(await get(app, '/admin', jar))).toMatch(/^\/admin\/login(\?|$)/)

    const client = await signIn(app, OWNER, OWNER_PASSWORD, key)
    expect((await client.get('/admin')).statusCode).toBe(200)
  })

  it('refuses a code POST from another origin', async () => {
    const { app, key } = await withTwoStep()
    const jar = new Jar()
    await logIn(app, jar)
    const res = await postForm(app, '/admin/login/code', { code: totpCode(key) }, { jar, origin: 'https://evil.example' })
    expect(res.statusCode).toBe(403)
  })

  it('connects an assistant with two-step login on', async () => {
    const { app, key } = await withTwoStep()
    const register = await app.inject({
      method: 'POST',
      url: '/api/auth/oauth2/register',
      headers: { 'content-type': 'application/json' },
      payload: { client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' },
    })
    expect(register.statusCode, register.body).toBeLessThan(300)
    const clientId = register.json().client_id as string
    const verifier = randomBytes(32).toString('base64url')
    const authorize = await get(
      app,
      `/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        scope: 'openid profile email offline_access',
        state: 'state-123',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        resource: RESOURCE,
      }).toString()}`,
    )
    expect(authorize.statusCode, authorize.body).toBe(302)
    expect(location(authorize)).toMatch(/^\/admin\/login\?.*\bsig=/)

    const jar = new Jar()
    await get(app, location(authorize), jar)
    const login = await logIn(app, jar, { oauth_query: queryOf(location(authorize)) })
    expect(login.statusCode, login.body).toBe(302)
    expect(location(login)).toMatch(/^\/admin\/login\/code\?.*\bsig=/)
    expect(location(login)).not.toMatch(/^\/admin\/consent/)
    expect(location(await get(app, '/admin', jar))).toMatch(/^\/admin\/login(\?|$)/)

    const page = await get(app, location(login), jar)
    expect(page.statusCode).toBe(200)
    const oauthQuery = parseHtml(page.body).querySelector('input[type="hidden"][name="oauth_query"]')?.getAttribute('value')
    expect(oauthQuery).toMatch(/\bsig=/)

    const code = await postForm(app, '/admin/login/code', { code: totpCode(key), oauth_query: oauthQuery!, next: '/admin' }, { jar })
    expect(code.statusCode, code.body).toBe(302)
    expect(location(code)).toMatch(/^\/admin\/consent\?.*\bsig=/)
  })

  it("closes the plugin's endpoints to browsers", async () => {
    const { app } = await withOwner()
    const client = await signIn(app, OWNER)
    for (const path of [
      '/api/auth/two-factor/enable',
      '/api/auth/two-factor/verify-backup-code',
      '/api/auth/two-factor/send-otp',
      '/api/auth/x/../two-factor/disable',
      '/api/auth/%2e/two-factor/disable',
    ]) {
      expect(await rawPost(app, path, client.cookie, { password: OWNER_PASSWORD, code: '000000' }), path).toBe(404)
    }
    const session = await client.get('/api/auth/get-session')
    expect(session.statusCode).toBe(200)
  })

  it("closes better-auth's owner endpoints, so an owner can't act as a user or turn their two-step login off", async () => {
    const { app, service, editor } = await withOwner()
    const editorClient = await signIn(app, 'editor@example.com')
    await turnOnTwoStep(service, editorClient.cookie)
    const client = await signIn(app, OWNER)
    const userId = editor.actor.id!
    for (const [path, body] of [
      ['/api/auth/admin/impersonate-user', { userId }],
      ['/api/auth/admin/update-user', { userId, data: { twoFactorEnabled: false } }],
      ['/api/auth/admin/set-user-password', { userId, newPassword: 'a brand new password' }],
      ['/api/auth/x/../admin/impersonate-user', { userId }],
      ['/api/auth/%2e/admin/impersonate-user', { userId }],
    ] as const) {
      expect(await rawPost(app, path, client.cookie, body), path).toBe(404)
    }
    const list = await client.get('/api/auth/admin/list-users')
    expect(list.statusCode).toBe(404)
    expect(await service.twoStepOn(userId)).toBe(true)
    // The owner's own screens still work: they go through the service, not these endpoints.
    expect((await client.get('/admin/users')).statusCode).toBe(200)
  })

  describe('passwords and removal', () => {
    const EDITOR = 'editor@example.com'
    const NEW_PASSWORD = 'a brand new password'

    /** An app whose editor has two-step login on. */
    async function withEditorTwoStep() {
      const made = await withOwner()
      const client = await signIn(made.app, EDITOR)
      await turnOnTwoStep(made.service, client.cookie)
      return made
    }

    /** Posts the editor's password to the login form and says where it leads. */
    async function loginLocation(a: FastifyInstance, password: string) {
      const res = await postForm(a, '/admin/login', { email: EDITOR, password })
      expect(res.statusCode, res.body).toBe(302)
      return location(res)
    }

    it('keeps two-step login on when an owner sets a new password', async () => {
      const { app, service, owner, editor } = await withEditorTwoStep()
      await service.setPassword(owner.actor, editor.actor.id!, NEW_PASSWORD)
      expect(await service.twoStepOn(editor.actor.id!)).toBe(true)
      expect(await loginLocation(app, NEW_PASSWORD)).toMatch(/^\/admin\/login\/code(\?|$)/)
    })

    it('keeps it on when the user changes their own password', async () => {
      const { app, service, editor } = await withEditorTwoStep()
      await service.changePassword(editor.actor.id!, OWNER_PASSWORD, NEW_PASSWORD)
      expect(await service.twoStepOn(editor.actor.id!)).toBe(true)
      expect(await loginLocation(app, NEW_PASSWORD)).toMatch(/^\/admin\/login\/code(\?|$)/)
    })

    it("leaves the session of a user without two-step login alone, and drops a setup they didn't confirm", async () => {
      const { app, service, editor } = await withOwner()
      const client = await signIn(app, EDITOR)
      const post = (path: string, body: unknown) =>
        service.auth.handler(
          new Request(`${service.issuer}${path}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              origin: new URL(service.issuer).origin,
              cookie: client.cookie,
            },
            body: JSON.stringify(body),
          }),
        )
      const rows = async () => {
        const { adapter } = await service.auth.$context
        return adapter.findMany({ model: 'twoFactor', where: [{ field: 'userId', value: editor.actor.id! }] })
      }
      expect((await post('/two-factor/enable', { password: OWNER_PASSWORD })).ok).toBe(true)
      expect(await rows()).toHaveLength(1)
      expect(await service.twoStepOn(editor.actor.id!)).toBe(false)

      expect(await service.resetTwoFactor(editor.actor.id!)).toBe(false)
      expect(await rows()).toHaveLength(0)
      const session = await service.auth.api.getSession({ headers: new Headers({ cookie: client.cookie }) })
      expect(session).not.toBeNull()
      expect((await post('/two-factor/enable', { password: OWNER_PASSWORD })).ok).toBe(true)
    })

    it('leaves nothing behind when the user is removed', async () => {
      const { db, auth, owner, editor } = await makeAuth()
      const login = await auth.auth.handler(
        new Request(`${auth.issuer}/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: new URL(auth.issuer).origin },
          body: JSON.stringify({ email: 'eddie@example.com', password: 'editor-password' }),
        }),
      )
      const cookie = login.headers
        .getSetCookie()
        .map((line) => line.split(';')[0])
        .join('; ')
      await turnOnTwoStep(auth, cookie, 'editor-password')
      const rows = () => sql<{ n: number }>`select count(*) as n from "twoFactor" where "userId" = ${editor.id!}`.execute(db)
      expect((await rows()).rows[0]?.n).toBe(1)
      await auth.removeUser(owner, editor.id!)
      expect((await rows()).rows[0]?.n).toBe(0)
    })
  })
})
