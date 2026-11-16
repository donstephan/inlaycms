import Fastify, { type FastifyInstance, type FastifyServerOptions, type LightMyRequestResponse } from 'fastify'
import { inlay } from '../../src/adapters/site/plugin.js'
import { t } from '../../src/core/messages/index.js'
import { escapeHtml } from '../../src/jsx/html.js'
import { appOptions, makeApp, OWNER_PASSWORD } from '../helpers/app.js'

const ORIGIN = 'https://example.com'
const SESSION = '__Secure-better-auth.session_token'
const PASSWORD = 'correct horse battery'

const open: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()))
})

async function app(opts: Parameters<typeof makeApp>[0] = {}) {
  const made = await makeApp(opts)
  open.push(made.app)
  return made
}

async function withOwner(opts: { rateLimit?: boolean } = {}) {
  const made = await makeApp({ withOwner: true, ...opts })
  open.push(made.app)
  return made
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

async function post(
  a: FastifyInstance,
  url: string,
  fields: Record<string, string>,
  opts: { jar?: Jar; origin?: string | null; headers?: Record<string, string> } = {},
) {
  const origin = opts.origin === undefined ? ORIGIN : opts.origin
  const res = await a.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(origin !== null && { origin }),
      ...opts.jar?.header(),
      ...opts.headers,
    },
    payload: new URLSearchParams(fields).toString(),
  })
  opts.jar?.store(res)
  return res
}

const setup = {
  name: 'Olivia Owner',
  email: 'olivia@example.com',
  password: 'a long enough password',
  confirm: 'a long enough password',
}

async function login(a: FastifyInstance, email = 'owner@example.com', next?: string) {
  const jar = new Jar()
  const res = await post(a, '/admin/login', { email, password: PASSWORD, ...(next !== undefined && { next }) }, { jar })
  return { res, jar }
}

describe('first run', () => {
  it('sends /admin to setup when there is no owner', async () => {
    const { app: a } = await app()
    const res = await get(a, '/admin')
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/admin/setup')
  })

  it('labels every input on the setup page', async () => {
    const { app: a } = await app()
    const res = await get(a, '/admin/setup')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    for (const name of ['name', 'email', 'password', 'confirm']) {
      expect(res.body).toMatch(new RegExp(`<input[^>]*name="${name}"`))
    }
    const inputs = [...res.body.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]).filter((tag) => !/type="hidden"/.test(tag))
    expect(inputs.length).toBe(4)
    for (const tag of inputs) {
      const id = /\bid="([^"]+)"/.exec(tag)?.[1]
      expect(id, tag).toBeDefined()
      expect(res.body).toContain(`<label for="${id}"`)
    }
  })

  it('refuses a setup POST without the site origin', async () => {
    const { app: a } = await app()
    expect((await post(a, '/admin/setup', setup, { origin: null })).statusCode).toBe(403)
    expect((await post(a, '/admin/setup', setup, { origin: 'https://evil.example' })).statusCode).toBe(403)
    expect((await get(a, '/admin')).headers.location).toBe('/admin/setup')
  })

  it('shows problems next to their fields', async () => {
    const { app: a } = await app()
    const differ = await post(a, '/admin/setup', { ...setup, confirm: 'something else entirely' })
    expect(differ.statusCode).toBe(400)
    expect(differ.body).toContain(escapeHtml(t('auth.passwordsDiffer')))
    expect(differ.body).toContain('value="olivia@example.com"')

    const short = await post(a, '/admin/setup', { ...setup, email: 'nope', password: 'short', confirm: 'short' })
    expect(short.statusCode).toBe(400)
    expect(short.body).toContain(escapeHtml(t('issue.email', { field: t('label.user.email') })))
    expect(short.body).toContain(escapeHtml(t('issue.tooShort', { field: t('label.user.password'), min: 10 })))
    expect((await get(a, '/admin')).headers.location).toBe('/admin/setup')
  })

  it('creates the owner, signs them in, and closes setup', async () => {
    const { app: a } = await app()
    const jar = new Jar()
    const res = await post(a, '/admin/setup', setup, { jar })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/admin')
    expect(jar.cookies.has(SESSION)).toBe(true)

    const home = await get(a, '/admin', jar)
    expect(home.statusCode).toBe(200)
    expect(home.body).toContain('Signed in as')
    expect(home.body).toContain('Olivia Owner')

    const again = await get(a, '/admin/setup')
    expect(again.statusCode).toBe(302)
    expect(again.headers.location).toBe('/admin/login')
    const repost = await post(a, '/admin/setup', { ...setup, email: 'mallory@example.com' })
    expect(repost.statusCode).toBe(302)
    expect(repost.headers.location).toBe('/admin/login')
    expect((await login(a, 'mallory@example.com')).res.statusCode).toBe(401)
  })

  it('makes exactly one owner from two concurrent setups', async () => {
    const { app: a } = await app()
    const [one, two] = await Promise.all([
      post(a, '/admin/setup', setup),
      post(a, '/admin/setup', { ...setup, name: 'Mallory', email: 'mallory@example.com' }),
    ])
    const locations = [one!.headers.location, two!.headers.location].sort()
    expect([one!.statusCode, two!.statusCode]).toEqual([302, 302])
    expect(locations).toEqual(['/admin', '/admin/login'])
    const winner = one!.headers.location === '/admin' ? setup.email : 'mallory@example.com'
    const loser = winner === setup.email ? 'mallory@example.com' : setup.email
    const ok = await post(a, '/admin/login', { email: winner, password: setup.password })
    expect(ok.statusCode).toBe(302)
    expect((await post(a, '/admin/login', { email: loser, password: setup.password })).statusCode).toBe(401)
  })
})

