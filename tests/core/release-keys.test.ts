import {
  fingerprint,
  generateKeyPair,
  keyStillTrusted,
  parsePublicKey,
  parsePublicKeys,
  publicKeyOf,
  sign,
  verify,
} from '../../src/core/release/keys.js'

const data = new TextEncoder().encode('manifest')

describe('release keys', () => {
  it('signs and verifies', () => {
    const a = generateKeyPair()
    const b = generateKeyPair()
    const sig = sign(a.privateKey, data)
    expect(a.publicKey).toMatch(/^ed25519:[A-Za-z0-9+/]+=*$/)
    expect(publicKeyOf(a.privateKey)).toBe(a.publicKey)
    expect(verify(a.publicKey, data, sig)).toBe(true)
    expect(verify(a.publicKey, new TextEncoder().encode('other'), sig)).toBe(false)
    expect(verify(b.publicKey, data, sig)).toBe(false)
  })

  it('verify never throws', () => {
    const a = generateKeyPair()
    expect(verify(a.publicKey, data, 'not a signature')).toBe(false)
    expect(verify('garbage', data, sign(a.privateKey, data))).toBe(false)
    expect(verify('ed25519:AAAA', data, '')).toBe(false)
  })

  it('keyStillTrusted finds a fingerprint among the trusted keys', () => {
    const a = generateKeyPair()
    const b = generateKeyPair()
    expect(keyStillTrusted(fingerprint(a.publicKey), [b.publicKey, a.publicKey])).toBe(true)
    expect(keyStillTrusted(fingerprint(a.publicKey), [b.publicKey])).toBe(false)
    // With no keys there is nothing to compare with: uploads are refused then, and nothing is called untrusted.
    expect(keyStillTrusted(fingerprint(a.publicKey), [])).toBe(true)
  })

  it('fingerprint is stable and 16 hex', () => {
    const a = generateKeyPair()
    expect(fingerprint(a.publicKey)).toMatch(/^[0-9a-f]{16}$/)
    expect(fingerprint(a.publicKey)).toBe(fingerprint(a.publicKey))
    expect(fingerprint(a.publicKey)).not.toBe(fingerprint(generateKeyPair().publicKey))
  })

  it('parses one or several trusted keys', () => {
    const a = generateKeyPair().publicKey
    const b = generateKeyPair().publicKey
    expect(parsePublicKey(`  ${a}\n`)).toBe(a)
    expect(parsePublicKeys(`# agency\n${a}, ${b}\n\n`)).toEqual([a, b])
    expect(parsePublicKeys(`${a}\n${b}`)).toEqual([a, b])
  })

  it('rejects a public key without the prefix', () => {
    expect(() => parsePublicKey('AAAA')).toThrow(expect.objectContaining({ code: 'config' }))
  })
})
