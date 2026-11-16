import { createHash } from 'node:crypto'

export type CachedResponse = { status: number; body: string; type: string; etag: string }

/** A response with a strong ETag over its status and body, so unchanged pages revalidate with a 304. */
export function response(status: number, body: string, type: string): CachedResponse {
  const hash = createHash('sha256').update(`${status}\n`).update(body).digest('hex').slice(0, 32)
  return { status, body, type, etag: `"${hash}"` }
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

  constructor(readonly maxEntries: number) {}

  get generation(): number {
    return this.#generation
  }

  get size(): number {
    return this.#entries.size
  }

  get(key: string): CachedResponse | undefined {
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
