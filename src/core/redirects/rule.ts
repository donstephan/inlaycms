import type { Registry } from '../registry/registry.js'
import { isReserved, normalizePath } from '../site/paths.js'
import { paramNames } from './collapse.js'

const ORIGIN = /^https?:\/\/[^/?#]*/i

/** A clean decoded site path without a query or fragment, or `null`. */
export function cleanPath(raw: string): string | null {
  const path = normalizePath(raw)
  return path === null || path.includes('?') || path.includes('#') ? null : path
}

/**
 * The stored form of a redirect's `from` (a full http(s) URL loses its origin), or `null` if it can't be
 * used. A default-locale prefix can't be used: such a request is sent to the unprefixed path first.
 */
export function redirectFrom(registry: Pick<Registry, 'defaultLocale'>, raw: string): string | null {
  const trimmed = raw.trim()
  const stripped = trimmed.replace(ORIGIN, '')
  const path = cleanPath(stripped === '' && stripped !== trimmed ? '/' : stripped)
  if (path === null || isReserved(path) || path.split('/')[1] === registry.defaultLocale) return null
  const names = paramNames(path)
  return new Set(names).size === names.length ? path : null
}

/**
 * The first segment of a target path when it is the default locale, or lowercases to it (the lowercase
 * fallback would take it there), else `null`. A request there is sent on to the unprefixed path, so
 * such a target loops back.
 */
export function defaultLocalePrefix(registry: Pick<Registry, 'defaultLocale'>, path: string): string | null {
  const first = path.split('/')[1] ?? ''
  return first === registry.defaultLocale || first.toLowerCase() === registry.defaultLocale ? first : null
}

/**
 * The `href` of an absolute https URL target, or `null` if it can't be used. Control characters are refused
 * before parsing because the URL parser silently drops a tab or newline.
 */
export function externalTarget(raw: string): string | null {
  const trimmed = raw.trim()
  if (/[\u0000-\u001f\u007f]/.test(trimmed) || !/^https:\/\//i.test(trimmed)) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname === '') return null
  return url.href
}

export function isUrlTarget(to: string): boolean {
  return to.startsWith('https://')
}

export function targetOf(to: string): { path: string } | { url: string } {
  return isUrlTarget(to) ? { url: to } : { path: to }
}
