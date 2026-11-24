import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto'
import { InlayError } from '../errors.js'

export const PUBLIC_KEY_PREFIX = 'ed25519:'

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function encodePublic(key: KeyObject): string {
  const der = key.export({ type: 'spki', format: 'der' })
  return PUBLIC_KEY_PREFIX + der.subarray(der.length - 32).toString('base64')
}

function rawBytes(publicKey: string): Buffer {
  if (!publicKey.startsWith(PUBLIC_KEY_PREFIX)) throw new Error('missing prefix')
  const raw = Buffer.from(publicKey.slice(PUBLIC_KEY_PREFIX.length), 'base64')
  if (raw.length !== 32) throw new Error('wrong length')
  return raw
}

function importPublic(publicKey: string): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, rawBytes(publicKey)]), format: 'der', type: 'spki' })
}

export function generateKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: encodePublic(publicKey),
  }
}

export function publicKeyOf(privateKeyPem: string): string {
  return encodePublic(createPublicKey(createPrivateKey(privateKeyPem)))
}

export function fingerprint(publicKey: string): string {
  return createHash('sha256').update(rawBytes(publicKey)).digest('hex').slice(0, 16)
}

/**
 * Whether the key with fingerprint `signedBy` is among `trustedKeys` now. A release is checked when it arrives, so one
 * signed with a key taken off the list since is still stored; with no keys to compare, nothing is said to be untrusted.
 */
export function keyStillTrusted(signedBy: string, trustedKeys: readonly string[]): boolean {
  return trustedKeys.length === 0 || trustedKeys.some((key) => fingerprint(key) === signedBy)
}

export function sign(privateKeyPem: string, data: Uint8Array): string {
  return cryptoSign(null, data, createPrivateKey(privateKeyPem)).toString('base64')
}

export function verify(publicKey: string, data: Uint8Array, signature: string): boolean {
  try {
    return cryptoVerify(null, data, importPublic(publicKey), Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

export function parsePublicKey(text: string): string {
  const key = text.trim()
  try {
    rawBytes(key)
  } catch {
    throw new InlayError('config', 'config.publicKey', { text: key })
  }
  return key
}

export function parsePublicKeys(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter((part) => part !== '' && !part.startsWith('#'))
    .map(parsePublicKey)
}