describe('login', () => {
  it('sends /admin to the login page without a session', async () => {
    const { app: a } = await withOwner()
    const res = await get(a, '/admin')
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/admin/login?next=%2Fadmin')
  })

  it('renders hidden next and oauth_query fields', async () => {
    const { app: a } = await withOwner()
    const plain = await get(a, '/admin/login?next=%2Fadmin%2Fpublish')
    expect(plain.statusCode).toBe(200)
    expect(plain.body).toMatch(/<input type="hidden" name="next" value="\/admin\/publish">/)
    expect(plain.body).not.toContain('name="oauth_query"')

    const oauth = await get(a, '/admin/login?client_id=abc&exp=1&sig=xyz')
    expect(oauth.body).toContain('name="oauth_query" value="client_id=abc&amp;exp=1&amp;sig=xyz"')
    const evil = await get(a, '/admin/login?next=%2F%2Fevil.com')
    expect(evil.body).toContain('name="next" value="/admin"')
  })

  it('refuses a login POST without the site origin, and sets no session', async () => {
    const { app: a } = await withOwner()
    const fields = { email: 'owner@example.com', password: OWNER_PASSWORD, next: '/admin' }
    for (const origin of [null, 'https://evil.example']) {
      const res = await post(a, '/admin/login', fields, { origin })
      expect(res.statusCode).toBe(403)
      expect(res.headers['set-cookie']).toBeUndefined()
    }
  })

  it('refuses a wrong password without saying whether the email exists', async () => {
    const { app: a } = await withOwner()
    const wrong = await post(a, '/admin/login', { email: 'owner@example.com', password: 'wrong password!' })
    const unknown = await post(a, '/admin/login', { email: 'nobody@example.com', password: 'wrong password!' })
    expect(wrong.statusCode).toBe(401)
    expect(unknown.statusCode).toBe(401)
    expect(wrong.body).toContain(escapeHtml(t('auth.loginFailed')))
    expect(wrong.body.replace('owner@example.com', '')).toBe(unknown.body.replace('nobody@example.com', ''))
    expect(wrong.headers['set-cookie']).toBeUndefined()
  })

  it('signs in and follows a safe next', async () => {
    const { app: a } = await withOwner()
    const { res, jar } = await login(a, 'owner@example.com', '/admin/publish')
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/admin/publish')
    expect(jar.cookies.has(SESSION)).toBe(true)
    const home = await get(a, '/admin', jar)
    expect(home.statusCode).toBe(200)
    expect(home.body).toContain(escapeHtml(t('admin.signedInAs', { name: 'Olivia Owner', role: t('role.owner') })))
    expect(home.body).toContain('href="/admin/publish"')
    expect(home.body).toMatch(/<form method="post" action="\/admin\/logout"/)
  })

  it('shows an editor their role', async () => {
    const { app: a } = await withOwner()
    const { jar } = await login(a, 'editor@example.com')
    const home = await get(a, '/admin', jar)
    expect(home.body).toContain(escapeHtml(t('admin.signedInAs', { name: 'Eddie Editor', role: t('role.editor') })))
  })

  it('ignores a next that leaves the site', async () => {
    const { app: a } = await withOwner()
    for (const next of ['//evil.com', 'https://evil.com', '/\\evil.com', '/.//evil.com', 'javascript:alert(1)']) {
      const { res } = await login(a, 'owner@example.com', next)
      expect(res.statusCode, next).toBe(302)
      expect(res.headers.location, next).toBe('/admin')
    }
  })

  it('limits attempts per client, whatever IP header the client sends', async () => {
    const { app: a } = await withOwner({ rateLimit: true })
    const bad = { email: 'owner@example.com', password: 'wrong password!' }
    for (let i = 0; i < 3; i++) expect((await post(a, '/admin/login', bad)).statusCode).toBe(401)
    const limited = await post(a, '/admin/login', bad, { headers: { 'x-inlay-client-ip': '1.2.3.4' } })
    expect(limited.statusCode).toBe(429)
    expect(limited.body).toContain(escapeHtml(t('auth.tooManyAttempts')))
  })

  it('logs out and ends the session', async () => {
    const { app: a } = await withOwner()
    const { jar } = await login(a)
    const old = jar.header()
    expect((await post(a, '/admin/logout', {}, { jar, origin: null })).statusCode).toBe(403)
    expect((await get(a, '/admin', jar)).statusCode).toBe(200)

    const out = await post(a, '/admin/logout', {}, { jar })
    expect(out.statusCode).toBe(302)
    expect(out.headers.location).toBe('/admin/login')
    expect(jar.cookies.has(SESSION)).toBe(false)
    expect((await get(a, '/admin', jar)).headers.location).toBe('/admin/login?next=%2Fadmin')
    const replay = await a.inject({ method: 'GET', url: '/admin', headers: old })
    expect(replay.statusCode).toBe(302)
  })

  it('sends no-store and noindex on every admin page', async () => {
    const { app: a } = await withOwner()
    const { jar } = await login(a)
    const responses = [
      await get(a, '/admin'),
      await get(a, '/admin', jar),
      await get(a, '/admin/setup'),
      await get(a, '/admin/login'),
      await post(a, '/admin/login', { email: 'owner@example.com', password: 'wrong password!' }),
      await post(a, '/admin/setup', setup, { origin: null }),
      await post(a, '/admin/logout', {}, { jar }),
    ]
    for (const res of responses) {
      expect(res.headers['cache-control'], res.raw.req.url).toBe('no-store')
      expect(res.headers['x-robots-tag'], res.raw.req.url).toBe('noindex')
    }
  })
})

