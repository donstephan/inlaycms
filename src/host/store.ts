import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { sql, type Kysely, type Selectable } from 'kysely'
import type { Database, ReleasesTable } from '../core/db/schema.js'
import { InlayError } from '../core/errors.js'
import { sweepCodeVariants } from '../core/media/store.js'
import { readCurrentPointer, releaseDir, type CurrentPointer } from '../core/release/pointer.js'
import { loadRelease, openRelease, type LoadedRelease } from '../core/release/read.js'

export {
  readCurrentPointer,
  releaseDir,
  releasesDirOf,
  removeCurrentPointer,
  writeCurrentPointer,
  type CurrentPointer,
} from '../core/release/pointer.js'

/** A `releases` row with its secret names parsed. `schema` stays the JSON text it was stored as. */
export interface ReleaseRow extends Omit<Selectable<ReleasesTable>, 'secrets'> {
  secrets: string[]
}

function toRow(row: Selectable<ReleasesTable>): ReleaseRow {
  return { ...row, secrets: JSON.parse(row.secrets) as string[] }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Keeps the release file at `file` as `<id>.tgz`, opens it into `<id>/` and records it as staged. The signature is
 * checked before anything else is read and the site code is never loaded: the current worker calls this for a push
 * and goes on serving its own release. On any failure nothing is left on disk or in the database.
 */
export async function storeRelease(
  deps: { db: Kysely<Database>; releasesDir: string; trustedKeys: readonly string[]; now: () => Date },
  file: string,
  opts: { pushedBy: string | null; name?: string },
): Promise<ReleaseRow> {
  const id = randomUUID()
  const kept = join(deps.releasesDir, `${id}.tgz`)
  const dir = releaseDir(deps.releasesDir, id)
  try {
    await mkdir(dir, { recursive: true })
    await copyFile(file, kept)
    const { manifest, signedBy } = await openRelease(kept, { dir, trustedKeys: deps.trustedKeys })
    const row: Selectable<ReleasesTable> = {
      id,
      name: opts.name ?? manifest.name,
      state: 'staged',
      file: `${id}.tgz`,
      checksum: await sha256File(kept),
      signed_by: signedBy,
      inlay_range: manifest.inlay.range,
      secrets: JSON.stringify(manifest.secrets),
      schema: JSON.stringify(manifest.schema),
      pushed_by: opts.pushedBy,
      pushed_at: deps.now().toISOString(),
      activated_at: null,
      deactivated_at: null,
    }
    await deps.db.insertInto('releases').values(row).execute()
    return toRow(row)
  } catch (e) {
    await rm(kept, { force: true })
    await rm(dir, { recursive: true, force: true })
    throw e
  }
}

/** Every release the host has received, deleted ones included, newest first. */
export async function listReleases(db: Kysely<Database>): Promise<ReleaseRow[]> {
  const rows = await db
    .selectFrom('releases')
    .selectAll()
    .orderBy('pushed_at', 'desc')
    .orderBy(sql`rowid`, 'desc')
    .execute()
  return rows.map(toRow)
}

export async function getRelease(db: Kysely<Database>, id: string): Promise<ReleaseRow | null> {
  const row = await db.selectFrom('releases').selectAll().where('id', '=', id).executeTakeFirst()
  return row ? toRow(row) : null
}

export async function currentRelease(db: Kysely<Database>): Promise<ReleaseRow | null> {
  const row = await db.selectFrom('releases').selectAll().where('state', '=', 'current').executeTakeFirst()
  return row ? toRow(row) : null
}

/** Marks a release that isn't current as deleted and removes its file and folder. The row stays as history. */
export async function deleteRelease(
  deps: { db: Kysely<Database>; releasesDir: string; mediaDir?: string },
  id: string,
): Promise<void> {
  const result = await deps.db
    .updateTable('releases')
    .set({ state: 'deleted' })
    .where('id', '=', id)
    .where('state', '!=', 'current')
    .executeTakeFirst()
  if (result.numUpdatedRows === 0n) {
    const row = await getRelease(deps.db, id)
    if (row === null) throw new InlayError('not_found', 'error.releaseUnknown', { id })
    throw new InlayError('release', 'error.releaseCurrent', { name: row.name })
  }
  const row = await getRelease(deps.db, id)
  if (row) await rm(join(deps.releasesDir, row.file), { force: true })
  await rm(releaseDir(deps.releasesDir, id), { recursive: true, force: true })
  if (deps.mediaDir === undefined) return
  try {
    await sweepUnusedCodeVariants(deps.db, deps.releasesDir, deps.mediaDir)
  } catch {
    // Best effort: the release is gone either way, and the next delete sweeps again.
  }
}

/** Removes the cached variants of code images that no remaining release names. */
async function sweepUnusedCodeVariants(db: Kysely<Database>, releasesDir: string, mediaDir: string): Promise<void> {
  const keep = new Set<string>()
  for (const row of await listReleases(db)) {
    if (row.state === 'deleted') continue
    try {
      const manifest = JSON.parse(await readFile(join(releaseDir(releasesDir, row.id), 'manifest.json'), 'utf8')) as {
        content?: Array<{ path?: unknown; code?: unknown }>
      }
      for (const entry of manifest.content ?? []) {
        if (entry.code !== true || typeof entry.path !== 'string') continue
        const name = entry.path.slice(entry.path.lastIndexOf('/') + 1)
        keep.add(name.slice(0, name.length - extname(name).length))
      }
    } catch {
      continue
    }
  }
  await sweepCodeVariants(mediaDir, keep)
}

/**
 * Loads the current release for a worker: null with no pointer, `missing` when the pointer names a release whose
 * folder or site code is gone (it has to be pushed again).
 */
export async function openCurrentRelease(deps: {
  releasesDir: string
  load?: (siteJs: string) => Promise<unknown>
}): Promise<{ pointer: CurrentPointer; loaded: LoadedRelease } | { pointer: CurrentPointer; missing: true } | null> {
  const pointer = await readCurrentPointer(deps.releasesDir)
  if (pointer === null) return null
  const dir = releaseDir(deps.releasesDir, pointer.id)
  if (!existsSync(join(dir, 'site.js')) || !existsSync(join(dir, 'manifest.json'))) return { pointer, missing: true }
  return { pointer, loaded: await loadRelease(dir, deps.load ? { load: deps.load } : {}) }
}
