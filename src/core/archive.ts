import { statfs } from 'node:fs/promises'
import { posix } from 'node:path'
import * as tar from 'tar'
import { InlayError } from './errors.js'

export const ARCHIVE_DISK_RESERVE = 512 * 1024 ** 2
export const ARCHIVE_MAX_ENTRIES = 1_000_000

/** The normalized form of an entry name, or null when it is absolute or climbs out with `..`. */
function safePath(raw: string): string | null {
  if (raw.startsWith('/') || raw.includes('\\') || raw.includes('\0')) return null
  const clean = posix.normalize(raw)
  if (clean.startsWith('/') || clean.split('/').includes('..') || clean === '.') return null
  return clean
}

/**
 * Extracts only regular-file entries whose normalized path (less one leading `./`) passes `allow`, into `dir`.
 * Everything else (absolute paths, `..`, symlinks, hardlinks, directories, devices) is skipped. Returns the
 * extracted paths. Refuses with `error.archiveNoSpace` once the allowed entries pass the byte limit (free disk space less a reserve,
 * unless overridden) and with `error.archiveTooManyFiles` once they pass the entry limit.
 */
export async function extractArchive(
  file: string,
  dir: string,
  allow: (path: string) => boolean,
  limits: { maxBytes?: number; maxEntries?: number } = {},
): Promise<string[]> {
  let maxBytes = limits.maxBytes
  if (maxBytes === undefined) {
    const fsStat = await statfs(dir)
    maxBytes = Math.max(0, fsStat.bavail * fsStat.bsize - ARCHIVE_DISK_RESERVE)
  }
  const maxEntries = limits.maxEntries ?? ARCHIVE_MAX_ENTRIES
  const limit = maxBytes
  const extracted: string[] = []
  let bytes = 0
  let tooLarge = false
  let tooMany = false
  try {
    await tar.x({
      file,
      cwd: dir,
      strict: true,
      preservePaths: false,
      filter: (path, entry) => {
        if (!('type' in entry) || entry.type !== 'File') return false
        // `tar -C dir .` writes every name as `./name`; any other untidy name is skipped.
        const name = path.startsWith('./') ? path.slice(2) : path
        const clean = safePath(name)
        if (clean === null || clean !== name || !allow(clean)) return false
        if (tooLarge || tooMany) return false
        if (extracted.length + 1 > maxEntries) {
          tooMany = true
          return false
        }
        bytes += entry.size
        if (bytes > limit) {
          tooLarge = true
          return false
        }
        extracted.push(clean)
        return true
      },
    })
  } catch {
    throw new InlayError('validation', 'error.archiveUnreadable')
  }
  if (tooMany) throw new InlayError('validation', 'error.archiveTooManyFiles', { count: maxEntries })
  if (tooLarge) throw new InlayError('validation', 'error.archiveNoSpace')
  return extracted
}
