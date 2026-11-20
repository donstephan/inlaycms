import { SLUG } from '../content/schema.js'
import type { SingletonDef } from '../registry/define.js'
import type { Registry } from '../registry/registry.js'

export const RESERVED_PATHS: readonly string[] = [
  '/admin',
  '/mcp',
  '/media',
  '/public',
  '/_inlay',
  '/api/auth',
  '/.well-known',
  '/sitemap.xml',
  '/robots.txt',
]

export function isReserved(path: string): boolean {
  return RESERVED_PATHS.some((r) => path === r || path.startsWith(`${r}/`))
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** The decoded, slash-trimmed form of a site path, or `null` if it isn't a clean site-relative path. */
export function normalizePath(raw: string): string | null {
  if (!raw.startsWith('/') || raw.includes('//') || raw.includes('\\')) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (decoded.includes('//') || decoded.includes('\\') || CONTROL.test(decoded)) return null
  if (decoded.split('/').some((s) => s === '.' || s === '..')) return null
  return decoded.length > 1 && decoded.endsWith('/') ? decoded.slice(0, -1) : decoded
}

/**
 * The lowercase form of a decoded, slash-trimmed path, for the fallback tried just before a 404.
 * `null` when the path has no uppercase letter, lowercases to a reserved path, or ends in a segment
 * that looks like a file (contains a `.`).
 */
export function lowercaseFallback(path: string): string | null {
  const lower = path.toLowerCase()
  if (lower === path || isReserved(lower)) return null
  if ((lower.split('/').at(-1) ?? '').includes('.')) return null
  return lower
}

export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

export function splitLocale(registry: Registry, path: string): { locale: string; rest: string } {
  const [, first = '', ...tail] = path.split('/')
  if (first !== registry.defaultLocale && registry.locales.includes(first)) {
    return { locale: first, rest: tail.length === 0 ? '/' : `/${tail.join('/')}` }
  }
  return { locale: registry.defaultLocale, rest: path }
}

export function withLocale(registry: Registry, locale: string, path: string): string {
  if (locale === registry.defaultLocale) return path
  return path === '/' ? `/${locale}` : `/${locale}${path}`
}

export function singletonPath(def: SingletonDef, locale: string, defaultLocale: string): string | null {
  const p = def.path
  if (p === null || typeof p === 'string') return p
  return p[locale] ?? p[defaultLocale] ?? null
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function routeRegExp(route: string): RegExp {
  const [before = '', after = ''] = route.split(':slug')
  const slug = SLUG.source.slice(1, -1)
  return new RegExp(`^${escapeRe(before)}(${slug})${escapeRe(after)}$`)
}

export function routePath(route: string, slug: string): string {
  return route.replace(':slug', slug)
}

export type TrailingSlash = 'always' | 'never'

function slashable(path: string): boolean {
  if (path === '/' || path.endsWith('/') || isReserved(path)) return false
  return !(path.split('/').at(-1) ?? '').includes('.')
}

/** A decoded, normalized path (optionally with a `?query`) in the form the site presents. */
export function presentPath(path: string, mode: TrailingSlash): string {
  if (mode !== 'always') return path
  const q = path.indexOf('?')
  const bare = q === -1 ? path : path.slice(0, q)
  if (!slashable(bare)) return path
  return `${bare}/${q === -1 ? '' : path.slice(q)}`
}

/** The same for an encoded site-relative href; other hrefs come back unchanged. */
export function presentHref(href: string, mode: TrailingSlash): string {
  if (mode !== 'always' || !href.startsWith('/') || href.startsWith('//')) return href
  const q = href.indexOf('?')
  const bare = q === -1 ? href : href.slice(0, q)
  let decoded: string
  try {
    decoded = decodeURIComponent(bare)
  } catch {
    return href
  }
  if (!slashable(decoded)) return href
  return `${bare}/${q === -1 ? '' : href.slice(q)}`
}
