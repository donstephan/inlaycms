import { randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import { createAuthService, type AuthService } from '../../src/core/auth/service.js'
import type { Core } from '../../src/core/core.js'
import type { Database } from '../../src/core/db/schema.js'
import type { Actor } from '../../src/core/types.js'
import { totpCode } from './admin.js'
import { OWNER_PASSWORD } from './app.js'
import { makeCore } from './core.js'

export const TEST_BASE_URL = 'http://localhost:3000'

/**
 * `makeCore` plus migrated better-auth tables, an owner and an editor, and an
 * API key for each. better-auth uses the real clock, unlike the core.
 */
export async function makeAuth(): Promise<{
  core: Core
  db: Kysely<Database>
  auth: AuthService
  owner: Actor
  editor: Actor
  ownerKey: string
  editorKey: string
}> {
  const { core, db } = await makeCore()
  const auth = createAuthService({ db, secret: randomBytes(32).toString('base64url'), baseUrl: TEST_BASE_URL, rateLimit: false })
  await auth.migrate()
  const owner = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia Owner', password: 'owner-password', role: 'owner' })
  const editor = await auth.createUser({ email: 'eddie@example.com', name: 'Eddie Editor', password: 'editor-password', role: 'editor' })
  const ownerKey = await auth.createApiKey(owner.id!, 'owner key')
  const editorKey = await auth.createApiKey(editor.id!, 'editor key')
  return { core, db, auth, owner, editor, ownerKey, editorKey }
}

/** `cookie` (a `Cookie` header) with the cookies `res` sets applied: new values replace old ones, expired ones go. */
function applyCookies(cookie: string, res: Response): string {
  const jar = new Map<string, string>()
  for (const pair of cookie.split(';')) {
    const eq = pair.indexOf('=')
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
  for (const line of res.headers.getSetCookie()) {
    const [pair = '', ...attrs] = line.split(';')
    const eq = pair.indexOf('=')
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '') jar.delete(name)
    else jar.set(name, value)
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
}

/**
 * Turns two-step login on for the session in `cookie`, through better-auth's own endpoints (enable, then confirm
 * with the current code). Returns the base32 key and the cookie header of the session that replaces it.
 */
export async function turnOnTwoStep(
  service: AuthService,
  cookie: string,
  password: string = OWNER_PASSWORD,
): Promise<{ key: string; cookie: string }> {
  const origin = new URL(service.issuer).origin
  const post = (path: string, body: unknown, cookies: string) =>
    service.auth.handler(
      new Request(`${service.issuer}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', origin, cookie: cookies },
        body: JSON.stringify(body),
      }),
    )
  const enable = await post('/two-factor/enable', { password }, cookie)
  if (!enable.ok) throw new Error(`Enabling two-step login failed with ${enable.status}: ${await enable.text()}`)
  const { totpURI } = (await enable.json()) as { totpURI: string }
  const key = new URL(totpURI).searchParams.get('secret')
  if (key === null) throw new Error(`No key in ${totpURI}`)
  const enabled = applyCookies(cookie, enable)
  const verify = await post('/two-factor/verify-totp', { code: totpCode(key) }, enabled)
  if (!verify.ok) throw new Error(`Confirming two-step login failed with ${verify.status}: ${await verify.text()}`)
  return { key, cookie: applyCookies(enabled, verify) }
}
