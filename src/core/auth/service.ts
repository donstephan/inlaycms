import { APIError } from 'better-auth/api'
import { getMigrations } from 'better-auth/db/migration'
import { createLocalJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { sql, type Kysely } from 'kysely'
import { contentIssue } from '../content/validate.js'
import type { Database } from '../db/schema.js'
import { InlayError } from '../errors.js'
import { t, type MessageId } from '../messages/index.js'
import type { Actor, ContentIssue, IssueCode } from '../types.js'
import { assertCan } from './roles.js'
import { AUTH_BASE_PATH, createAuth, MCP_PATH, type AuthOptions, type InlayAuth } from './auth.js'

export type UserRole = 'owner' | 'editor'

export interface UserInput {
  email: string
  name: string
  password: string
}

export interface UserInfo {
  id: string
  name: string
  email: string
  role: UserRole | null
  banned: boolean
  createdAt: string
  /** Whether two-step login is on: a confirmed authenticator app is asked for a code at every login. */
  twoStep: boolean
}

export interface ApiKeyInfo {
  id: string
  name: string
  /** The first characters of the key, to tell keys apart. */
  start: string | null
  createdAt: string
  lastUsedAt: string | null
}

/** The caller of a request made with an API key, and what the key was made to allow beyond its user's role. */
export interface ApiKeyAuth {
  actor: Actor
  /** `release` holds `'push'` for a push key (see `canPush`); empty otherwise. */
  permissions: { release: string[] }
}

export interface ApiKeyOptions {
  /** `release: ['push']` makes a push key; only an owner may have one. */
  permissions?: { release?: ['push'] }
}

/** An assistant (OAuth client) a user has allowed on the consent page. */
export interface AssistantInfo {
  clientId: string
  /** The name the assistant registered itself under, or its client id when it gave none. */
  name: string
  redirectUris: string[]
  /** When the user first allowed it. */
  connectedAt: string
}

export interface BearerAuth {
  actor: Actor
  /** The OAuth client the token was issued to (`azp`). */
  clientId: string
  scopes: string[]
  /** The token's `exp`, in seconds since the epoch (as MCP's `AuthInfo.expiresAt`). */
  expiresAt: number
}

/**
 * Everything Inlay asks of better-auth. Adapters go through this and never
 * query better-auth's tables or call `auth.api.*` themselves (except
 * forwarding requests to `auth.handler`). None of these may be called inside
 * a Kysely transaction: better-auth shares the single SQLite connection.
 */
export interface AuthService {
  auth: InlayAuth
  /** better-auth's issuer for OAuth tokens: `baseUrl` + `AUTH_BASE_PATH`. */
  issuer: string
  /** The MCP protected resource, `${baseUrl}/mcp`: the audience of its access tokens. */
  resource: string
  migrationsPending(): Promise<boolean>
  migrate(): Promise<void>
  hasOwner(): Promise<boolean>
  /** Throws invalid_operation `error.ownerExists`, or validation with plain-language issues (email, password length). */
  createOwner(input: UserInput): Promise<Actor>
  /** Creates an editor or owner; for tests and Phase 6. */
  createUser(input: UserInput & { role: UserRole }): Promise<Actor>
  /** The actor for a user who may use Inlay right now, read from their current row; `null` for unknown, banned or role-less users. */
  actorForUser(userId: string): Promise<Actor | null>
  sessionActor(headers: Headers): Promise<Actor | null>
  /** Verifies an MCP OAuth access token (a JWT) in-process. Any failure gives `null`. */
  bearerActor(token: string): Promise<BearerAuth | null>
  apiKeyActor(key: string): Promise<ApiKeyAuth | null>
  /**
   * Returns the plaintext key; only its hash is stored. A blank or overlong name is a validation issue on `keyName`.
   * Asking for a push key for anyone but an owner is forbidden.
   */
  createApiKey(userId: string, name: string, opts?: ApiKeyOptions): Promise<string>
  oauthClient(clientId: string): Promise<{ name: string; redirectUris: string[] } | null>
  /** Every user, sorted by name. Owners only (`users.manage`), as are the next four. */
  listUsers(actor: Actor): Promise<UserInfo[]>
  /** Validated as `createUser`; an email already in use is a validation issue on `email`. */
  addUser(actor: Actor, input: UserInput & { role: UserRole }): Promise<UserInfo>
  /** invalid_operation `error.lastOwner` when it would leave the site without an owner. */
  setRole(actor: Actor, userId: string, role: UserRole): Promise<void>
  /** Sets a user's password and ends every way they were signed in: sessions, API keys and OAuth (assistant) tokens. */
  setPassword(actor: Actor, userId: string, password: string): Promise<void>
  /** Deletes the account with its sessions and API keys. invalid_operation `error.removeSelf` or `error.lastOwner`. */
  removeUser(actor: Actor, userId: string): Promise<void>
  /**
   * Changes a user's own password. A wrong `current` is a validation issue on `current`. Ends the user's sessions,
   * except the one `keep` (request headers) carries, so the page that asked stays signed in. Also ends the user's
   * assistant (OAuth) tokens, but not their API keys.
   */
  changePassword(userId: string, current: string, next: string, keep?: Headers): Promise<void>
  /** Whether the user has two-step login on (a key set up and confirmed). */
  twoStepOn(userId: string): Promise<boolean>
  /** Ends the user's sessions, except the one `keep` (request headers) carries. API keys and assistant tokens stay. */
  endOtherSessions(userId: string, keep: Headers): Promise<void>
  /**
   * Turns two-step login off: deletes the user's key rows always (a stray or unconfirmed one must not block a later
   * setup), and ends all their sessions only when it was on; when it wasn't, their sessions are left alone. API keys,
   * assistant tokens and the password stay. Returns whether it was on; not_found `error.userNotFound` for an unknown
   * user.
   */
  resetTwoFactor(userId: string): Promise<boolean>
  /** The user's API keys, newest first; never the keys themselves. */
  listApiKeys(userId: string): Promise<ApiKeyInfo[]>
  /** not_found unless `keyId` is one of the user's own keys. */
  deleteApiKey(userId: string, keyId: string): Promise<void>
  /** The assistants the user has allowed, newest first. These are approvals, not live tokens. */
  listAssistants(userId: string): Promise<AssistantInfo[]>
}

/** The shortest time between two re-reads of the signing keys for an unknown `kid`. */
const JWKS_COOLDOWN_MS = 30_000

export const MIN_PASSWORD = 10
/** better-auth's default `maxPasswordLength`. */
const MAX_PASSWORD = 128
/** The api-key plugin's default `maximumNameLength`. */
const MAX_KEY_NAME = 32
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const LABELS = {
  email: 'label.user.email',
  name: 'label.user.name',
  password: 'label.user.password',
  current: 'label.user.currentPassword',
  keyName: 'label.apiKey.name',
} as const satisfies Record<string, MessageId>

function userIssue(at: keyof typeof LABELS, code: IssueCode, messageId: MessageId, params: Record<string, string | number> = {}): ContentIssue {
  return contentIssue([at], [t(LABELS[at])], code, messageId, params)
}

function checkPassword(password: string): ContentIssue[] {
  if (password.length < MIN_PASSWORD) return [userIssue('password', 'too_short', 'issue.tooShort', { min: MIN_PASSWORD })]
  if (password.length > MAX_PASSWORD) return [userIssue('password', 'too_long', 'issue.tooLong', { max: MAX_PASSWORD })]
  return []
}

function checkUser(input: UserInput): ContentIssue[] {
  const issues: ContentIssue[] = []
  if (!EMAIL.test(input.email.trim())) issues.push(userIssue('email', 'invalid', 'issue.email'))
  if (input.name.trim() === '') issues.push(userIssue('name', 'required', 'issue.required'))
  issues.push(...checkPassword(input.password))
  return issues
}

const invalid = (issues: ContentIssue[]) => new InlayError('validation', 'error.validation', {}, { issues })

const isRole = (role: string | null | undefined): role is UserRole => role === 'owner' || role === 'editor'

/** More users or API keys than any site has; better-auth's adapter reads 100 rows unless told otherwise. */
const ALL = 100_000

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value))

