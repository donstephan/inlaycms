import { InlayError } from '../core/errors.js'
import { t, type MessageId } from '../core/messages/index.js'
import type { HostConfig } from './config.js'
import {
  ACTIVATION_TIMEOUT_MS,
  activationError,
  PREVIEW_IDLE_MS,
  PREVIEW_START_TIMEOUT_MS,
  previewSocket,
  toIpcError,
  type ActivationSummary,
  type IpcError,
  type PrimaryMessage,
  type WorkerMessage,
} from './ipc.js'
import { isScratchDir, readCurrentPointer } from './store.js'

/** One worker process as the supervisor sees it; `serve` wraps a `cluster` worker, tests a fake. */
export interface WorkerHandle {
  id: number
  send(m: PrimaryMessage): void
  on(event: 'message', fn: (m: WorkerMessage) => void): void
  on(event: 'exit', fn: (code: number | null) => void): void
  kill(): void
}

export interface Supervisor {
  /** Starts the worker for the current release (or "no site yet") and resolves once it is listening. */
  start(): Promise<void>
  /** Starts a worker that activates the release, swaps traffic to it once it is ready and resolves with what it did. */
  activate(releaseId: string): Promise<ActivationSummary>
  /** Shuts every worker down, killing those that don't leave within the grace period. */
  stop(): Promise<void>
}

export interface SupervisorDeps {
  fork: (env: Record<string, string>) => WorkerHandle
  log: (id: MessageId, params?: Record<string, string | number>) => void
  now?: () => Date
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  /** Called when even the worker without a site keeps stopping and the supervisor stops respawning. */
  onFatal?: () => void
}

/** A current worker that stops unexpectedly is started again at most this many times within the window. */
export const RESTART_LIMIT = 5
export const RESTART_WINDOW_MS = 10 * 60_000
export const SHUTDOWN_GRACE_MS = 10_000
const FIRST_DELAY_MS = 1000
const MAX_DELAY_MS = 30_000

const noopSummary = (): ActivationSummary => ({
  shipped: { created: 0, replaced: 0, skipped: 0 },
  migrations: [],
  backup: null,
  noop: true,
  warnings: 0,
})

interface Tracked {
  handle: WorkerHandle
  exited: Promise<void>
  hasExited: boolean
  /** Its exit is not a crash: it was told to shut down, or it is an activation worker. */
  expected: boolean
}

type Mode = { kind: 'current'; releaseId: string | null } | { kind: 'noSite'; page: 'empty' | 'unavailable' }

/** A staged release's preview worker: the socket it listens on once ready, and its idle deadline. */
interface Preview {
  tracked: Tracked
  socket: Promise<string>
  idle: unknown
}

/** What a release ID may be when it names a preview's files. */
const RELEASE_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/

/**
 * The primary's side of `inlaycms serve` (spec §8.4): it never opens the database or loads site code. It runs one
 * current worker, swaps to a new one on activation, and respawns a current worker that stops unexpectedly with a
 * growing delay, falling back to the "temporarily unavailable" page when it keeps stopping.
 */
