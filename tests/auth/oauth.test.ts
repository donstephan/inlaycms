import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { t } from '../../src/core/messages/index.js'
import { escapeHtml } from '../../src/jsx/html.js'
import { makeApp, OWNER_PASSWORD } from '../helpers/app.js'

const ORIGIN = 'https://example.com'
const RESOURCE = 'https://example.com/mcp'
const REDIRECT = 'http://localhost:7777/cb'
const CHALLENGE = `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`

const open: FastifyInstance[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(open.splice(0).map((app) => app.close()))
})

async function withOwner() {
  const made = await makeApp({ withOwner: true })
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

async function postForm(a: FastifyInstance, url: string, fields: Record<string, string>, opts: { jar?: Jar; origin?: string | null } = {}) {
  const origin = opts.origin === undefined ? ORIGIN : opts.origin
  const res = await a.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(origin !== null && { origin }),
      ...opts.jar?.header(),
    },
    payload: new URLSearchParams(fields).toString(),
  })
  opts.jar?.store(res)
  return res
}

const location = (res: LightMyRequestResponse) => String(res.headers.location ?? '')

/** The `Location` of a GET sent over a real socket with `path` exactly as written (`inject` would normalize it). */
async function rawLocation(a: FastifyInstance, path: string, jar: Jar): Promise<string> {
  const address = a.server.address() ?? (await a.listen({ port: 0, host: '127.0.0.1' }), a.server.address())
  const { port } = address as AddressInfo
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: jar.header() }, (res) => {
      res.resume()
      resolve(String(res.headers.location ?? ''))
    })
    req.on('error', reject)
    req.end()
  })
}
const queryOf = (url: string) => url.slice(url.indexOf('?') + 1)

function mcp(a: FastifyInstance, headers: Record<string, string>) {
  return a.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  })
}

function expectUnauthorized(res: LightMyRequestResponse) {
  expect(res.statusCode).toBe(401)
  expect(res.headers['www-authenticate']).toBe(CHALLENGE)
  expect(res.json()).toEqual({ jsonrpc: '2.0', error: { code: -32001, message: t('mcp.unauthorized') }, id: null })
}

async function register(a: FastifyInstance, name = 'Claude', redirects: string[] = [REDIRECT]): Promise<string> {
  const res = await a.inject({
    method: 'POST',
    url: '/api/auth/oauth2/register',
    headers: { 'content-type': 'application/json' },
    payload: { client_name: name, redirect_uris: redirects, token_endpoint_auth_method: 'none' },
  })
  expect(res.statusCode, res.body).toBeLessThan(300)
  const clientId: unknown = res.json().client_id
  expect(typeof clientId).toBe('string')
  return clientId as string
}

/** The authorize URL for `clientId` sending the user back to `redirect`, with a fresh PKCE verifier. */
function authorizeUrl(clientId: string, redirect: string) {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const url = `/api/auth/oauth2/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    scope: 'openid profile email offline_access',
    state: 'state-123',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
  }).toString()}`
  return { url, verifier }
}

/** Registers a client, starts authorize, logs in as the owner and lands on the consent page. */
async function toConsent(a: FastifyInstance, opts: { name?: string; redirect?: string; redirects?: string[]; password?: string } = {}) {
  const redirect = opts.redirect ?? REDIRECT
  const clientId = await register(a, opts.name, opts.redirects ?? [redirect])
  const { url, verifier } = authorizeUrl(clientId, redirect)
  const authorize = await get(a, url)
  expect(authorize.statusCode, authorize.body).toBe(302)
  expect(location(authorize)).toMatch(/^\/admin\/login\?.*\bsig=/)

  const jar = new Jar()
  const loginPage = await get(a, location(authorize), jar)
  expect(loginPage.statusCode).toBe(200)
  expect(loginPage.body).toContain('name="oauth_query"')
  const login = await postForm(
    a,
    '/admin/login',
    { email: 'owner@example.com', password: opts.password ?? OWNER_PASSWORD, oauth_query: queryOf(location(authorize)) },
    { jar },
  )
  expect(login.statusCode, login.body).toBe(302)
  // No code without consent: the login leads to the consent page, never to the client.
  expect(location(login)).toMatch(/^\/admin\/consent\?.*\bsig=/)

  const consent = await get(a, location(login), jar)
  return { clientId, verifier, jar, consent, consentUrl: location(login) }
}

function hiddenOauthQuery(body: string): string {
  const value = /name="oauth_query" value="([^"]*)"/.exec(body)?.[1]
  expect(value).toBeDefined()
  return (value ?? '').replaceAll('&amp;', '&')
}