describe('better-auth mount', () => {
  it('forwards /api/auth and .well-known requests to better-auth', async () => {
    const { app: a } = await withOwner()
    const ok = await get(a, '/api/auth/ok')
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ ok: true })

    for (const url of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/api/auth',
      '/.well-known/openid-configuration',
    ]) {
      const metadata = await get(a, url)
      expect(metadata.statusCode, url).toBe(200)
      expect(metadata.json(), url).toMatchObject({ issuer: 'https://example.com/api/auth' })
    }
    const resource = await get(a, '/.well-known/oauth-protected-resource/mcp')
    expect(resource.json()).toMatchObject({ resource: 'https://example.com/mcp' })
  })

  it('forwards raw bodies with their content type', async () => {
    const { app: a } = await withOwner()
    const res = await a.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      payload: JSON.stringify({ email: 'owner@example.com', password: PASSWORD }),
    })
    expect(res.statusCode).toBe(200)
    expect(new Jar().store(res).cookies.has(SESSION)).toBe(true)
  })

  it('forwards urlencoded bodies untouched', async () => {
    const { app: a } = await withOwner()
    const res = await a.inject({
      method: 'POST',
      url: '/api/auth/oauth2/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'grant_type=authorization_code&code=nope&client_id=nobody',
    })
    expect(res.statusCode).not.toBe(415)
    expect(res.json()).toMatchObject({ error: expect.any(String) })
  })
})

describe('behind a reverse proxy', () => {
  /** The messages Inlay logs at warn level or above over two requests, for an app built with `options`. */
  async function warnings(options: FastifyServerOptions, baseUrl = ORIGIN): Promise<string[]> {
    const lines: string[] = []
    const a = Fastify({ ...options, logger: { level: 'warn', stream: { write: (line: string) => lines.push(line) } } })
    open.push(a)
    await a.register(inlay, await appOptions({ baseUrl }))
    await a.inject({ method: 'GET', url: '/admin/login' })
    await a.inject({ method: 'GET', url: '/admin/login' })
    return lines.map((line) => (JSON.parse(line) as { msg: string }).msg)
  }

  it('warns once when an https site has no trustProxy', async () => {
    expect(await warnings({})).toEqual([t('log.noTrustProxy', { baseUrl: ORIGIN })])
  })

  it('stays quiet with trustProxy, or when the site is plain http', async () => {
    expect(await warnings({ trustProxy: '127.0.0.1' })).toEqual([])
    expect(await warnings({ trustProxy: ['10.0.0.0/8', '127.0.0.1'] })).toEqual([])
    expect(await warnings({}, 'http://localhost:3000')).toEqual([])
  })
})
