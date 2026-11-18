import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { InlayError } from '../errors.js'

/** What `current.json` holds: the release activation last made current. */
export interface CurrentPointer {
  id: string
  name: string
  activatedAt: string
}

function isPointer(value: unknown): value is CurrentPointer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  if (keys.length !== 3 || keys[0] !== 'activatedAt' || keys[1] !== 'id' || keys[2] !== 'name') return false
  const { id, name, activatedAt } = value as Record<string, unknown>
  return typeof id === 'string' && id !== '' && typeof name === 'string' && typeof activatedAt === 'string'
}

const POINTER = 'current.json'

/** The `releases` folder beside the database file, as in the host's data folder. */
export function releasesDirOf(dbPath: string): string {
  return join(dirname(dbPath), 'releases')
}

/** The folder a stored release is extracted into. */
export function releaseDir(releasesDir: string, id: string): string {
  return join(releasesDir, id)
}

/** The release `current.json` names, or null before anything has been activated. */
export async function readCurrentPointer(releasesDir: string): Promise<CurrentPointer | null> {
  const file = join(releasesDir, POINTER)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  try {
    const value: unknown = JSON.parse(text)
    if (!isPointer(value)) throw new Error('not a pointer')
    const { id, name, activatedAt } = value
    return { id, name, activatedAt }
  } catch {
    throw new InlayError('release', 'error.releasePointerInvalid', { file })
  }
}

/**
 * Replaces `current.json` in one step, so a reader sees the old pointer or the new one and never half of one. The
 * temporary file's name is this call's own, so two writers at once don't trip over each other: the last rename wins.
 */
export async function writeCurrentPointer(releasesDir: string, pointer: CurrentPointer): Promise<void> {
  const tmp = join(releasesDir, `.${POINTER}.${process.pid}-${randomUUID()}.tmp`)
  try {
    await writeFile(tmp, `${JSON.stringify(pointer, null, 2)}\n`)
    await rename(tmp, join(releasesDir, POINTER))
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}

/** Removes `current.json`, so no release is live. */
export async function removeCurrentPointer(releasesDir: string): Promise<void> {
  await rm(join(releasesDir, POINTER), { force: true })
}
