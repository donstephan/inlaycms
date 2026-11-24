import { createHmac, timingSafeEqual } from 'node:crypto'
import { InlayError } from './errors.js'

export const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000

const V2 = /^v2\.([0-9a-z]{1,11})\.([A-Za-z0-9_][A-Za-z0-9_-]{0,63})\.([A-Za-z0-9_-]{43})$/
const V3 = /^v3\.([0-9a-z]{1,11})\.([A-Za-z0-9_-]{1,2732})\.([A-Za-z0-9_-]{43})$/
const RELEASE_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/
/** The longest page path a token carries, in bytes. */
const PATH_MAX = 2048

const sign = (secret: string, payload: string): string =>
  createHmac('sha256', secret).update(payload).digest('base64url')

/**
 * A preview token valid for `PREVIEW_TTL_MS` from `now`. With `release`, it previews that whole staged release:
 * `v2.<expiry ms base36>.<release id>.<HMAC-SHA256 base64url>`. Otherwise it shows the drafts of the live site on
 * one page, `path` (a decoded site path, `/` by default), and nowhere else:
 * `v3.<expiry>.<path, base64url>.<HMAC>`. So a link that gets around shows the page it was made for, not the site.
 */
export function createPreviewToken(secret: string, now: Date, opts: { release?: string; path?: string } = {}): string {
  const { release } = opts
  const expiry = (now.getTime() + PREVIEW_TTL_MS).toString(36)
  if (release !== undefined) {
    if (!RELEASE_ID.test(release)) throw new InlayError('not_found', 'error.releaseUnknown', { id: release })
    const payload = `v2.${expiry}.${release}`
    return `${payload}.${sign(secret, payload)}`
  }
  const path = Buffer.from(opts.path ?? '/')
  if (path.length === 0 || path.length > PATH_MAX) throw new InlayError('invalid_operation', 'error.previewPath')
  const payload = `v3.${expiry}.${path.toString('base64url')}`
  return `${payload}.${sign(secret, payload)}`
}

/**
 * The token's expiry and what it previews: `release`, a staged release, or `path`, one page of the live site's drafts
 * (the other is null). `null` if it's malformed, wasn't signed with `secret`, or has expired. A token of an older
 * form, which showed every draft on the site, is malformed now.
 */
export function verifyPreviewToken(
  secret: string,
  token: string,
  now: Date,
): { expiresAt: Date; release: string | null; path: string | null } | null {
  const v3 = V3.exec(token)
  const v2 = v3 ? null : V2.exec(token)
  const parts = v3
    ? { payload: `v3.${v3[1]}.${v3[2]}`, expiry: v3[1]!, release: null, path: Buffer.from(v3[2]!, 'base64url').toString(), signature: v3[3]! }
    : v2
      ? { payload: `v2.${v2[1]}.${v2[2]}`, expiry: v2[1]!, release: v2[2]!, path: null, signature: v2[3]! }
      : null
  if (parts === null) return null
  const { payload, expiry, release, path, signature } = parts
  const given = Buffer.from(signature)
  const expected = Buffer.from(sign(secret, payload))
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  const expiresAt = parseInt(expiry, 36)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now.getTime()) return null
  return { expiresAt: new Date(expiresAt), release, path }
}
