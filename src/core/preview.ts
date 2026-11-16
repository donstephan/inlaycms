import { createHmac, timingSafeEqual } from 'node:crypto'
import { InlayError } from './errors.js'

export const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000

const V1 = /^v1\.([0-9a-z]{1,11})\.([A-Za-z0-9_-]{43})$/
const V2 = /^v2\.([0-9a-z]{1,11})\.(-|[A-Za-z0-9_][A-Za-z0-9_-]{0,63})\.([A-Za-z0-9_-]{43})$/
const RELEASE_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/

const sign = (secret: string, payload: string): string =>
  createHmac('sha256', secret).update(payload).digest('base64url')

/**
 * A preview token valid for `PREVIEW_TTL_MS` from `now`: `v2.<expiry ms base36>.<release id or ->.<HMAC-SHA256
 * base64url>`. With `release`, it previews that staged release; without, the live site's drafts.
 */
export function createPreviewToken(secret: string, now: Date, opts: { release?: string } = {}): string {
  const { release } = opts
  if (release !== undefined && !RELEASE_ID.test(release)) throw new InlayError('not_found', 'error.releaseUnknown', { id: release })
  const payload = `v2.${(now.getTime() + PREVIEW_TTL_MS).toString(36)}.${release ?? '-'}`
  return `${payload}.${sign(secret, payload)}`
}

/**
 * The token's expiry and the release it previews (null for the live site's drafts, and for a `v1` token), or `null`
 * if it's malformed, wasn't signed with `secret`, or has expired.
 */
export function verifyPreviewToken(
  secret: string,
  token: string,
  now: Date,
): { expiresAt: Date; release: string | null } | null {
  const v2 = V2.exec(token)
  const v1 = v2 ? null : V1.exec(token)
  const parts = v2
    ? { payload: `v2.${v2[1]}.${v2[2]}`, expiry: v2[1]!, release: v2[2] === '-' ? null : v2[2]!, signature: v2[3]! }
    : v1
      ? { payload: `v1.${v1[1]}`, expiry: v1[1]!, release: null, signature: v1[2]! }
      : null
  if (parts === null) return null
  const { payload, expiry, release, signature } = parts
  const given = Buffer.from(signature)
  const expected = Buffer.from(sign(secret, payload))
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  const expiresAt = parseInt(expiry, 36)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now.getTime()) return null
  return { expiresAt: new Date(expiresAt), release }
}
