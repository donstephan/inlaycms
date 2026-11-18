import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { snapshotDatabase } from '../core/backup/backup.js'
import { createCore, type Core } from '../core/core.js'
import { openDatabase } from '../core/db/connection.js'
import { InlayError } from '../core/errors.js'
import { t, type MessageId } from '../core/messages/index.js'
import { loadRelease, type LoadedRelease } from '../core/release/read.js'
import { createSiteApp } from './app.js'
import type { HostConfig } from './config.js'
import { isScratchDir, previewSocket, toIpcError } from './ipc.js'
import type { ContentDiff } from './push.js'
import { getRelease, releaseDir, type ReleaseRow } from './store.js'
import type { WorkerIo } from './worker.js'

/** A staged release's preview: its app on a copy of the live database, listening on a Unix socket. */
export interface PreviewApp {
  app: FastifyInstance
  core: Core
  socket: string
  /** Stops listening and removes the copy. */
  close(): Promise<void>
}

/** Where the preview of `releaseId` keeps its copy of the database (`dir`) and listens (`socket`). */
export function previewPaths(config: Pick<HostConfig, 'dataDir'>, releaseId: string): { dir: string; socket: string } {
  return { dir: join(config.dataDir, 'run', `preview-${releaseId}`), socket: previewSocket(config.dataDir, releaseId) }
}

const RELEASE_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/

/** The release's row in the copy of the database; it must still be staged. */
async function stagedRelease(file: string, releaseId: string): Promise<ReleaseRow> {
  const db = openDatabase(file)
  try {
    const row = await getRelease(db, releaseId).catch(() => null)
    if (row === null) throw new InlayError('not_found', 'error.releaseUnknown', { id: releaseId })
    if (row.state !== 'staged') throw new InlayError('invalid_operation', 'error.previewNotStaged', { name: row.name })
    return row
  } finally {
    await db.destroy()
  }
}

/**
 * Records a release a dry run pushed, which is only in the push's scratch folder, as staged in the copy of the
 * database: the live `releases` table never has it.
 */
async function stageInCopy(file: string, releaseId: string, loaded: LoadedRelease, now: Date): Promise<ReleaseRow> {
  const { manifest } = loaded
  const db = openDatabase(file)
  try {
    await db
      .insertInto('releases')
      .values({
        id: releaseId,
        name: manifest.name,
        state: 'staged',
        file: `${releaseId}.tgz`,
        checksum: '',
        signed_by: '',
        inlay_range: manifest.inlay.range,
        secrets: JSON.stringify(manifest.secrets),
        schema: JSON.stringify(manifest.schema),
        pushed_by: null,
        pushed_at: now.toISOString(),
        activated_at: null,
        deactivated_at: null,
      })
      .execute()
    return (await getRelease(db, releaseId))!
  } finally {
    await db.destroy()
  }
}

/** The types the staged release would leave with gaps, without the counts by locale the diff doesn't show. */
async function gapsOf(core: Core): Promise<ContentDiff['gaps']> {
  return (await core.gapSummary()).map(({ type, label, documents }) => ({ type, label, documents }))
}

/** A consistent copy of the live database at `target`, made without writing to it (as `checkDatabase` does). */
async function snapshot(live: string, target: string): Promise<void> {
  if (!existsSync(`${live}-wal`)) return copyFile(live, target)
  const source = openDatabase(live, { readonly: true })
  try {
    await snapshotDatabase(source, target)
  } finally {
    await source.destroy()
  }
}

/**
 * A media folder for the preview: a link to each of the live folder's files, so the preview shows them, while the
 * files the staged release ships and the image sizes it makes are written here, never to the live folder.
 */
