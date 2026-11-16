import { createHmac, timingSafeEqual } from 'node:crypto'

export const UNLOCK_TTL_MS = 30 * 24 * 60 * 60 * 1000

const TOKEN = /^v1\.([0-9a-z]{1,11})\.([A-Za-z0-9_-]{43})$/

const sign = (secret: string, passwordHash: string, payload: string): string =>
  createHmac('sha256', secret).update(`inlay-site-unlock\n${payload}\n${passwordHash}`).digest('base64url')

/** An unlock token valid for `UNLOCK_TTL_MS` from `now`: `v1.<expiry ms base36>.<HMAC-SHA256 base64url>`. It stops verifying when the password hash changes. */
export function createUnlockToken(secret: string, passwordHash: string, now: Date): string {
  const payload = `v1.${(now.getTime() + UNLOCK_TTL_MS).toString(36)}`
  return `${payload}.${sign(secret, passwordHash, payload)}`
}

/** The token's expiry, or `null` if it's malformed, wasn't signed with `secret` and `passwordHash`, or has expired. */
export function verifyUnlockToken(secret: string, passwordHash: string, token: string, now: Date): { expiresAt: Date } | null {
  const match = TOKEN.exec(token)
  if (!match) return null
  const [, expiry = '', signature = ''] = match
  const given = Buffer.from(signature)
  const expected = Buffer.from(sign(secret, passwordHash, `v1.${expiry}`))
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  const expiresAt = parseInt(expiry, 36)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now.getTime()) return null
  return { expiresAt: new Date(expiresAt) }
}