export function createSupervisor(config: HostConfig, deps: SupervisorDeps): Supervisor {
  const now = deps.now ?? (() => new Date())
  const setTimer = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout))
  const workers = new Set<Tracked>()
  let current: Tracked | null = null
  let mode: Mode = { kind: 'current', releaseId: null }
  let crashes: number[] = []
  let respawn: unknown = null
  let stopping = false
  let queue: Promise<unknown> = Promise.resolve()
  let firstReady: { resolve: () => void; reject: (e: unknown) => void } | null = null
  const previews = new Map<string, Preview>()

  function spawn(env: Record<string, string>): Tracked {
    const handle = deps.fork(env)
    let markExited!: () => void
    const tracked: Tracked = { handle, hasExited: false, expected: false, exited: new Promise((r) => (markExited = r)) }
    workers.add(tracked)
    handle.on('exit', (code) => {
      tracked.hasExited = true
      workers.delete(tracked)
      markExited()
      onExit(tracked, code)
    })
    handle.on('message', (m) => onMessage(tracked, m))
    return tracked
  }

  /** Every `INLAY_WORKER_*` variable is set on every fork, empty when unused, so none leaks in from the primary's own environment. */
  function workerEnv(env: {
    release?: string | null
    activate?: boolean
    noSite?: 'empty' | 'unavailable'
    preview?: string
    previewDir?: string
    listen?: string
  }): Record<string, string> {
    return {
      INLAY_WORKER_RELEASE: env.release ?? '',
      INLAY_WORKER_ACTIVATE: env.activate ? '1' : '',
      INLAY_WORKER_NO_SITE: env.noSite ?? '',
      INLAY_WORKER_LISTEN: env.listen ?? '',
      INLAY_WORKER_PREVIEW: env.preview ?? '',
      INLAY_WORKER_PREVIEW_DIR: env.previewDir ?? '',
    }
  }

  function spawnCurrent(): void {
    current = spawn(mode.kind === 'noSite' ? workerEnv({ noSite: mode.page }) : workerEnv({ release: mode.releaseId }))
  }

  function shutdown(tracked: Tracked): Promise<void> {
    if (tracked.hasExited) return tracked.exited
    tracked.expected = true
    tracked.handle.send({ type: 'shutdown' })
    const timer = setTimer(() => {
      if (!tracked.hasExited) tracked.handle.kill()
    }, SHUTDOWN_GRACE_MS)
    void tracked.exited.then(() => clearTimer(timer))
    return tracked.exited
  }

  function onExit(tracked: Tracked, code: number | null): void {
    if (tracked !== current || tracked.expected || stopping) return
    current = null
    const at = now().getTime()
    crashes = crashes.filter((c) => at - c < RESTART_WINDOW_MS)
    crashes.push(at)
    if (crashes.length > RESTART_LIMIT) {
      if (mode.kind === 'noSite') {
        deps.log('host.noSiteFailed')
        firstReady?.reject(new InlayError('config', 'host.noSiteFailed'))
        firstReady = null
        deps.onFatal?.()
        return
      }
      deps.log('host.workerGaveUp')
      // A site that was live is down; a host that never had one still has none.
      mode = { kind: 'noSite', page: mode.releaseId === null ? 'empty' : 'unavailable' }
      crashes = []
      spawnCurrent()
      return
    }
    const delay = Math.min(FIRST_DELAY_MS * 2 ** (crashes.length - 1), MAX_DELAY_MS)
    deps.log('host.workerCrashed', { code: code ?? 'none', seconds: delay / 1000 })
    respawn = setTimer(() => {
      respawn = null
      if (!stopping && current === null) spawnCurrent()
    }, delay)
  }

  function onMessage(tracked: Tracked, m: WorkerMessage): void {
    if (m.type === 'ready' && tracked === current) {
      if (mode.kind === 'current') mode = { kind: 'current', releaseId: m.releaseId }
      firstReady?.resolve()
      firstReady = null
    } else if (m.type === 'activate') {
      const reply = (msg: PrimaryMessage) => {
        if (!tracked.hasExited) tracked.handle.send(msg)
      }
      const { requestId } = m
      // Only the worker serving the site may ask: one being replaced, or an activation worker, may not.
      if (tracked !== current) {
        reply({ type: 'activation', requestId, ok: false, error: toIpcError(new InlayError('invalid_operation', 'error.activationNotCurrent')) })
        return
      }
      enqueue(m.releaseId, (activation) => reply({ type: 'activation', requestId, ok: true, activation })).catch((e: unknown) =>
        reply({ type: 'activation', requestId, ok: false, error: toIpcError(e) }),
      )
    } else if (m.type === 'preview-start') {
      const reply = (msg: PrimaryMessage) => {
        if (!tracked.hasExited) tracked.handle.send(msg)
      }
      const { requestId } = m
      if (tracked !== current || typeof m.releaseId !== 'string' || (m.dir !== undefined && typeof m.dir !== 'string')) {
        reply({ type: 'preview', requestId, ok: false, error: toIpcError(new InlayError('invalid_operation', 'error.previewUnavailable')) })
        return
      }
      startPreview(m.releaseId, m.dir).then(
        (socket) => reply({ type: 'preview', requestId, ok: true, socket }),
        (e: unknown) => reply({ type: 'preview', requestId, ok: false, error: toIpcError(e) }),
      )
    } else if (m.type === 'preview-stop' && tracked === current) {
      stopPreview(m.releaseId)
    } else if (m.type === 'preview-touch' && tracked === current) {
      const preview = previews.get(m.releaseId)
      if (preview) keepAlive(m.releaseId, preview)
    }
  }

  /** Restarts the idle deadline of a preview: it is stopped `PREVIEW_IDLE_MS` after it was last asked for or used. */
  function keepAlive(releaseId: string, preview: Preview): void {
    if (preview.idle !== null) clearTimer(preview.idle)
    preview.idle = setTimer(() => {
      preview.idle = null
      if (previews.get(releaseId) === preview) stopPreview(releaseId)
    }, PREVIEW_IDLE_MS)
  }

  /**
   * The socket of the release's preview worker, started if it isn't running: resolves once it is listening. A
   * request while it starts waits for the same worker. A worker that fails, exits or isn't ready within
   * `PREVIEW_START_TIMEOUT_MS` rejects (and is stopped); one that is idle for `PREVIEW_IDLE_MS` is stopped. The
   * socket is the one the primary chose (`previewSocket`), whatever the worker says; a `preview-ready` for another
   * release is ignored. `dir` is a push's scratch folder holding the release (a dry run).
   */
  function startPreview(releaseId: string, dir?: string): Promise<string> {
    if (stopping) return Promise.reject(new InlayError('invalid_operation', 'error.hostStopping'))
    if (!RELEASE_ID.test(releaseId)) return Promise.reject(new InlayError('not_found', 'error.releaseUnknown', { id: releaseId }))
    if (dir !== undefined && !isScratchDir(config.paths.releases, dir)) {
      return Promise.reject(new InlayError('invalid_operation', 'error.previewUnavailable'))
    }
    const running = previews.get(releaseId)
    if (running) {
      keepAlive(releaseId, running)
      return running.socket
    }
    const socket = previewSocket(config.dataDir, releaseId)
    const tracked = spawn(workerEnv({ preview: releaseId, listen: `socket:${socket}`, ...(dir !== undefined && { previewDir: dir }) }))
    tracked.expected = true
    let settled = false
    const preview: Preview = {
      tracked,
      idle: null,
      socket: new Promise<string>((resolve, reject) => {
        const fail = (error: InlayError) => {
          if (settled) return
          settled = true
          clearTimer(timer)
          stopPreview(releaseId, preview)
          reject(error)
        }
        const timer = setTimer(() => {
          if (!tracked.hasExited) tracked.handle.kill()
          fail(new InlayError('invalid_operation', 'error.previewUnavailable'))
        }, PREVIEW_START_TIMEOUT_MS)
        tracked.handle.on('message', (m) => {
          if (m.type === 'preview-ready' && m.releaseId !== releaseId) {
            deps.log('host.previewMismatch', { id: releaseId, got: m.releaseId })
          } else if (m.type === 'preview-ready' && !settled) {
            settled = true
            clearTimer(timer)
            resolve(socket)
          } else if (m.type === 'failed') {
            // The worker logged why.
            fail(activationError(m.error))
          }
        })
        tracked.handle.on('exit', () => {
          fail(new InlayError('invalid_operation', 'error.previewUnavailable'))
          // A preview that stops after it was ready is forgotten, so the next request starts it again.
          if (previews.get(releaseId) === preview) forget(releaseId, preview)
        })
      }),
    }
    previews.set(releaseId, preview)
    keepAlive(releaseId, preview)
    // Its failure reaches whoever asked; nothing else waits on it.
    preview.socket.catch(() => {})
    return preview.socket
  }

  function forget(releaseId: string, preview: Preview): void {
    previews.delete(releaseId)
    if (preview.idle !== null) clearTimer(preview.idle)
    preview.idle = null
  }

  /** Stops the release's preview worker (`only`: if it is still that one). */
  function stopPreview(releaseId: string, only?: Preview): void {
    const preview = previews.get(releaseId)
    if (!preview || (only && preview !== only)) return
    forget(releaseId, preview)
    void shutdown(preview.tracked)
  }

  /** Previews run on a copy of the database made when they started: after an activation every one is out of date. */
  function stopPreviews(): void {
    for (const releaseId of [...previews.keys()]) stopPreview(releaseId)
  }

  /**
   * Waits for an activation worker: ready, or the failure it reports, or its exit. Once it said `activated`, the
   * release is current whatever happens next, and a failure says so. A worker that is neither ready nor gone after
   * `ACTIVATION_TIMEOUT_MS` is killed, so it can't hold up the activations after it.
   */
  function whenReady(next: Tracked, releaseId: string): Promise<ActivationSummary> {
    return new Promise((resolve, reject) => {
      let activated: ActivationSummary | null = null
      let failure: IpcError | null = null
      let settled = false
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimer(timer)
        fn()
      }
      const failed = (problem: string | null) => {
        if (activated === null) {
          return failure ? activationError(failure) : new InlayError('release', 'error.releaseActivationExited')
        }
        // The old worker keeps serving; whatever starts next reads the database and serves the new release.
        mode = { kind: 'current', releaseId }
        return new InlayError('release', 'error.releaseActivatedNotServing', { problem: problem ?? t('error.releaseWorkerExited') })
      }
      const timer = setTimer(() => {
        settle(() => {
          const error = activated === null
            ? new InlayError('release', 'error.releaseActivationTimeout')
            : failed(t('error.releaseWorkerTimeout'))
          if (!next.hasExited) next.handle.kill()
          reject(error)
        })
      }, ACTIVATION_TIMEOUT_MS)
      next.handle.on('message', (m) => {
        if (m.type === 'activated') activated = m.activation
        else if (m.type === 'ready') settle(() => resolve(m.activation ?? activated ?? noopSummary()))
        else if (m.type === 'failed') {
          failure = m.error
          void shutdown(next)
          settle(() => reject(failed(m.error.message)))
        }
      })
      next.handle.on('exit', () => settle(() => reject(failed(failure?.message ?? null))))
    })
  }

  async function swap(releaseId: string, onSwapped: (activation: ActivationSummary) => void): Promise<ActivationSummary> {
    if (stopping) throw new InlayError('invalid_operation', 'error.hostStopping')
    const next = spawn(workerEnv({ release: releaseId, activate: true }))
    next.expected = true
    const activation = await whenReady(next, releaseId)
    if (stopping) throw new InlayError('invalid_operation', 'error.hostStopping')
    next.expected = false
    const old = current
    current = next
    mode = { kind: 'current', releaseId }
    crashes = []
    if (respawn !== null) {
      clearTimer(respawn)
      respawn = null
    }
    firstReady?.resolve()
    firstReady = null
    stopPreviews()
    onSwapped(activation)
    if (old) void shutdown(old)
    return activation
  }

  /** Activations run one at a time, in the order they were asked for. */
  function enqueue(releaseId: string, onSwapped: (activation: ActivationSummary) => void = () => {}): Promise<ActivationSummary> {
    const run = queue.then(() => swap(releaseId, onSwapped))
    queue = run.catch(() => {})
    return run
  }

  return {
    async start() {
      let releaseId: string | null = null
      try {
        releaseId = (await readCurrentPointer(config.paths.releases))?.id ?? null
      } catch (e) {
        // The worker repairs the pointer from the database.
        deps.log('host.pointerUnreadable', { problem: e instanceof Error ? e.message : String(e) })
      }
      mode = { kind: 'current', releaseId }
      await new Promise<void>((resolve, reject) => {
        firstReady = { resolve, reject }
        spawnCurrent()
      })
    },
    activate: (releaseId) => enqueue(releaseId),
    async stop() {
      stopping = true
      if (respawn !== null) {
        clearTimer(respawn)
        respawn = null
      }
      firstReady?.resolve()
      firstReady = null
      for (const [releaseId, preview] of [...previews]) forget(releaseId, preview)
      await Promise.all([...workers].map(shutdown))
    },
  }
}
