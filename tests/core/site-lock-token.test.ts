import { describe, expect, it } from 'vitest'
import { createPreviewToken } from '../../src/core/preview.js'
import { UNLOCK_TTL_MS, createUnlockToken, verifyUnlockToken } from '../../src/core/site-lock/token.js'

const secret = 'test-secret-with-enough-length-0123456789'
const hash = 'scrypt$salt$hashed-password-value'
const now = new Date('2026-11-02T12:00:00Z')

describe('site unlock token', () => {
  it('verifies its own token until it expires', () => {
    const token = createUnlockToken(secret, hash, now)
    expect(verifyUnlockToken(secret, hash, token, now)).toEqual({ expiresAt: new Date(now.getTime() + UNLOCK_TTL_MS) })
    expect(verifyUnlockToken(secret, hash, token, new Date(now.getTime() + UNLOCK_TTL_MS - 1))).not.toBeNull()
    expect(verifyUnlockToken(secret, hash, token, new Date(now.getTime() + UNLOCK_TTL_MS))).toBeNull()
  })

  it('stops working when the password hash changes', () => {
    const token = createUnlockToken(secret, 'a', now)
    expect(verifyUnlockToken(secret, 'b', token, now)).toBeNull()
  })

  it('refuses another secret, a tampered token and a preview token', () => {
    const token = createUnlockToken(secret, hash, now)
    expect(verifyUnlockToken('another-secret-with-enough-length-9876543210', hash, token, now)).toBeNull()
    const last = token.at(-1) === 'A' ? 'B' : 'A'
    expect(verifyUnlockToken(secret, hash, token.slice(0, -1) + last, now)).toBeNull()
    expect(verifyUnlockToken(secret, hash, createPreviewToken(secret, now), now)).toBeNull()
  })

  it('contains nothing secret', () => {
    const token = createUnlockToken(secret, hash, now)
    expect(token).not.toContain(hash)
    expect(token).not.toContain(secret)
  })
})