const manage = (actor: Actor) => assertCan({ actor, source: 'admin' }, 'users.manage')

const userNotFound = () => new InlayError('not_found', 'error.userNotFound')

export function createAuthService(opts: AuthOptions): AuthService {
  const { db } = opts
  const auth = createAuth(opts)
  const issuer = `${opts.baseUrl}${AUTH_BASE_PATH}`
  const resource = `${opts.baseUrl}${MCP_PATH}`

  // better-auth compares column types on every run and warns that its
  // string[] columns are TEXT, which is how it stores them on SQLite.
  const migrations = () => getMigrations({ ...auth.options, logger: { level: 'error' } })

  async function actorForUser(userId: string): Promise<Actor | null> {
    const row = await db
      .selectFrom('user')
      .select(['id', 'name', 'role', 'banned', 'banExpires'])
      .where('id', '=', userId)
      .executeTakeFirst()
    if (!row || !isRole(row.role)) return null
    if (row.banned && !(row.banExpires !== null && Date.parse(row.banExpires) <= Date.now())) return null
    return { id: row.id, name: row.name, role: row.role }
  }

  async function hasOwner(): Promise<boolean> {
    return (await db.selectFrom('user').select('id').where('role', '=', 'owner').executeTakeFirst()) !== undefined
  }

  async function createUser(input: UserInput & { role: UserRole }): Promise<Actor> {
    const issues = checkUser(input)
    if (issues.length > 0) throw invalid(issues)
    try {
      const { user } = await auth.api.createUser({
        body: { email: input.email.trim(), name: input.name.trim(), password: input.password, role: input.role },
      })
      return { id: user.id, name: user.name, role: input.role }
    } catch (e) {
      const code = e instanceof APIError ? (e.body as { code?: unknown } | undefined)?.code : undefined
      if (typeof code === 'string' && code.startsWith('USER_ALREADY_EXISTS')) throw invalid([userIssue('email', 'invalid', 'issue.emailTaken')])
      if (code === 'INVALID_EMAIL') throw invalid([userIssue('email', 'invalid', 'issue.email')])
      throw e
    }
  }

  // Serialises createOwner within this process, so two concurrent calls make one owner.
  let ownerLock: Promise<unknown> = Promise.resolve()

  /**
   * The lock can't see another process (`inlaycms create-owner` beside a running site), so once `actor` exists as
   * an owner, it checks the database too. Of two owners made at once, the one inserted later (higher `rowid`)
   * gives way: it deletes itself, with its account and sessions, and the call fails as if the other owner had
   * come first. A process that sees only itself was inserted first, so exactly one owner remains.
   */
  async function keepFirstOwner(actor: Actor): Promise<Actor> {
    if (actor.id === null) return actor
    const first = await db
      .selectFrom('user')
      .select('id')
      .where('role', '=', 'owner')
      .orderBy(sql`rowid`)
      .executeTakeFirst()
    if (first === undefined || first.id === actor.id) return actor
    const { internalAdapter } = await auth.$context
    await internalAdapter.deleteUser(actor.id)
    throw new InlayError('invalid_operation', 'error.ownerExists')
  }

  // Serialises role changes and removals within this process, so two at once can't both take away the last owner.
  let usersLock: Promise<unknown> = Promise.resolve()
  function serially<T>(work: () => Promise<T>): Promise<T> {
    const run = usersLock.then(work)
    usersLock = run.catch(() => undefined)
    return run
  }

  /** Throws `error.lastOwner` unless an owner other than `userId` can still use the site. */
  async function assertOtherOwner(userId: string): Promise<void> {
    const other = await db
      .selectFrom('user')
      .select('id')
      .where('role', '=', 'owner')
      .where('id', '!=', userId)
      .where((eb) => eb.or([eb('banned', 'is', null), eb('banned', '=', 0)]))
      .executeTakeFirst()
    if (other === undefined) throw new InlayError('invalid_operation', 'error.lastOwner')
  }

  type BetterAuthUser = {
    id: string
    name: string
    email: string
    role?: string | null
    banned?: boolean | null
    twoFactorEnabled?: boolean | null
    createdAt: Date
  }

  const userInfo = (user: BetterAuthUser): UserInfo => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: isRole(user.role) ? user.role : null,
    banned: user.banned === true,
    createdAt: iso(user.createdAt),
    twoStep: user.twoFactorEnabled === true,
  })

  /**
   * Ends every other way in for a user: the OAuth tokens better-auth stores (refresh tokens would mint new access
   * tokens), and through the cutoff, the access tokens already handed out, which are JWTs checked without the
   * database. API keys end too unless `apiKeys` is false.
   */
  async function endTokens(userId: string, opts: { apiKeys: boolean }): Promise<void> {
    const { adapter } = await auth.$context
    if (opts.apiKeys) await adapter.deleteMany({ model: 'apikey', where: [{ field: 'referenceId', value: userId }] })
    await adapter.deleteMany({ model: 'oauthRefreshToken', where: [{ field: 'userId', value: userId }] })
    await adapter.deleteMany({ model: 'oauthAccessToken', where: [{ field: 'userId', value: userId }] })
    const before = Math.floor(Date.now() / 1000)
    await db
      .insertInto('token_cutoffs')
      .values({ user_id: userId, before })
      .onConflict((oc) => oc.column('user_id').doUpdateSet({ before }))
      .execute()
  }

  /** Ends the user's sessions, except the one `keep` (request headers) carries when it is theirs. */
  async function endSessions(userId: string, keep?: Headers): Promise<void> {
    const { internalAdapter } = await auth.$context
    let kept: string | undefined
    if (keep) {
      try {
        const session = await auth.api.getSession({ headers: keep })
        if (session?.user.id === userId) kept = session.session.token
      } catch (e) {
        if (!(e instanceof APIError)) throw e
      }
    }
    const sessions = await internalAdapter.listSessions(userId)
    const others = sessions.map((s) => s.token).filter((token) => token !== kept)
    if (others.length > 0) await internalAdapter.deleteSessions(others)
  }

  async function findUser(userId: string): Promise<BetterAuthUser> {
    const { internalAdapter } = await auth.$context
    const user = (await internalAdapter.findUserById(userId)) as BetterAuthUser | null
    if (!user) throw userNotFound()
    return user
  }

  type ApiKeyRow = { id: string; name: string | null; start: string | null; referenceId: string; createdAt: Date; lastRequest: Date | null }

  async function findApiKeys(userId: string): Promise<ApiKeyRow[]> {
    const { adapter } = await auth.$context
    return adapter.findMany<ApiKeyRow>({ model: 'apikey', where: [{ field: 'referenceId', value: userId }], limit: ALL })
  }

  let keys: JWTVerifyGetKey | null = null
  /** When the keys were last read, or 0 when that read found none (so the first key ever made is picked up at once). */
  let keysReadAt = 0
  const loadKeys = async (): Promise<JWTVerifyGetKey> => {
    const jwks = await auth.api.getJwks()
    keysReadAt = jwks.keys.length > 0 ? Date.now() : 0
    return (keys = createLocalJWKSet(jwks))
  }
  // Keys come from the database, never over HTTP. An unknown kid re-reads them in case they rotated, but at most
  // once per cooldown, so a stream of tokens with made-up kids can't make every request hit the database.
  const getKey: JWTVerifyGetKey = async (header, token) => {
    const current = keys ?? (await loadKeys())
    try {
      return await current(header, token)
    } catch (e) {
      if (!(e instanceof errors.JWKSNoMatchingKey) || Date.now() - keysReadAt < JWKS_COOLDOWN_MS) throw e
      return (await loadKeys())(header, token)
    }
  }

  return {
    auth,
    issuer,
    resource,

    async migrationsPending() {
      const { toBeCreated, toBeAdded } = await migrations()
      return toBeCreated.length + toBeAdded.length > 0
    },

    async migrate() {
      await (await migrations()).runMigrations()
    },

    hasOwner,

    createOwner(input) {
      const run = ownerLock.then(async () => {
        if (await hasOwner()) throw new InlayError('invalid_operation', 'error.ownerExists')
        return keepFirstOwner(await createUser({ ...input, role: 'owner' }))
      })
      ownerLock = run.catch(() => undefined)
      return run
    },

    createUser,
    actorForUser,

    async sessionActor(headers) {
      let session: Awaited<ReturnType<typeof auth.api.getSession>>
      try {
        session = await auth.api.getSession({ headers })
      } catch (e) {
        if (e instanceof APIError) return null
        throw e
      }
      return session ? actorForUser(session.user.id) : null
    },

    async bearerActor(token) {
      let claims: { sub: string; azp: string; scope: unknown; exp: number; iat: number }
      try {
        const { payload } = await jwtVerify(token, getKey, { issuer, audience: resource, requiredClaims: ['sub', 'exp', 'iat'] })
        const { sub, azp, scope, exp, iat } = payload
        if (typeof sub !== 'string' || typeof azp !== 'string' || typeof exp !== 'number' || typeof iat !== 'number') return null
        claims = { sub, azp, scope, exp, iat }
      } catch (e) {
        if (e instanceof errors.JOSEError) return null
        throw e
      }
      const cutoff = await db.selectFrom('token_cutoffs').select('before').where('user_id', '=', claims.sub).executeTakeFirst()
      if (cutoff && claims.iat <= cutoff.before) return null
      const actor = await actorForUser(claims.sub)
      if (!actor) return null
      const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ').filter((s) => s !== '') : []
      return { actor, clientId: claims.azp, scopes, expiresAt: claims.exp }
    },

    async apiKeyActor(key) {
      if (key === '') return null
      let result: Awaited<ReturnType<typeof auth.api.verifyApiKey>>
      try {
        result = await auth.api.verifyApiKey({ body: { key } })
      } catch (e) {
        if (e instanceof APIError) return null
        throw e
      }
      if (!result.valid || !result.key) return null
      const actor = await actorForUser(result.key.referenceId)
      if (!actor) return null
      const release: unknown = result.key.permissions?.release
      return { actor, permissions: { release: Array.isArray(release) ? release.filter((p): p is string => typeof p === 'string') : [] } }
    },

    async createApiKey(userId, name, opts = {}) {
      const trimmed = name.trim()
      if (trimmed === '') throw invalid([userIssue('keyName', 'required', 'issue.required')])
      if (trimmed.length > MAX_KEY_NAME) throw invalid([userIssue('keyName', 'too_long', 'issue.tooLong', { max: MAX_KEY_NAME })])
      const push = opts.permissions?.release?.includes('push') === true
      if (push && (await actorForUser(userId))?.role !== 'owner') throw new InlayError('forbidden', 'error.forbidden')
      const body = { userId, name: trimmed, ...(push && { permissions: { release: ['push'] } }) }
      return (await auth.api.createApiKey({ body })).key
    },

    async oauthClient(clientId) {
      const row = await db.selectFrom('oauthClient').select(['name', 'redirectUris']).where('clientId', '=', clientId).executeTakeFirst()
      if (!row) return null
      const uris: unknown = JSON.parse(row.redirectUris)
      const redirectUris = Array.isArray(uris) ? uris.filter((u): u is string => typeof u === 'string') : []
      return { name: row.name ?? clientId, redirectUris }
    },

    async listUsers(actor) {
      manage(actor)
      const { internalAdapter } = await auth.$context
      const users = (await internalAdapter.listUsers(ALL)) as BetterAuthUser[]
      return users.map(userInfo).sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email))
    },

    async addUser(actor, input) {
      manage(actor)
      const { id } = await createUser(input)
      return userInfo(await findUser(id!))
    },

    async setRole(actor, userId, role) {
      manage(actor)
      return serially(async () => {
        const user = await findUser(userId)
        if (user.role === role) return
        if (user.role === 'owner') await assertOtherOwner(userId)
        const { internalAdapter } = await auth.$context
        await internalAdapter.updateUser(userId, { role })
      })
    },

    async setPassword(actor, userId, password) {
      manage(actor)
      const issues = checkPassword(password)
      if (issues.length > 0) throw invalid(issues)
      const user = await findUser(userId)
      const ctx = await auth.$context
      const hash = await ctx.password.hash(password)
      // As better-auth's admin `setUserPassword`, which needs an admin session to call.
      if (await ctx.internalAdapter.findCredentialAccount(userId)) await ctx.internalAdapter.updatePassword(userId, hash)
      else await ctx.internalAdapter.createAccount({ userId, providerId: 'credential', accountId: user.id, password: hash })
      await ctx.internalAdapter.deleteUserSessions(userId)
      // A reset is often for a password someone else may know, so every other way in ends too, API keys included.
      await endTokens(userId, { apiKeys: true })
    },

    async removeUser(actor, userId) {
      manage(actor)
      if (userId === actor.id) throw new InlayError('invalid_operation', 'error.removeSelf')
      return serially(async () => {
        const user = await findUser(userId)
        if (user.role === 'owner') await assertOtherOwner(userId)
        const { adapter, internalAdapter } = await auth.$context
        // API keys point at their user without a foreign key, so they go first, by hand.
        await adapter.deleteMany({ model: 'apikey', where: [{ field: 'referenceId', value: userId }] })
        await adapter.deleteMany({ model: 'twoFactor', where: [{ field: 'userId', value: userId }] })
        await internalAdapter.deleteUserSessions(userId)
        // Also deletes the user's accounts; OAuth tokens and consents cascade. Revisions keep the author's name.
        await internalAdapter.deleteUser(userId)
        await db.deleteFrom('token_cutoffs').where('user_id', '=', userId).execute()
      })
    },

    async changePassword(userId, current, next, keep) {
      const ctx = await auth.$context
      const account = await ctx.internalAdapter.findCredentialAccount(userId)
      const issues: ContentIssue[] = []
      if (!account?.password || !(await ctx.password.verify({ hash: account.password, password: current }))) {
        issues.push(userIssue('current', 'invalid', 'issue.wrongPassword'))
      }
      issues.push(...checkPassword(next))
      if (issues.length > 0) throw invalid(issues)
      await ctx.internalAdapter.updatePassword(userId, await ctx.password.hash(next))
      await endSessions(userId, keep)
      await endTokens(userId, { apiKeys: false })
    },

    async twoStepOn(userId) {
      const { internalAdapter } = await auth.$context
      const user = (await internalAdapter.findUserById(userId)) as BetterAuthUser | null
      return user?.twoFactorEnabled === true
    },

    endOtherSessions: endSessions,

    async resetTwoFactor(userId) {
      return serially(async () => {
        const user = await findUser(userId)
        const { adapter, internalAdapter } = await auth.$context
        await adapter.deleteMany({ model: 'twoFactor', where: [{ field: 'userId', value: userId }] })
        if (user.twoFactorEnabled !== true) return false
        await internalAdapter.updateUser(userId, { twoFactorEnabled: false })
        await endSessions(userId)
        return true
      })
    },

    async listApiKeys(userId) {
      const rows = await findApiKeys(userId)
      return rows
        .map((row) => ({
          id: row.id,
          name: row.name ?? '',
          start: row.start,
          createdAt: iso(row.createdAt),
          lastUsedAt: row.lastRequest ? iso(row.lastRequest) : null,
        }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },

    async deleteApiKey(userId, keyId) {
      const { adapter } = await auth.$context
      const key = await adapter.findOne<ApiKeyRow>({ model: 'apikey', where: [{ field: 'id', value: keyId }] })
      if (!key || key.referenceId !== userId) throw new InlayError('not_found', 'error.apiKeyNotFound')
      await adapter.delete({ model: 'apikey', where: [{ field: 'id', value: keyId }] })
    },

    async listAssistants(userId) {
      const { adapter } = await auth.$context
      const consents = await adapter.findMany<{ clientId: string; createdAt: Date }>({
        model: 'oauthConsent',
        where: [{ field: 'userId', value: userId }],
        limit: ALL,
      })
      if (consents.length === 0) return []
      const clients = await adapter.findMany<{ clientId: string; name: string | null; redirectUris: string[] | null }>({
        model: 'oauthClient',
        where: [{ field: 'clientId', operator: 'in', value: consents.map((c) => c.clientId) }],
        limit: ALL,
      })
      const byId = new Map(clients.map((c) => [c.clientId, c]))
      return consents
        .map((consent) => {
          const client = byId.get(consent.clientId)
          return {
            clientId: consent.clientId,
            name: client?.name ?? consent.clientId,
            redirectUris: client?.redirectUris ?? [],
            connectedAt: iso(consent.createdAt),
          }
        })
        .sort((a, b) => b.connectedAt.localeCompare(a.connectedAt))
    },
  }
}
