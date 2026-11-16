import type { Kysely } from 'kysely'
import { systemCtx } from '../core/auth/roles.js'
import { createBackup, type BackupInfo } from '../core/backup/backup.js'
import { withTransaction } from '../core/content/dry-run.js'
import { runReleaseMigrations } from '../core/content/release-migrations.js'
import { planShippedContent, storeShippedFiles, writeShippedContent, type ShippedReport } from '../core/content/shipped.js'
import type { Database } from '../core/db/schema.js'
import { InlayError } from '../core/errors.js'
import { DEFAULT_MAX_BYTES, DEFAULT_UPLOAD_TYPES } from '../core/media/detect.js'
import { fileMediaStore } from '../core/media/store.js'
import type { ReleaseMigration } from '../core/registry/migration.js'
import { buildRegistry } from '../core/registry/registry.js'
import { checkInlayVersion, type LoadedRelease } from '../core/release/read.js'
import type { CoreDeps, Ctx } from '../core/types.js'
import type { ActivationSummary } from './ipc.js'
import { currentRelease, getRelease, readCurrentPointer, writeCurrentPointer, type ReleaseRow } from './store.js'

export interface ActivationResult {
  /** The release, now current. */
  release: ReleaseRow
  /** The release that was current before, now previous; null on the first activation or a no-op. */
  previous: ReleaseRow | null
  shipped: ShippedReport
  /** The migration functions run, in order. */
  migrations: string[]
  backup: BackupInfo | null
  /** True when the release was already current and nothing was done. */
  noop: boolean
  /**
   * Why `current.json` couldn't be written after the commit, or null. The release is current all the same: a
   * worker that starts repairs the pointer from the database.
   */
  pointerError: string | null
}

export interface ActivationDeps {
  db: Kysely<Database>
  /** The release being activated, loaded from its folder in `releasesDir`. */
  loaded: LoadedRelease
  releasesDir: string
  backupsDir: string
  mediaDir: string
  /** The secrets set on the host, by name, for the names given. An empty value is set. */
  secretsEnv: (names: readonly string[]) => Record<string, string>
  now: () => Date
}

const noShipped = (): ShippedReport => ({ created: [], replaced: [], skipped: [], deletedRefs: [], warnings: [] })

/** An activation's result as counts, for the worker that asked for it. */
export function summarize(result: ActivationResult): ActivationSummary {
  return {
    shipped: {
      created: result.shipped.created.length,
      replaced: result.shipped.replaced.length,
      skipped: result.shipped.skipped.length,
    },
    migrations: result.migrations,
    backup: result.backup?.path ?? null,
    noop: result.noop,
    warnings: result.shipped.warnings.length,
  }
}

function contentDeps(deps: ActivationDeps): CoreDeps {
  return {
    db: deps.db,
    registry: buildRegistry(deps.loaded.site),
    now: deps.now,
    media: fileMediaStore(deps.mediaDir),
    backups: deps.backupsDir,
    uploads: { maxBytes: DEFAULT_MAX_BYTES, types: DEFAULT_UPLOAD_TYPES },
    shippedFiles: deps.loaded.shippedFiles,
  }
}

/** Runs the migration functions, turning a failure into an error that names the function that failed. */
async function runMigrations(tx: CoreDeps, releaseId: string, migrations: readonly ReleaseMigration[], ctx: Ctx) {
  let running: string | null = null
  const tracked = migrations.map((m): ReleaseMigration => ({
    name: m.name,
    run: async (api) => {
      running = m.name
      await m.run(api)
      // What fails after the function returned (recording it) isn't the function's fault.
      running = null
    },
  }))
  try {
    return await runReleaseMigrations(tx, releaseId, tracked, ctx)
  } catch (e) {
    if (running === null) throw e
    const problem = e instanceof Error ? e.message : String(e)
    throw new InlayError('release', 'error.releaseMigration', { name: running, problem })
  }
}