async function exchange(a: FastifyInstance, clientId: string, code: string, verifier: string) {
  return a.inject({
    method: 'POST',
    url: '/api/auth/oauth2/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    }).toString(),
  })
}

describe('metadata', () => {
  it('serves the protected resource and authorization server metadata', async () => {
    const { app: a } = await withOwner()
    const resource = await get(a, '/.well-known/oauth-protected-resource/mcp')
    expect(resource.statusCode).toBe(200)
    expect(resource.json().resource).toBe(RESOURCE)

    const server = await get(a, '/.well-known/oauth-authorization-server')
    expect(server.statusCode).toBe(200)
    const meta = server.json()
    for (const key of ['registration_endpoint', 'authorization_endpoint', 'token_endpoint']) {
      expect(typeof meta[key], key).toBe('string')
    }
  })
})

describe('the OAuth flow', () => {
  it('logs in, asks for consent, issues a token, and lets it through /mcp', async () => {
    const { app: a, service, owner } = await withOwner()
    const { clientId, verifier, jar, consent } = await toConsent(a)
    expect(consent.statusCode).toBe(200)
    expect(consent.headers['cache-control']).toBe('no-store')
    expect(consent.body).toContain(escapeHtml(t('auth.consent.title', { client: 'Claude' })))
    expect(consent.body).toContain(escapeHtml(t('auth.consent.redirect', { host: 'localhost:7777' })))
    expect(consent.body).toContain(escapeHtml(t('auth.consent.scope.email')))

    const allow = await postForm(a, '/admin/consent', { accept: 'true', oauth_query: hiddenOauthQuery(consent.body) }, { jar })
    expect(allow.statusCode, allow.body).toBe(302)
    const back = new URL(location(allow))
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT)
    expect(back.searchParams.get('state')).toBe('state-123')
    const code = back.searchParams.get('code')
    expect(code).toBeTruthy()

    const token = await exchange(a, clientId, code!, verifier)
    expect(token.statusCode, token.body).toBe(200)
    const accessToken: unknown = token.json().access_token
    expect(typeof accessToken).toBe('string')

    const bearer = await service.bearerActor(accessToken as string)
    expect(bearer?.actor.id).toBe(owner.actor.id)
    expect(bearer?.clientId).toBe(clientId)

    const passed = await mcp(a, { authorization: `Bearer ${accessToken as string}` })
    expect(passed.statusCode).toBe(200)

    // An hour and a second later the token has expired.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 3601_000)
    expectUnauthorized(await mcp(a, { authorization: `Bearer ${accessToken as string}` }))
    vi.useRealTimers()
    expect((await mcp(a, { authorization: `Bearer ${accessToken as string}` })).statusCode).toBe(200)

    // Lost access: a role Inlay doesn't know stops the token on the next request.
    const ctx = await service.auth.$context
    await ctx.internalAdapter.updateUser(owner.actor.id!, { role: 'user' })
    expectUnauthorized(await mcp(a, { authorization: `Bearer ${accessToken as string}` }))
  })

  it('ends tokens, refresh tokens and API keys when an owner sets a new password', async () => {
    const { app: a, service, owner, ownerKey } = await withOwner()
    const tokenFor = async (password?: string) => {
      const { clientId, verifier, jar, consent } = await toConsent(a, password === undefined ? {} : { password })
      const allow = await postForm(a, '/admin/consent', { accept: 'true', oauth_query: hiddenOauthQuery(consent.body) }, { jar })
      const code = new URL(location(allow)).searchParams.get('code')
      const token = await exchange(a, clientId, code!, verifier)
      expect(token.statusCode, token.body).toBe(200)
      return { clientId, access: token.json().access_token as string, refresh: token.json().refresh_token as string }
    }
    const before = await tokenFor()
    expect(typeof before.refresh).toBe('string')
    expect((await mcp(a, { authorization: `Bearer ${before.access}` })).statusCode).toBe(200)
    expect((await mcp(a, { 'x-api-key': ownerKey })).statusCode).toBe(200)

    await service.setPassword(owner.actor, owner.actor.id!, 'a brand new password')

    expect(await service.bearerActor(before.access)).toBeNull()
    expectUnauthorized(await mcp(a, { authorization: `Bearer ${before.access}` }))
    expectUnauthorized(await mcp(a, { 'x-api-key': ownerKey }))
    const refreshed = await a.inject({
      method: 'POST',
      url: '/api/auth/oauth2/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: before.refresh, client_id: before.clientId, resource: RESOURCE }).toString(),
    })
    expect(refreshed.statusCode).toBeGreaterThanOrEqual(400)

    // Connecting again with the new password works: the cutoff only covers tokens issued up to the reset.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 2000)
    const after = await tokenFor('a brand new password')
    expect((await service.bearerActor(after.access))?.actor.id).toBe(owner.actor.id)
    expect((await mcp(a, { authorization: `Bearer ${after.access}` })).statusCode).toBe(200)
  })

  it('ends assistant tokens but keeps API keys when users change their own password', async () => {
    const { app: a, service, owner, ownerKey } = await withOwner()
    const tokenFor = async (password?: string) => {
      const { clientId, verifier, jar, consent } = await toConsent(a, password === undefined ? {} : { password })
      const allow = await postForm(a, '/admin/consent', { accept: 'true', oauth_query: hiddenOauthQuery(consent.body) }, { jar })
      const code = new URL(location(allow)).searchParams.get('code')
      const token = await exchange(a, clientId, code!, verifier)
      expect(token.statusCode, token.body).toBe(200)
      return { clientId, access: token.json().access_token as string, refresh: token.json().refresh_token as string }
    }
    const before = await tokenFor()
    expect((await mcp(a, { authorization: `Bearer ${before.access}` })).statusCode).toBe(200)

    await service.changePassword(owner.actor.id!, OWNER_PASSWORD, 'a brand new password 1')

    expect(await service.bearerActor(before.access)).toBeNull()
    expectUnauthorized(await mcp(a, { authorization: `Bearer ${before.access}` }))
    const refreshed = await a.inject({
      method: 'POST',
      url: '/api/auth/oauth2/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: before.refresh, client_id: before.clientId, resource: RESOURCE }).toString(),
    })
    expect(refreshed.statusCode).toBeGreaterThanOrEqual(400)
    expect((await mcp(a, { 'x-api-key': ownerKey })).statusCode).toBe(200)

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 2000)
    const after = await tokenFor('a brand new password 1')
    expect((await service.bearerActor(after.access))?.actor.id).toBe(owner.actor.id)
    expect((await mcp(a, { authorization: `Bearer ${after.access}` })).statusCode).toBe(200)
  })

  it('sends no code when the user denies', async () => {
    const { app: a } = await withOwner()
    const { jar, consent } = await toConsent(a)
    const deny = await postForm(a, '/admin/consent', { accept: 'false', oauth_query: hiddenOauthQuery(consent.body) }, { jar })
    expect(deny.statusCode).toBe(302)
    const back = new URL(location(deny))
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT)
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.has('code')).toBe(false)
  })

  it('names a look-alike client and the host it sends the user to', async () => {
    const { app: a } = await withOwner()
    const { consent } = await toConsent(a, { name: 'Claude', redirect: 'https://evil.example/cb' })
    expect(consent.statusCode).toBe(200)
    expect(consent.body).toContain(escapeHtml(t('auth.consent.title', { client: 'Claude' })))
    expect(consent.body).toContain(escapeHtml(t('auth.consent.redirect', { host: 'evil.example' })))
    expect(consent.body).not.toContain(escapeHtml(t('auth.consent.manyHosts', { client: 'Claude' })))
  })

  it('asks again for a client allowed before, and sends no code to its other address until allowed', async () => {
    const { app: a } = await withOwner()
    const evil = 'https://evil.example/cb'
    const { clientId, jar, consent } = await toConsent(a, { redirects: [REDIRECT, evil] })
    const allow = await postForm(a, '/admin/consent', { accept: 'true', oauth_query: hiddenOauthQuery(consent.body) }, { jar })
    expect(new URL(location(allow)).searchParams.get('code')).toBeTruthy()

    // Asked again even on a path that only reaches authorize once `.`, `..` or `%2e` segments are resolved.
    const query = queryOf(authorizeUrl(clientId, evil).url)
    for (const path of ['/api/auth/./oauth2/authorize', '/api/auth/x/../oauth2/authorize', '/api/auth/%2e/oauth2/authorize']) {
      expect(await rawLocation(a, `${path}?${query}`, jar), path).toMatch(/^\/admin\/consent\?/)
    }

    // Same client, same logged-in user, the other registered address: consent is asked again.
    for (const redirect of [evil, REDIRECT]) {
      const again = await get(a, authorizeUrl(clientId, redirect).url, jar)
      expect(again.statusCode, again.body).toBe(302)
      expect(location(again)).toMatch(/^\/admin\/consent\?.*\bsig=/)
      expect(location(again)).not.toContain('code=')
    }
    // A client asking to skip the page (`prompt=none`) is asked too.
    const silent = await get(a, `${authorizeUrl(clientId, evil).url}&prompt=none`, jar)
    expect(location(silent)).toMatch(/^\/admin\/consent\?/)


    // And one sent as a form POST.
    const form = Object.fromEntries(new URLSearchParams(queryOf(authorizeUrl(clientId, evil).url)))
    const posted = await postForm(a, '/api/auth/oauth2/authorize', form, { jar })
    expect(location(posted), posted.body).toMatch(/^\/admin\/consent\?/)

    const second = await get(a, location(await get(a, authorizeUrl(clientId, evil).url, jar)), jar)
    expect(second.statusCode).toBe(200)
    expect(second.body).toContain(escapeHtml(t('auth.consent.redirect', { host: 'evil.example' })))
    const allowAgain = await postForm(a, '/admin/consent', { accept: 'true', oauth_query: hiddenOauthQuery(second.body) }, { jar })
    const back = new URL(location(allowAgain))
    expect(`${back.origin}${back.pathname}`).toBe(evil)
    expect(back.searchParams.get('code')).toBeTruthy()
  })

  it('lists every address a client can send the user back to, and warns when there are several', async () => {
    const { app: a } = await withOwner()
    const { consent } = await toConsent(a, { redirects: [REDIRECT, 'https://evil.example/cb'] })
    expect(consent.statusCode).toBe(200)
    expect(consent.body).toContain(escapeHtml(t('auth.consent.hosts', { client: 'Claude', hosts: 'localhost:7777, evil.example' })))
    expect(consent.body).toContain(escapeHtml(t('auth.consent.manyHosts', { client: 'Claude' })))
  })

  it("shows an app's own scheme, so it can't pass for a website", async () => {
    const { app: a } = await withOwner()
    const { consent } = await toConsent(a, { redirect: 'evilapp://claude.ai/cb' })
    expect(consent.statusCode, consent.body).toBe(200)
    expect(consent.body).toContain(escapeHtml(t('auth.consent.redirect', { host: 'evilapp://claude.ai' })))
    expect(consent.body).toContain(escapeHtml(t('auth.consent.hosts', { client: 'Claude', hosts: 'evilapp://claude.ai' })))
  })
})

