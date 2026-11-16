import { createHmac } from 'node:crypto'
import { createRequestStateCodec, type RequestStateCodec } from '@modelcontextprotocol/server'

/** How long a minted request state stays valid. */
const TTL_SECONDS = 600

/** The most nonces a store remembers at once; past that it refuses new ones until old ones expire. */
const MAX_NONCES = 10_000

/** The codec that signs and checks the request state of multi-round-trip tool calls (publish confirmation). */
export function requestStateCodec<T = unknown>(secret: string): RequestStateCodec<T> {
  const key = createHmac('sha256', secret).update('inlay-mcp-request-state').digest()
  return createRequestStateCodec<T>({ key, ttlSeconds: TTL_SECONDS })
}

/** Remembers which request-state nonces were already used, so a signed state is acted on once. */
export interface NonceStore {
  /** Marks `nonce` used. `false` when it already was (or the store is full), and the state must not be acted on. */
  consume(nonce: string): boolean
}

/**
 * A single-use store held in memory. It covers one process only, which matches the one-install-per-site model:
 * every confirmation for a site goes through the same `/mcp` handler. A nonce is forgotten once the state
 * carrying it has expired, since the codec refuses that state anyway. Request states expire on the real
 * clock, so this does too.
 */
export function createNonceStore(): NonceStore {
  /** Nonce → when it can be forgotten, in ms since the epoch. Insertion order is expiry order. */
  const used = new Map<string, number>()
  const purge = (now: number) => {
    for (const [nonce, expiresAt] of used) {
      if (expiresAt > now) break
      used.delete(nonce)
    }
  }
  return {
    consume(nonce) {
      const now = Date.now()
      purge(now)
      if (used.has(nonce) || used.size >= MAX_NONCES) return false
      used.set(nonce, now + TTL_SECONDS * 1000)
      return true
    },
  }
}
