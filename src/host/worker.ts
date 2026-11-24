import cluster from 'node:cluster'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import type { HostApi } from '../adapters/site/plugin.js'
import { openDatabase } from '../core/db/connection.js'
import { InlayError } from '../core/errors.js'
import { t, type MessageId } from '../core/messages/index.js'
import { keyStillTrusted } from '../core/release/keys.js'
import { checkInlayVersion, loadRelease, type LoadedRelease } from '../core/release/read.js'
import { packedVersion, releaseFit } from '../core/release/window.js'
import { activateRelease, summarize } from './activate.js'
import { createSiteApp } from './app.js'
import type { HostConfig } from './config.js'
import { drainable } from './drain.js'
import { runPreviewWorker } from './preview-worker.js'
import {
  ACTIVATION_TIMEOUT_MS,
  activationError,
  isPrimaryMessage,
  PREVIEW_START_TIMEOUT_MS,
  toIpcError,
  type ActivationSummary,
  type PrimaryMessage,
  type WorkerMessage,
} from './ipc.js'
import { currentRelease, getRelease, openCurrentRelease, readCurrentPointer, releaseDir, writeCurrentPointer } from './store.js'

export interface WorkerIo {
  send: (m: WorkerMessage) => void
  onMessage: (fn: (m: PrimaryMessage) => void) => void
  exit: (code: number) => void
  /** Where `host.*` lines go; stderr when not given. */
  log?: (id: MessageId, params?: Record<string, string | number>) => void
  /** Fastify's request log; on by default. */
  logger?: boolean
}

/** Where a worker listens: a port on the host's address, or a Unix socket (preview workers). */
export type ListenTarget = { port: number } | { path: string }

export interface WorkerEnv {
  /** The release to activate; for a current worker, the release the primary expects (the database decides). */
  releaseId: string | null
  activate: boolean
  /** Serve this page instead of the site whatever the database says: the primary gave up on the current release. */
  noSite?: 'empty' | 'unavailable'
  /** Default: the port the host's settings give. */
  listen?: ListenTarget
  /** Run the preview of this staged release instead of the site (`runPreviewWorker`). */
  preview?: string
  /** With `preview`: the push's scratch folder the release is in, for a dry run. */
  previewDir?: string
}

/** What the primary tells a worker through its environment (`INLAY_WORKER_*`). */
export function readWorkerEnv(env: NodeJS.ProcessEnv): WorkerEnv {
  const noSite = env.INLAY_WORKER_NO_SITE
  const preview = env.INLAY_WORKER_PREVIEW
  const listen = env.INLAY_WORKER_LISTEN
  const previewDir = env.INLAY_WORKER_PREVIEW_DIR
  let target: ListenTarget | undefined
  if (listen) {
    const port = /^port:(\d+)$/.exec(listen)
    const socket = /^socket:(.+)$/.exec(listen)
    if (port && Number(port[1]) <= 65535) target = { port: Number(port[1]) }
    else if (socket) target = { path: socket[1]! }
    else throw new InlayError('config', 'config.host.workerListen', { value: listen })
  }
  return {
    releaseId: env.INLAY_WORKER_RELEASE || null,
    activate: env.INLAY_WORKER_ACTIVATE === '1',
    ...((noSite === 'empty' || noSite === 'unavailable') && { noSite }),
    ...(target && { listen: target }),
    ...(preview && { preview }),
    ...(preview && previewDir && { previewDir }),
  }
}

const problem = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * The release `id`, or with null the release the database says is current, read over a short-lived connection; null
 * when there is none (before the first release).
 */