describe('the consent page', () => {
  it('sends a visitor without a session to the login page with the same query', async () => {
    const { app: a } = await withOwner()
    const { consentUrl } = await toConsent(a)
    const res = await get(a, consentUrl)
    expect(res.statusCode).toBe(302)
    expect(location(res)).toBe(`/admin/login?${queryOf(consentUrl)}`)
  })

  it('refuses an unknown client', async () => {
    const { app: a } = await withOwner()
    const { jar, consentUrl } = await toConsent(a)
    const params = new URLSearchParams(queryOf(consentUrl))
    params.set('client_id', 'nobody')
    const res = await get(a, `/admin/consent?${params.toString()}`, jar)
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain(escapeHtml(t('auth.consent.unknownClient')))
  })

  it('refuses a consent POST from another origin', async () => {
    const { app: a } = await withOwner()
    const { jar, consent } = await toConsent(a)
    const query = hiddenOauthQuery(consent.body)
    expect((await postForm(a, '/admin/consent', { accept: 'true', oauth_query: query }, { jar, origin: null })).statusCode).toBe(403)
    const evil = await postForm(a, '/admin/consent', { accept: 'true', oauth_query: query }, { jar, origin: 'https://evil.example' })
    expect(evil.statusCode).toBe(403)
  })

  it('refuses a tampered request', async () => {
    const { app: a } = await withOwner()
    const { jar, consent } = await toConsent(a)
    const query = hiddenOauthQuery(consent.body).replace('state-123', 'state-456')
    const res = await postForm(a, '/admin/consent', { accept: 'true', oauth_query: query }, { jar })
    expect(res.statusCode).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })
})

describe('/mcp', () => {
  it('accepts an API key and refuses a garbage one', async () => {
    const { app: a, editorKey } = await withOwner()
    expect((await mcp(a, { 'x-api-key': editorKey })).statusCode).toBe(200)
    expectUnauthorized(await mcp(a, { 'x-api-key': 'garbage' }))
  })

  it('refuses requests without credentials or with a forged token', async () => {
    const { app: a } = await withOwner()
    expectUnauthorized(await mcp(a, {}))
    expectUnauthorized(await mcp(a, { authorization: 'Bearer not.a.jwt' }))
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await a.inject({ method, url: '/mcp' })
      expectUnauthorized(res)
    }
  })

  it('refuses a foreign Origin even with a valid key', async () => {
    const { app: a, ownerKey } = await withOwner()
    const res = await mcp(a, { 'x-api-key': ownerKey, origin: 'https://evil.example' })
    expect(res.statusCode).toBe(403)
    expect((await mcp(a, { 'x-api-key': ownerKey, origin: ORIGIN })).statusCode).toBe(200)
  })
})
