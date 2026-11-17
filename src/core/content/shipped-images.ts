import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * What an image target in shipped Markdown names: a library image (`inlay:`), a file inside the site's folder
 * (`url` is its `file:` URL's href, the key it goes by everywhere), or something shipped content can't use.
 */
export type ImageTarget =
  | { kind: 'library' }
  | { kind: 'file'; url: string; path: string }
  | { kind: 'remote' }
  | { kind: 'rooted' }
  | { kind: 'outside' }
  | { kind: 'other' }

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** True if `path` is below `root`, going by the names alone. */
function contains(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

/**
 * What `src`, an image target as written in shipped Markdown, names. A path relative to the site's folder
 * (`siteDir`, a `file:` URL ending in `/`) and a `file:` URL name the same file by the same `url`. Only the names are
 * looked at here: `realInside` checks where the file really is.
 */
export function imageTarget(src: string, siteDir: string | null): ImageTarget {
  if (src.startsWith('inlay:')) return { kind: 'library' }
  if (/^https?:/i.test(src)) return { kind: 'remote' }
  if (src.startsWith('/')) return { kind: 'rooted' }
  const isFileUrl = /^file:/i.test(src)
  if (!isFileUrl && SCHEME.test(src)) return { kind: 'other' }
  if (siteDir === null) return { kind: 'outside' }
  try {
    const url = isFileUrl ? new URL(src) : new URL(src, siteDir)
    const path = fileURLToPath(url)
    if (!contains(fileURLToPath(siteDir), path)) return { kind: 'outside' }
    return { kind: 'file', url: url.href, path }
  } catch {
    // A file: URL naming another host, or a path no file can have.
    return { kind: 'outside' }
  }
}

/**
 * `path` with every link followed, if that is inside the site's folder; null when it isn't or either can't be
 * resolved. Read the file by the path returned, so it is the one that was checked.
 */
export async function realInside(path: string, siteDir: string): Promise<string | null> {
  try {
    const [root, real] = await Promise.all([realpath(fileURLToPath(siteDir)), realpath(path)])
    return contains(root, real) ? real : null
  } catch {
    return null
  }
}

/** `realInside`, without waiting. */
export function realInsideSync(path: string, siteDir: string): string | null {
  try {
    const real = realpathSync(path)
    return contains(realpathSync(fileURLToPath(siteDir)), real) ? real : null
  } catch {
    return null
  }
}