async function releaseRow(config: HostConfig, id: string | null) {
  const db = openDatabase(config.paths.db)
  try {
    const { rows } = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'releases'`.execute(db)
    if (rows.length === 0) return null
    return id === null ? await currentRelease(db) : await getRelease(db, id)
  } finally {
    await db.destroy()
  }
}

/** `id`: the release the database says is current, also when its page is "unavailable"; null for the empty page. */
type Served = { loaded: LoadedRelease; id: string; name: string } | { page: 'empty' | 'unavailable'; id: string | null }

/**
 * What a current worker serves. The database decides which release is live: without a current row, nothing is
 * (whatever `current.json` says); with one, `current.json` is repaired to name it, and its release is served if it
 * suits this version of Inlay and its files are there. A live release that can't be served gives the
 * "temporarily unavailable" page.
 */
async function chooseRelease(config: HostConfig, log: NonNullable<WorkerIo['log']>): Promise<Served> {
  const row = await releaseRow(config, null)
  if (row === null) return { page: 'empty', id: null }
  let pointer = null
  try {
    pointer = await readCurrentPointer(config.paths.releases)
  } catch (e) {
    if (!(e instanceof InlayError) || e.messageId !== 'error.releasePointerInvalid') throw e
    log('host.pointerUnreadable', { problem: e.message })
  }
  if (pointer?.id !== row.id) {
    await writeCurrentPointer(config.paths.releases, {
      id: row.id,
      name: row.name,
      activatedAt: row.activated_at ?? new Date().toISOString(),
    })
    log('host.pointerRepaired', { name: row.name })
  }
  try {
    checkInlayVersion(packedVersion(row.inlay_range))
  } catch (e) {
    if (!(e instanceof InlayError)) throw e
    if (e.messageId !== 'error.releaseTooOld' && e.messageId !== 'error.releaseTooNew') throw e
    log(e.messageId === 'error.releaseTooOld' ? 'host.releaseTooOld' : 'host.releaseTooNew', { ...e.params, name: row.name })
    return { page: 'unavailable', id: row.id }
  }
  const opened = await openCurrentRelease({ releasesDir: config.paths.releases })
  if (opened === null || 'missing' in opened) {
    log('host.releaseMissing', { name: row.name })
    return { page: 'unavailable', id: row.id }
  }
  if (!keyStillTrusted(row.signed_by, config.trustedKeys)) log('host.releaseKeyUntrusted', { name: row.name, key: row.signed_by })
  const packed = packedVersion(row.inlay_range)
  if (releaseFit(packed) === 'warn') log('host.releasePackAgain', { name: row.name, packed })
  return { loaded: opened.loaded, id: row.id, name: row.name }
}

/**
 * One worker of `inlaycms serve` (spec §8.4). An activation worker loads the release (a `site.js` that fails to load
 * fails here), builds its app, activates the release, tells the primary `activated`, and only then listens; a
 * current worker serves the release the database says is current. It tells the primary `ready` once listening,
 * and on `shutdown` finishes in-flight requests and exits. A preview worker runs `runPreviewWorker` instead.
 */
export async function runWorker(config: HostConfig, env: WorkerEnv, io: WorkerIo): Promise<void> {
  if (env.preview) {
    const socket = env.listen && 'path' in env.listen ? env.listen.path : undefined
    return runPreviewWorker(config, env.preview, io, { ...(socket !== undefined && { socket }), ...(env.previewDir && { dir: env.previewDir }) })
  }
  const log = io.log ?? ((id: MessageId, params?: Record<string, string | number>) => console.error(t(id, params)))
  let app: FastifyInstance | null = null
  let drain: (() => Promise<void>) | null = null
  let listening = false
  let stopping = false
  let exiting = false

  const finish = async (code: number) => {
    if (exiting) return
    exiting = true
    try {
      // Finish with the visitors' open connections first, so a swap never resets a request.
      if (listening) await drain?.()
      await app?.close()
    } finally {
      io.exit(code)
    }
  }

  io.onMessage((m) => {
    if (m.type !== 'shutdown' || stopping) return
    stopping = true
    // Before listening, the main flow stops at its next step, so an activation is never cut off mid-way.
    if (listening) void finish(0)
  })

  const host: HostApi = {
    requestActivation: (id) => requestActivation(id),
    startPreview: (id, o) => requestPreview(id, undefined, o),
    stopPreview: (id) => stopPreview(id),
    touchPreview: (id) => touchPreview(id),
  }
  type BuildOptions = { noSite?: 'empty' | 'unavailable'; release?: { id: string; name: string } }
  const build = async (loaded: LoadedRelease | null, opts: BuildOptions) => {
    app = (
      await createSiteApp(config, loaded, {
        content: 'none',
        logger: io.logger ?? true,
        host,
        ...(opts.noSite && { noSite: opts.noSite }),
        ...(opts.release && { release: opts.release }),
      })
    ).app
    drain = drainable(app.server)
    return app
  }
  const listen = async () => {
    const target = env.listen ?? { port: config.port }
    await app!.listen('path' in target ? { path: target.path } : { port: target.port, host: config.host })
  }

  if (env.activate) {
    const releaseId = env.releaseId ?? ''
    let name = releaseId
    let activation: ActivationSummary | null = null
    try {
      const loaded = await loadRelease(releaseDir(config.paths.releases, releaseId))
      name = (await releaseRow(config, releaseId))?.name ?? loaded.manifest.name
      await build(loaded, { release: { id: releaseId, name } })
      if (stopping) return void (await finish(0))
      // Its own connection, outside anything the app's connection runs, so the activation is one transaction. It
      // waits longer for the write lock than the app does: the live worker may be in the middle of a save.
      const db = openDatabase(config.paths.db, { busyTimeoutMs: 30_000 })
      try {
        const result = await activateRelease(
          {
            db,
            loaded,
            releasesDir: config.paths.releases,
            backupsDir: config.paths.backups,
            mediaDir: config.paths.media,
            secretsEnv: config.secrets,
            now: () => new Date(),
          },
          releaseId,
        )
        name = result.release.name
        if (result.pointerError !== null) log('host.pointerWriteFailed', { name, problem: result.pointerError })
        activation = summarize(result)
      } finally {
        await db.destroy()
      }
      io.send({ type: 'activated', activation })
      if (stopping) return void (await finish(0))
      await listen()
    } catch (e) {
      if (activation === null) log('host.activationFailed', { name, problem: problem(e) })
      else log('error.releaseActivatedNotServing', { problem: problem(e) })
      io.send({ type: 'failed', error: toIpcError(e) })
      return void (await finish(1))
    }
    listening = true
    log('host.activated', { name })
    io.send({ type: 'ready', releaseId, activation })
    if (stopping) await finish(0)
    return
  }

  let served: Served
  try {
    served = env.noSite ? { page: env.noSite, id: env.releaseId } : await chooseRelease(config, log)
    if ('page' in served) await build(null, { noSite: served.page })
    else await build(served.loaded, { release: { id: served.id, name: served.name } })
    if (stopping) return void (await finish(0))
    await listen()
  } catch (e) {
    log('host.workerFailed', { problem: problem(e) })
    return void (await finish(1))
  }
  listening = true
  if ('loaded' in served) log('host.serving', { url: config.baseUrl, name: served.loaded.manifest.name })
  else if (served.page === 'empty') log('host.servingNoSite', { url: config.baseUrl })
  else log('host.servingUnavailable', { url: config.baseUrl })
  // A live release served as "unavailable" is still the current one, so a crash loop falls back to that page.
  io.send({ type: 'ready', releaseId: served.id })
  if (stopping) await finish(0)
}

export { ACTIVATION_TIMEOUT_MS, PREVIEW_START_TIMEOUT_MS } from './ipc.js'

/** What `requestActivation` talks to: the cluster worker's IPC channel unless a test gives another. */
export interface ActivationChannel {
  isWorker: boolean
  send: (m: WorkerMessage) => void
  onMessage: (fn: (m: unknown) => void) => () => void
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

function processChannel(): ActivationChannel {
  return {
    isWorker: cluster.isWorker && process.send !== undefined,
    send: (m) => process.send!(m),
    onMessage: (fn) => {
      process.on('message', fn)
      return () => process.off('message', fn)
    },
  }
}

/**
 * Asks the primary of `inlaycms serve` to make a stored release live, from inside the current worker (push, the
 * admin); a site reaches it as `app.inlay.host.requestActivation`. Resolves with what the activation did once the
 * new release's worker is serving; rejects with the activation's error, or after 10 minutes without an answer.
 */
export function requestActivation(releaseId: string, channel: ActivationChannel = processChannel()): Promise<ActivationSummary> {
  if (!channel.isWorker) return Promise.reject(new InlayError('invalid_operation', 'error.hostNoPrimary'))
  const setTimer = channel.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = channel.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout))
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    const stop = channel.onMessage((m) => {
      if (!isPrimaryMessage(m) || m.type !== 'activation' || m.requestId !== requestId) return
      stop()
      clearTimer(timer)
      if (m.ok) resolve(m.activation)
      else reject(activationError(m.error))
    })
    const timer = setTimer(() => {
      stop()
      reject(new InlayError('invalid_operation', 'error.activationTimeout'))
    }, ACTIVATION_TIMEOUT_MS)
    channel.send({ type: 'activate', requestId, releaseId })
  })
}

/**
 * Asks the primary for the preview worker of a staged release, from inside the current worker; a site reaches it
 * as `app.inlay.host.startPreview`. Resolves with the Unix socket the preview worker listens on; rejects with the
 * primary's error, or after a minute without an answer. `dir`: the push's scratch folder the release is in (a dry run).
 */
export function requestPreview(
  releaseId: string,
  channel: ActivationChannel = processChannel(),
  opts: { dir?: string } = {},
): Promise<string> {
  if (!channel.isWorker) return Promise.reject(new InlayError('invalid_operation', 'error.hostNoPrimary'))
  const setTimer = channel.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = channel.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout))
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    const stop = channel.onMessage((m) => {
      if (!isPrimaryMessage(m) || m.type !== 'preview' || m.requestId !== requestId) return
      stop()
      clearTimer(timer)
      if (m.ok) resolve(m.socket)
      else reject(activationError(m.error))
    })
    const timer = setTimer(() => {
      stop()
      reject(new InlayError('invalid_operation', 'error.previewUnavailable'))
    }, PREVIEW_START_TIMEOUT_MS)
    channel.send({ type: 'preview-start', requestId, releaseId, ...(opts.dir !== undefined && { dir: opts.dir }) })
  })
}

/** Tells the primary a release's preview worker is no longer needed; nothing outside a worker of `inlaycms serve`. */
export async function stopPreview(releaseId: string, channel: ActivationChannel = processChannel()): Promise<void> {
  if (channel.isWorker) channel.send({ type: 'preview-stop', releaseId })
}

/** Tells the primary a release's preview is still in use; nothing outside a worker of `inlaycms serve`. */
export function touchPreview(releaseId: string, channel: ActivationChannel = processChannel()): void {
  if (channel.isWorker) channel.send({ type: 'preview-touch', releaseId })
}
