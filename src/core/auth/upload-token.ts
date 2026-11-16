import { createHmac, timingSafeEqual } from 'node:crypto'

export const UPLOAD_TTL_MS = 3_600_000

const TOKEN = /^u1\.([A-Za-z0-9_-]{1,512})\.([0-9a-z]{1,11})\.([A-Za-z0-9_-]{43})$/

const sign = (secret: string, payload: string): string =>
  createHmac('sha256', secret).update(payload).digest('base64url')

/** An upload link token for `userId`, valid for `UPLOAD_TTL_MS` from `now`: `u1.<userId base64url>.<expiry ms base36>.<HMAC-SHA256 base64url>`. */
export function createUploadToken(secret: string, userId: string, now: Date): string {
  const payload = `u1.${Buffer.from(userId).toString('base64url')}.${(now.getTime() + UPLOAD_TTL_MS).toString(36)}`
  return `${payload}.${sign(secret, payload)}`
}

/** The token's user and expiry, or `null` if it's malformed, wasn't signed with `secret`, or has expired. */
export function verifyUploadToken(secret: string, token: string, now: Date): { userId: string; expiresAt: Date } | null {
  const match = TOKEN.exec(token)
  if (!match) return null
  const [, user = '', expiry = '', signature = ''] = match
  const given = Buffer.from(signature)
  const expected = Buffer.from(sign(secret, `u1.${user}.${expiry}`))
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  const expiresAt = parseInt(expiry, 36)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now.getTime()) return null
  const userId = Buffer.from(user, 'base64url').toString()
  if (userId === '') return null
  return { userId, expiresAt: new Date(expiresAt) }
}
