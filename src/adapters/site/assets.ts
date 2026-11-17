import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export const ASSET_VERSION_LENGTH = 12

const ENCODED = /%2e|%2f|%5c/i

/** The first 12 hex characters of the sha256 of `bytes`. */
export function assetVersion(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, ASSET_VERSION_LENGTH)
}

/** The absolute path under `dir` that the raw wildcard names, or null when it is empty, tricky or outside `dir`. */
export function locate(dir: string, rawPath: string): string | null {
  if (rawPath === '' || ENCODED.test(rawPath) || rawPath.includes('\\')) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null
  const segments = decoded.split('/')
  if (segments.some((s) => s === '' || s.startsWith('.'))) return null
  const root = resolve(dir)
  const file = resolve(root, ...segments)
  return file.startsWith(root + sep) ? file : null
}

export interface PublicAssets {
  /** The `/public/...` URL for `path`, with `?v=<hash>` when the file is there and servable. Never throws. */
  url(path: string): string
}

/** Versions the files under `dir`, re-hashing a file only when its mtime or size changed. */
export function publicAssets(dir: string | null): PublicAssets {
  const cache = new Map<string, { version: string; mtimeMs: number; size: number }>()

  function version(encoded: string): string | null {
    if (dir === null) return null
    try {
      const file = locate(dir, encoded)
      if (file === null) return null
      const stat = lstatSync(file)
      if (!stat.isFile()) return null
      if (!realpathSync(file).startsWith(realpathSync(dir) + sep)) return null
      const known = cache.get(file)
      if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return known.version
      const bytes = readFileSync(file)
      const fresh = assetVersion(bytes)
      cache.set(file, { version: fresh, mtimeMs: stat.mtimeMs, size: bytes.length })
      return fresh
    } catch {
      return null
    }
  }

  return {
    url(path) {
      const bare = path.startsWith('/public/') ? path.slice('/public/'.length) : path.startsWith('/') ? path.slice(1) : path
      let encoded: string
      try {
        encoded = bare.split('/').map(encodeURIComponent).join('/')
      } catch {
        return '/public/'
      }
      const v = version(encoded)
      return v === null ? `/public/${encoded}` : `/public/${encoded}?v=${v}`
    },
  }
}
