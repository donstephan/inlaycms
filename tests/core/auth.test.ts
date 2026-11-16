import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPair, SignJWT } from 'jose'
import type { Kysely } from 'kysely'
import { can, canPush } from '../../src/core/auth/roles.js'
import { createAuthService, type AuthService } from '../../src/core/auth/service.js'
import { createUploadToken, UPLOAD_TTL_MS, verifyUploadToken } from '../../src/core/auth/upload-token.js'
import { bootInlay, type BootOptions } from '../../src/core/boot.js'
import { openDatabase } from '../../src/core/db/connection.js'
import type { Database } from '../../src/core/db/schema.js'
import { InlayError } from '../../src/core/errors.js'
import { createPreviewToken } from '../../src/core/preview.js'
import { site } from '../fixtures/site.js'
import { makeAuth, TEST_BASE_URL } from '../helpers/auth.js'
import { makeCore } from '../helpers/core.js'

async function rejection(p: Promise<unknown>): Promise<InlayError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(InlayError)
    return e as InlayError
  }
  throw new Error('expected a rejection')
}

const secret = () => randomBytes(32).toString('base64url')

/** Migrated auth tables and no users. */
async function bareAuth(): Promise<AuthService> {
  const { db } = await makeCore()
  const auth = createAuthService({ db, secret: secret(), baseUrl: TEST_BASE_URL, rateLimit: false })
  await auth.migrate()
  return auth
}

describe('bootInlay with auth', () => {
  let dir: string
  let opts: (withAuth: boolean) => BootOptions
  const open: Array<Kysely<Database>> = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inlay-auth-'))
    const authOpts = { secret: secret(), baseUrl: TEST_BASE_URL, rateLimit: false }
    opts = (withAuth) => ({ site, db: join(dir, 'site.db'), backups: join(dir, 'backups'), ...(withAuth && { auth: authOpts }) })
  })

  afterEach(async () => {
    for (const db of open.splice(0)) await db.destroy()
    await rm(dir, { recursive: true, force: true })
  })

  it('creates the auth tables on a fresh database', async () => {
    const { db, auth, backup } = await bootInlay(opts(true))
    open.push(db)
    expect(backup).toBeNull()
    const tables = (await db.introspection.getTables()).map((t) => t.name)
    for (const name of ['user', 'session', 'account', 'jwks', 'oauthClient', 'apikey']) expect(tables).toContain(name)
    expect(auth).not.toBeNull()
    expect(await auth!.migrationsPending()).toBe(false)
  })

  it('has no auth service without auth options', async () => {
    const { db, auth } = await bootInlay(opts(false))
    open.push(db)
    expect(auth).toBeNull()
    expect((await db.introspection.getTables()).map((t) => t.name)).not.toContain('user')
  })

  it('backs up before adding the auth tables to an existing database', async () => {
    await (await bootInlay(opts(false))).db.destroy()
    const { db, backup, auth } = await bootInlay(opts(true))
    open.push(db)
    expect(backup?.reason).toBe('pre-migration')
    expect((await readdir(join(dir, 'backups'))).filter((f) => f.endsWith('-pre-migration.tar.gz'))).toHaveLength(1)
    expect(await auth!.migrationsPending()).toBe(false)
  })
})

