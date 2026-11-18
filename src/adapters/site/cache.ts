import { createHash } from 'node:crypto'

export type CachedResponse = {
  status: number
  body: string
  type: string
  etag: string
  /** The page's own content-security-policy, with the hashes of its inline scripts. */
  csp?: string
}

/**
 * A response with a strong ETag over its status, body and `csp`, so unchanged pages revalidate with a 304 and a page
 * whose policy changed does not.
 */
export function response(status: number, body: string, type: string, csp?: string): CachedResponse {
  const hash = createHash('sha256').update(`${status}\n`)
  if (csp !== undefined) hash.update(`${csp}\n`)
  const etag = `"${hash.update(body).digest('hex').slice(0, 32)}"`
  return { status, body, type, etag, ...(csp !== undefined && { csp }) }
}

/** True if `header` (an `If-None-Match` value) names `etag`, comparing weakly. */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false
  return header.split(',').some((part) => {
    const tag = part.trim()
    return tag === etag || tag === `W/${etag}`
  })
}

export interface CdnOptions {
  /** Seconds a shared cache (CDN or proxy) may serve a page before revalidating. Defaults to 15. */
  maxAge?: number
  /** Seconds a shared cache may keep serving a page when the origin is down. Defaults to a day; 0 turns it off. */
  staleIfError?: number
}

/** The `Cache-Control` for published responses: browsers always revalidate, shared caches hold for `maxAge`. */
export function cacheControl(opts: CdnOptions = {}): string {
  const maxAge = opts.maxAge ?? 15
  const staleIfError = opts.staleIfError ?? 86400
  const parts = ['public', 'max-age=0', `s-maxage=${maxAge}`]
  if (staleIfError > 0) parts.push(`stale-if-error=${staleIfError}`)
  return parts.join(', ')
}

/** An LRU of rendered responses. `clear` bumps `generation`, so a render that began earlier can't be stored. */
export class PageCache {
  readonly #entries = new Map<string, CachedResponse>()
  #generation = 0

  readonly #changedElsewhere: () => boolean

  /** `changedElsewhere`: asked on every lookup; true empties the cache first (a write the site's own core didn't make). */
  constructor(
    readonly maxEntries: number,
    changedElsewhere: () => boolean = () => false,
  ) {
    this.#changedElsewhere = changedElsewhere
  }

  /** Bumped by every `clear`, including the one a change made elsewhere causes, which reading it notices. */
  get generation(): number {
    if (this.#changedElsewhere()) this.clear()
    return this.#generation
  }

  get size(): number {
    return this.#entries.size
  }

  get(key: string): CachedResponse | undefined {
    if (this.#changedElsewhere()) this.clear()
    const value = this.#entries.get(key)
    if (value === undefined) return undefined
    this.#entries.delete(key)
    this.#entries.set(key, value)
    return value
  }

  set(key: string, value: CachedResponse, generation: number): void {
    if (generation !== this.#generation || this.maxEntries < 1) return
    this.#entries.delete(key)
    this.#entries.set(key, value)
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next()
      if (oldest.done) break
      this.#entries.delete(oldest.value)
    }
  }

  clear(): void {
    this.#entries.clear()
    this.#generation += 1
  }
}