async function overlayMedia(live: string, into: string): Promise<void> {
  await mkdir(into, { recursive: true })
  let entries
  try {
    entries = await readdir(live, { withFileTypes: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    throw e
  }
  for (const entry of entries) {
    if (entry.isFile() && !entry.name.startsWith('.')) await symlink(join(live, entry.name), join(into, entry.name))
  }
}

/**
 * Starts the preview of a staged release (spec §7): a copy of the live database (`VACUUM INTO`) with the release's
 * shipped content applied by the real boot path, served by the release's own code read-only and always in preview
 * state, listening on the Unix socket `socket` (default: `previewPaths(...).socket`). The live database and media
 * folder are only read. The release's migration functions run on the copy too. Also serves
 * `GET /_inlay/internal/diff`: what the release finds against live content, with the shipped content worked out
 * before it was applied.
 *
 * With `dir` (a push's scratch folder, `<releases>/.push-*`), the release is read from there and recorded as staged
 * only in the copy: a dry run that never touches the live `releases` table.
 */
export async function startPreviewApp(
  config: HostConfig,
  releaseId: string,
  opts: { now?: () => Date; logger?: boolean; socket?: string; dir?: string } = {},
): Promise<PreviewApp> {
  // The ID names files: nothing but what a release ID can be.
  if (!RELEASE_ID.test(releaseId)) throw new InlayError('not_found', 'error.releaseUnknown', { id: releaseId })
  if (!existsSync(config.paths.db)) throw new InlayError('not_found', 'error.releaseUnknown', { id: releaseId })
  if (opts.dir !== undefined && !isScratchDir(config.paths.releases, opts.dir)) {
    throw new InlayError('not_found', 'error.releaseUnknown', { id: releaseId })
  }
  const now = opts.now ?? (() => new Date())
  const paths = previewPaths(config, releaseId)
  const socket = opts.socket ?? paths.socket
  const { dir } = paths
  await rm(dir, { recursive: true, force: true })
  try {
    await mkdir(join(dir, 'backups'), { recursive: true })
    const db = join(dir, 'inlay.db')
    const media = join(dir, 'media')
    await snapshot(config.paths.db, db)
    let row: ReleaseRow
    let loaded: LoadedRelease
    if (opts.dir === undefined) {
      row = await stagedRelease(db, releaseId)
      loaded = await loadRelease(releaseDir(config.paths.releases, releaseId))
    } else {
      loaded = await loadRelease(releaseDir(opts.dir, releaseId))
      row = await stageInCopy(db, releaseId, loaded, now())
    }
    await overlayMedia(config.paths.media, media)

    // What the release would ship, worked out on the copy before boot applies it.
    const before = openDatabase(db)
    let shipped
    try {
      const core = createCore({
        site: loaded.site,
        db: before,
        media,
        shippedFiles: loaded.shippedFiles,
        ...(opts.now && { now: opts.now }),
      })
      shipped = await core.applyShippedContent({ dryRun: true })
    } finally {
      await before.destroy()
    }

    const { app, core } = await createSiteApp({ ...config, paths: { ...config.paths, db, media, backups: join(dir, 'backups') } }, loaded, {
      content: 'apply',
      readOnly: true,
      backupSchedule: false,
      preview: 'forced',
      release: { id: releaseId, name: row.name },
      diff: async (previewCore): Promise<ContentDiff> => ({
        gaps: await gapsOf(previewCore),
        shipped,
        hidden: await previewCore.hiddenDocuments(),
      }),
      ...(opts.logger !== undefined && { logger: opts.logger }),
      ...(opts.now && { now: opts.now }),
    })
    try {
      await rm(socket, { force: true })
      await app.listen({ path: socket })
    } catch (e) {
      await app.close()
      throw e
    }
    return {
      app,
      core,
      socket,
      async close() {
        try {
          await app.close()
        } finally {
          await rm(dir, { recursive: true, force: true })
          await rm(socket, { force: true })
        }
      },
    }
  } catch (e) {
    await rm(dir, { recursive: true, force: true })
    throw e
  }
}

/**
 * A preview worker of `inlaycms serve` (`INLAY_WORKER_PREVIEW=<id>`): starts the staged release's preview, tells the
 * primary `preview-ready` with its socket (or `failed`), and on `shutdown` stops and removes its copy.
 */
export async function runPreviewWorker(
  config: HostConfig,
  releaseId: string,
  io: WorkerIo,
  opts: { socket?: string; dir?: string } = {},
): Promise<void> {
  const log = io.log ?? ((id: MessageId, params?: Record<string, string | number>) => console.error(t(id, params)))
  let preview: PreviewApp | null = null
  let stopping = false
  let exiting = false
  const finish = async (code: number) => {
    if (exiting) return
    exiting = true
    try {
      await preview?.close()
    } finally {
      io.exit(code)
    }
  }
  io.onMessage((m) => {
    if (m.type !== 'shutdown' || stopping) return
    stopping = true
    if (preview) void finish(0)
  })
  try {
    preview = await startPreviewApp(config, releaseId, {
      logger: io.logger ?? true,
      ...(opts.socket !== undefined && { socket: opts.socket }),
      ...(opts.dir !== undefined && { dir: opts.dir }),
    })
  } catch (e) {
    log('host.previewFailed', { id: releaseId, problem: e instanceof Error ? e.message : String(e) })
    io.send({ type: 'failed', error: toIpcError(e) })
    return void (await finish(1))
  }
  if (stopping) return void (await finish(0))
  io.send({ type: 'preview-ready', releaseId, socket: preview.socket })
}
