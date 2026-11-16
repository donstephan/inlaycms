import { apiKey } from '@better-auth/api-key'
import { mcp } from '@better-auth/mcp'
import { betterAuth } from 'better-auth'
import { createAccessControl } from 'better-auth/plugins/access'
import { admin } from 'better-auth/plugins/admin'
import { adminAc, defaultStatements } from 'better-auth/plugins/admin/access'
import { jwt } from 'better-auth/plugins/jwt'
import { hashPassword, verifyPassword } from 'better-auth/crypto'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'

export const AUTH_BASE_PATH = '/api/auth'
export const MCP_PATH = '/mcp'

export interface AuthOptions {
  db: Kysely<Database>
  secret: string
  baseUrl: string
  /** Off only in tests. */
  rateLimit?: boolean
}

export interface PasswordHasher {
  hash: (password: string) => Promise<string>
  verify: (data: { hash: string; password: string }) => Promise<boolean>
}

let testPasswordHasher: PasswordHasher | undefined

/**
 * Tests only: replaces better-auth's scrypt (~60 ms a call) for every auth
 * created afterwards. Deliberately not a plugin option, so a site can't
 * weaken its password storage by accident.
 */
export function setTestPasswordHasher(hasher: PasswordHasher | undefined): void {
  testPasswordHasher = hasher
}

/** The hasher for passwords Inlay stores itself: the test hasher when set, otherwise better-auth's scrypt. */
export function passwordHasher(): PasswordHasher {
  return testPasswordHasher ?? { hash: hashPassword, verify: verifyPassword }
}

const ac = createAccessControl(defaultStatements)
const owner = ac.newRole({ ...adminAc.statements })
const editor = ac.newRole({ user: [], session: [] })

/**
 * better-auth on the content database (plan decisions 3, 4, 6, 7, 8). It
 * shares the core's single SQLite connection, so never call `auth.api.*`
 * inside a Kysely transaction: it would wait for the connection forever.
 */
export function createAuth(opts: AuthOptions) {
  return betterAuth({
    secret: opts.secret,
    baseURL: opts.baseUrl,
    basePath: AUTH_BASE_PATH,
    trustedOrigins: [opts.baseUrl],
    database: { db: opts.db, type: 'sqlite' },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 10,
      ...(testPasswordHasher && { password: testPasswordHasher }),
    },
    rateLimit: { enabled: opts.rateLimit ?? true, storage: 'memory' },
    advanced: { ipAddress: { ipAddressHeaders: ['x-inlay-client-ip'] }, database: { validateSchema: false } },
    plugins: [
      admin({ ac, roles: { owner, editor }, adminRoles: ['owner'], defaultRole: 'editor' }),
      jwt(),
      mcp({
        resource: opts.baseUrl + MCP_PATH,
        loginPage: '/admin/login',
        consentPage: '/admin/consent',
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultApplicationType: 'infer',
      }),
      apiKey({ rateLimit: { enabled: false } }),
    ],
  })
}

export type InlayAuth = ReturnType<typeof createAuth>