/** Writes `current.json`, returning why it failed instead of throwing: the database already says what's current. */
async function updatePointer(releasesDir: string, row: ReleaseRow, now: () => Date): Promise<string | null> {
  try {
    await writeCurrentPointer(releasesDir, { id: row.id, name: row.name, activatedAt: row.activated_at ?? now().toISOString() })
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/** Removes the files an activation stored that no `media` row names now that it was rolled back. Best effort. */
async function removeOrphans(deps: ActivationDeps, stored: ReadonlySet<string>): Promise<void> {
  const media = fileMediaStore(deps.mediaDir)
  for (const id of stored) {
    try {
      const row = await deps.db.selectFrom('media').select('id').where('id', '=', id).executeTakeFirst()
      if (row === undefined) await media.remove(id)
    } catch {
      // A file left behind takes space but harms nothing; the activation's own error matters more.
    }
  }
}

async function hasDocuments(db: Kysely<Database>): Promise<boolean> {
  return (await db.selectFrom('documents').select('id').limit(1).executeTakeFirst()) !== undefined
}

/**
 * Makes a stored release the current one (spec §7). Checks it suits this version of Inlay; already current, it
 * does nothing else and says so. Otherwise: checks the secrets it declares are set, takes a `pre-activation` backup
 * (unless the database has no documents yet), stores the media files its shipped content names, then in one
 * transaction, which takes the write lock before it reads, applies its shipped content by edition, runs its
 * migration functions not yet run and marks it current and the old current release previous; a throw rolls all of
 * it back and removes the media files it stored that nothing names. Writes `current.json` after the commit; a
 * failure there is returned as `pointerError`, not thrown. `deps.loaded` must be the release `releaseId` names, and
 * `deps.db` must not be a transaction (`error.transactionWrite`).
 *
 * The transaction holds the database's write lock from start to end, and the live worker's saves wait at most 5
 * seconds for it before they fail. Files are stored before it opens for that reason, but the shipped content is
 * still planned (its files read) and the release's migration functions run inside it: a release whose functions
 * take long makes editors' saves fail meanwhile.
 */
export async function activateRelease(deps: ActivationDeps, releaseId: string): Promise<ActivationResult> {
  const row = await getRelease(deps.db, releaseId)
  if (row === null) throw new InlayError('not_found', 'error.releaseUnknown', { id: releaseId })
  if (row.state === 'deleted') throw new InlayError('release', 'error.releaseDeleted', { name: row.name })
  checkInlayVersion(row.inlay_range)
  if (row.state === 'current') {
    // A retry after a commit whose pointer write was lost: the database already says it's current.
    const pointer = await readCurrentPointer(deps.releasesDir).catch(() => null)
    const pointerError = pointer?.id === row.id ? null : await updatePointer(deps.releasesDir, row, deps.now)
    return { release: row, previous: null, shipped: noShipped(), migrations: [], backup: null, noop: true, pointerError }
  }

  const present = deps.secretsEnv(row.secrets)
  const missing = row.secrets.find((name) => !Object.hasOwn(present, name))
  if (missing !== undefined) throw new InlayError('release', 'error.releaseSecret', { name: missing })

  const ctx: Ctx = { ...systemCtx('release'), releaseId }
  const backup = (await hasDocuments(deps.db))
    ? await createBackup({
        db: deps.db,
        backups: deps.backupsDir,
        media: deps.mediaDir,
        releases: deps.releasesDir,
        reason: 'pre-activation',
        ctx,
        now: deps.now,
      })
    : null

  const stored = new Set<string>()
  const content = contentDeps(deps)
  let done
  try {
    // Outside the transaction, so it doesn't hold the write lock while files are written. The plan is made again
    // inside it; a file only that one names is stored there.
    await storeShippedFiles(content, await planShippedContent(content), (id) => stored.add(id))
    done = await withTransaction(
      content,
      async (tx) => {
        const plan = await planShippedContent(tx)
        const shipped = await writeShippedContent(tx, plan, { ctx, onFileStored: (id) => stored.add(id) })
        const migrations = await runMigrations(tx, releaseId, deps.loaded.site.migrations, ctx)
        const at = deps.now().toISOString()
        const old = await currentRelease(tx.db)
        if (old) {
          await tx.db.updateTable('releases').set({ state: 'previous', deactivated_at: at }).where('id', '=', old.id).execute()
        }
        await tx.db.updateTable('releases').set({ state: 'current', activated_at: at }).where('id', '=', releaseId).execute()
        return {
          shipped,
          migrations,
          release: (await getRelease(tx.db, releaseId))!,
          previous: old ? await getRelease(tx.db, old.id) : null,
        }
      },
      { write: true },
    )
  } catch (e) {
    await removeOrphans(deps, stored)
    throw e
  }

  const pointerError = await updatePointer(deps.releasesDir, done.release, deps.now)
  return { ...done, backup, noop: false, pointerError }
}