describe('AuthService', () => {
  it('uses better-auth’s issuer and the MCP resource', async () => {
    const { auth } = await makeAuth()
    expect(auth.issuer).toBe((await auth.auth.$context).baseURL)
    expect(auth.issuer).toBe(`${TEST_BASE_URL}/api/auth`)
    expect(auth.resource).toBe(`${TEST_BASE_URL}/mcp`)
  })

  describe('createOwner', () => {
    it('rejects a short password, then creates the owner', async () => {
      const auth = await bareAuth()
      const e = await rejection(auth.createOwner({ email: 'o@example.com', name: 'Olivia', password: '123456789' }))
      expect(e.code).toBe('validation')
      expect(e.details.issues?.map((i) => i.path)).toEqual([['password']])
      expect(await auth.hasOwner()).toBe(false)

      const owner = await auth.createOwner({ email: 'o@example.com', name: 'Olivia', password: '1234567890' })
      expect(owner).toEqual({ id: expect.any(String), name: 'Olivia', role: 'owner' })
      expect(await auth.hasOwner()).toBe(true)
    })

    it('rejects a bad email and a missing name', async () => {
      const auth = await bareAuth()
      const e = await rejection(auth.createOwner({ email: 'not an email', name: ' ', password: '1234567890' }))
      expect(e.code).toBe('validation')
      expect(e.details.issues?.map((i) => i.path)).toEqual([['email'], ['name']])
    })

    it('makes exactly one owner when called twice at once', async () => {
      const auth = await bareAuth()
      const results = await Promise.allSettled([
        auth.createOwner({ email: 'a@example.com', name: 'A', password: '1234567890' }),
        auth.createOwner({ email: 'b@example.com', name: 'B', password: '1234567890' }),
      ])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const failed = results.find((r) => r.status === 'rejected')
      expect((failed?.reason as InlayError).code).toBe('invalid_operation')
      expect((failed?.reason as InlayError).messageId).toBe('error.ownerExists')
    })

    it('makes exactly one owner when two processes race on the same database', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'inlay-owner-'))
      const dbs = [openDatabase(join(dir, 'site.db')), openDatabase(join(dir, 'site.db'))]
      try {
        const key = secret()
        const [a, b] = dbs.map((db) => createAuthService({ db, secret: key, baseUrl: TEST_BASE_URL, rateLimit: false }))
        await a!.migrate()
        const users = [
          { email: 'a@example.com', name: 'A', password: '1234567890' },
          { email: 'b@example.com', name: 'B', password: '1234567890' },
        ]
        const results = await Promise.allSettled([a!.createOwner(users[0]!), b!.createOwner(users[1]!)])
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
        const lost = results.findIndex((r) => r.status === 'rejected')
        const reason = (results[lost] as PromiseRejectedResult).reason as InlayError
        expect(reason).toBeInstanceOf(InlayError)
        expect(reason.messageId).toBe('error.ownerExists')

        const owners = await dbs[0]!.selectFrom('user').select('email').where('role', '=', 'owner').execute()
        expect(owners).toEqual([{ email: users[1 - lost]!.email }])
        const loser = users[lost]!
        await expect(a!.auth.api.signInEmail({ body: { email: loser.email, password: loser.password } })).rejects.toThrow()
        const winner = users[1 - lost]!
        await expect(a!.auth.api.signInEmail({ body: { email: winner.email, password: winner.password } })).resolves.toBeDefined()
      } finally {
        for (const db of dbs) await db.destroy()
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('refuses once an owner exists', async () => {
      const { auth } = await makeAuth()
      const e = await rejection(auth.createOwner({ email: 'x@example.com', name: 'X', password: '1234567890' }))
      expect(e.code).toBe('invalid_operation')
    })
  })

  it('rejects a second user with the same email', async () => {
    const { auth } = await makeAuth()
    const e = await rejection(auth.createUser({ email: 'eddie@example.com', name: 'Other', password: '1234567890', role: 'editor' }))
    expect(e.code).toBe('validation')
    expect(e.details.issues?.map((i) => i.path)).toEqual([['email']])
  })

  describe('actorForUser', () => {
    it('reads the user row each time', async () => {
      const { auth, db, editor } = await makeAuth()
      const id = editor.id!
      expect(await auth.actorForUser(id)).toEqual({ id, name: 'Eddie Editor', role: 'editor' })

      await db.updateTable('user').set({ role: 'user' }).where('id', '=', id).execute()
      expect(await auth.actorForUser(id)).toBeNull()

      await db.updateTable('user').set({ role: 'editor', banned: 1 }).where('id', '=', id).execute()
      expect(await auth.actorForUser(id)).toBeNull()

      await db.updateTable('user').set({ banExpires: new Date(Date.now() + 60_000).toISOString() }).where('id', '=', id).execute()
      expect(await auth.actorForUser(id)).toBeNull()

      await db.updateTable('user').set({ banExpires: new Date(Date.now() - 1000).toISOString() }).where('id', '=', id).execute()
      expect(await auth.actorForUser(id)).toEqual({ id, name: 'Eddie Editor', role: 'editor' })

      await db.deleteFrom('user').where('id', '=', id).execute()
      expect(await auth.actorForUser(id)).toBeNull()
    })
  })

  it('finds the actor for a session cookie until the user is banned', async () => {
    const { auth, db, editor } = await makeAuth()
    const signIn = await auth.auth.api.signInEmail({
      body: { email: 'eddie@example.com', password: 'editor-password' },
      returnHeaders: true,
    })
    const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    const headers = new Headers({ cookie })
    expect(await auth.sessionActor(headers)).toEqual(editor)
    await db.updateTable('user').set({ banned: 1 }).where('id', '=', editor.id!).execute()
    expect(await auth.sessionActor(headers)).toBeNull()
    expect(await auth.sessionActor(new Headers())).toBeNull()
  })

  describe('API keys', () => {
    it('finds the key owner until the user is deleted', async () => {
      const { auth, db, editor, ownerKey, owner } = await makeAuth()
      expect(await auth.apiKeyActor(ownerKey)).toEqual({ actor: owner, permissions: { release: [] } })
      const key = await auth.createApiKey(editor.id!, 'ci')
      expect(await auth.apiKeyActor(key)).toEqual({ actor: editor, permissions: { release: [] } })
      await db.deleteFrom('user').where('id', '=', editor.id!).execute()
      expect(await auth.apiKeyActor(key)).toBeNull()
    })

    it('gives an owner a key that can push releases', async () => {
      const { auth, owner } = await makeAuth()
      const key = await auth.createApiKey(owner.id!, 'deploy', { permissions: { release: ['push'] } })
      expect(await auth.apiKeyActor(key)).toEqual({ actor: owner, permissions: { release: ['push'] } })
    })

    it("won't give an editor a key that can push releases", async () => {
      const { auth, editor } = await makeAuth()
      const e = await rejection(auth.createApiKey(editor.id!, 'deploy', { permissions: { release: ['push'] } }))
      expect(e.code).toBe('forbidden')
      expect(await auth.listApiKeys(editor.id!)).toHaveLength(1)
    })

    it("only an owner's push key may push", async () => {
      const { auth, db, owner, editor, ownerKey } = await makeAuth()
      const pushKey = await auth.createApiKey(owner.id!, 'deploy', { permissions: { release: ['push'] } })
      const pushes = async (key: string) => {
        const found = await auth.apiKeyActor(key)
        return found !== null && canPush(found.actor, found.permissions)
      }
      expect(await pushes(pushKey)).toBe(true)
      expect(await pushes(ownerKey)).toBe(false)
      // A push key whose owner is now an editor no longer pushes, though it is still a valid key.
      await db.updateTable('user').set({ role: 'editor' }).where('id', '=', owner.id!).execute()
      expect((await auth.apiKeyActor(pushKey))?.actor.role).toBe('editor')
      expect(await pushes(pushKey)).toBe(false)

      expect(canPush(owner, { release: ['push'] })).toBe(true)
      expect(canPush(owner, { release: [] })).toBe(false)
      expect(canPush(owner, {})).toBe(false)
      expect(canPush(editor, { release: ['push'] })).toBe(false)
      expect(canPush({ id: null, name: 'System', role: 'system' }, { release: ['push'] })).toBe(false)
    })

    it('keeps releases to owners', () => {
      for (const action of ['release.push', 'release.activate', 'release.manage'] as const) {
        expect(can('owner', action), action).toBe(true)
        expect(can('editor', action), action).toBe(false)
      }
    })

    it('rejects an unknown key', async () => {
      const { auth } = await makeAuth()
      expect(await auth.apiKeyActor('nope')).toBeNull()
      expect(await auth.apiKeyActor('')).toBeNull()
    })
  })

  describe('bearerActor', () => {
    it('rejects a token that is not a JWT', async () => {
      const { auth } = await makeAuth()
      expect(await auth.bearerActor('x.y.z')).toBeNull()
      expect(await auth.bearerActor('')).toBeNull()
    })

    it('rejects a JWT signed by another key', async () => {
      const { auth, editor } = await makeAuth()
      const { privateKey } = await generateKeyPair('EdDSA')
      const realKid = (await auth.auth.api.getJwks()).keys[0]!.kid!
      for (const kid of ['someone-else', realKid]) {
        const token = await new SignJWT({ azp: 'client-1', scope: 'openid' })
          .setProtectedHeader({ alg: 'EdDSA', kid })
          .setSubject(editor.id!)
          .setIssuer(auth.issuer)
          .setAudience(auth.resource)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey)
        expect(await auth.bearerActor(token)).toBeNull()
      }
    })

    it('rejects a JWT for another audience or without azp', async () => {
      const { auth, editor } = await makeAuth()
      const sign = async (payload: Record<string, unknown>) =>
        (await auth.auth.api.signJWT({ body: { payload: { sub: editor.id!, iss: auth.issuer, iat: Math.floor(Date.now() / 1000), ...payload } } })).token
      expect(await auth.bearerActor(await sign({ aud: `${TEST_BASE_URL}/other`, azp: 'client-1' }))).toBeNull()
      expect(await auth.bearerActor(await sign({ aud: auth.resource }))).toBeNull()
      expect(await auth.bearerActor(await sign({ aud: auth.resource, azp: 'client-1', iss: TEST_BASE_URL }))).toBeNull()
      // The same claims with the right audience are accepted, so the rejections above aren't vacuous.
      const ok = await auth.bearerActor(await sign({ aud: auth.resource, azp: 'client-1', scope: 'openid offline_access' }))
      expect(ok).toMatchObject({ actor: editor, clientId: 'client-1', scopes: ['openid', 'offline_access'] })
    })
  })

  it('reads a registered OAuth client', async () => {
    const { auth } = await makeAuth()
    const res = await auth.auth.handler(
      new Request(`${TEST_BASE_URL}/api/auth/oauth2/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-inlay-client-ip': '127.0.0.1' },
        body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none' }),
      }),
    )
    expect(res.status).toBe(201)
    const { client_id } = (await res.json()) as { client_id: string }
    expect(await auth.oauthClient(client_id)).toEqual({ name: 'Claude', redirectUris: ['https://evil.example/cb'] })
    expect(await auth.oauthClient('unknown')).toBeNull()
  })
})

describe('upload tokens', () => {
  const key = secret()
  const now = new Date('2026-10-29T12:00:00.000Z')

  it('round-trips the user and expiry', () => {
    const token = createUploadToken(key, 'user-1', now)
    expect(token).toMatch(/^u1\.[A-Za-z0-9_-]+\.[0-9a-z]+\.[A-Za-z0-9_-]{43}$/)
    expect(verifyUploadToken(key, token, now)).toEqual({ userId: 'user-1', expiresAt: new Date(now.getTime() + UPLOAD_TTL_MS) })
    expect(verifyUploadToken(key, token, new Date(now.getTime() + UPLOAD_TTL_MS - 1))).not.toBeNull()
  })

  it('rejects tampered, foreign and expired tokens', () => {
    const token = createUploadToken(key, 'user-1', now)
    const [prefix, , expiry, signature] = token.split('.')
    const tampered = [prefix, Buffer.from('user-2').toString('base64url'), expiry, signature].join('.')
    expect(verifyUploadToken(key, tampered, now)).toBeNull()
    expect(verifyUploadToken(secret(), token, now)).toBeNull()
    expect(verifyUploadToken(key, createPreviewToken(key, now), now)).toBeNull()
    expect(verifyUploadToken(key, token, new Date(now.getTime() + UPLOAD_TTL_MS + 1))).toBeNull()
    expect(verifyUploadToken(key, 'garbage', now)).toBeNull()
  })
})
