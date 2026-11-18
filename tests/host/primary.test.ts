import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InlayError } from '../../src/core/errors.js'
import { t, type MessageId } from '../../src/core/messages/index.js'
import { ensureDataDir, readHostConfig, type HostConfig } from '../../src/host/config.js'
import { PREVIEW_IDLE_MS, previewSocket, type ActivationSummary, type PrimaryMessage, type WorkerMessage } from '../../src/host/ipc.js'
import { createSupervisor, type Supervisor, type WorkerHandle } from '../../src/host/primary.js'
import { sweepLeftovers } from '../../src/host/serve.js'
import { writeCurrentPointer } from '../../src/host/store.js'
import {
  ACTIVATION_TIMEOUT_MS,
  PREVIEW_START_TIMEOUT_MS,
  requestActivation,
  requestPreview,
  stopPreview,
  touchPreview,
  type ActivationChannel,
} from '../../src/host/worker.js'

const summary: ActivationSummary = {
  shipped: { created: 1, replaced: 0, skipped: 0 },
  migrations: ['first-note'],
  backup: null,
  noop: false,
  warnings: 0,
}

/** A worker the test drives: it records what the primary sends and emits what the test tells it to. */
class FakeWorker extends EventEmitter implements WorkerHandle {
  sent: PrimaryMessage[] = []
  killed = false
  exited = false
  constructor(
    readonly id: number,
    readonly env: Record<string, string>,
  ) {
    super()
  }
  send(m: PrimaryMessage): void {
    this.sent.push(m)
  }
  kill(): void {
    this.killed = true
    this.exit(null)
  }
  reply(m: WorkerMessage): void {
    this.emit('message', m)
  }
  exit(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code)
  }
  shutdowns(): number {
    return this.sent.filter((m) => m.type === 'shutdown').length
  }
}

let dataDir: string
let config: HostConfig
let forks: FakeWorker[]
let logs: { id: MessageId; params?: Record<string, string | number> }[]
let timers: { fn: () => void; ms: number; cancelled: boolean }[]
let clock: number
let sup: Supervisor

function supervisor(): Supervisor {
  return createSupervisor(config, {
    fork: (env) => {
      const w = new FakeWorker(forks.length + 1, env)
      forks.push(w)
      return w
    },
    log: (id, params) => logs.push({ id, ...(params && { params }) }),
    now: () => new Date(clock),
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimeout: (handle) => {
      ;(handle as { cancelled: boolean }).cancelled = true
    },
  })
}

const forked = (n: number) => vi.waitFor(() => expect(forks).toHaveLength(n))
const flush = () => new Promise((resolve) => setImmediate(resolve))

/** Runs the timer that was set last (a respawn delay or a shutdown deadline) and returns its delay. */
function fireLast(): number {
  const timer = timers.at(-1)!
  timers.pop()
  if (!timer.cancelled) timer.fn()
  return timer.ms
}

async function started(releaseId: string | null): Promise<FakeWorker> {
  const start = sup.start()
  await forked(1)
  forks[0]!.reply({ type: 'ready', releaseId })
  await start
  return forks[0]!
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'inlay-primary-'))
  config = readHostConfig({ INLAY_DATA_DIR: dataDir, INLAY_BASE_URL: 'https://example.com', INLAY_SECRET: 's'.repeat(32) })
  await ensureDataDir(config)
  forks = []
  logs = []
  timers = []
  clock = Date.UTC(2026, 10, 4, 12)
  sup = supervisor()
})
afterEach(() => rm(dataDir, { recursive: true, force: true }))

describe('createSupervisor', () => {
  it('starts the current worker from the pointer', async () => {
    await writeCurrentPointer(config.paths.releases, { id: 'rel-1', name: 'one', activatedAt: '2026-11-04T00:00:00.000Z' })
    const w = await started('rel-1')
    // Every variable is set, empty when unused, so none leaks in from the primary's environment.
    expect(w.env).toEqual({
      INLAY_WORKER_RELEASE: 'rel-1',
      INLAY_WORKER_ACTIVATE: '',
      INLAY_WORKER_NO_SITE: '',
      INLAY_WORKER_LISTEN: '',
      INLAY_WORKER_PREVIEW: '',
      INLAY_WORKER_PREVIEW_DIR: '',
    })
  })

  it('starts a worker with no release when nothing was activated', async () => {
    const w = await started(null)
    expect(w.env.INLAY_WORKER_RELEASE).toBe('')
  })

  it('activation swaps workers only after the new one is ready and shuts the old one down', async () => {
    const old = await started(null)
    let done = false
    const activation = sup.activate('rel-2').then(() => (done = true))
    await forked(2)
    const next = forks[1]!
    expect(next.env).toMatchObject({ INLAY_WORKER_RELEASE: 'rel-2', INLAY_WORKER_ACTIVATE: '1' })
    await flush()
    expect(done).toBe(false)
    expect(old.shutdowns()).toBe(0)

    next.reply({ type: 'activated', activation: summary })
    next.reply({ type: 'ready', releaseId: 'rel-2', activation: summary })
    await activation
    expect(old.shutdowns()).toBe(1)
    expect(next.shutdowns()).toBe(0)

    // The old worker leaving is expected: nothing is respawned.
    old.exit(0)
    await flush()
    expect(forks).toHaveLength(2)
    expect(timers.filter((t) => !t.cancelled && t.ms < 10_000)).toHaveLength(0)
  })

  it('a failed activation keeps the old worker', async () => {
    const old = await started('rel-1')
    const activation = sup.activate('rel-bad')
    await forked(2)
    forks[1]!.reply({ type: 'failed', error: { code: 'release', message: 'The migration failed.' } })
    forks[1]!.exit(1)
    const e = await activation.then(
      () => null,
      (err: unknown) => err,
    )
    expect(e).toBeInstanceOf(InlayError)
    expect((e as InlayError).code).toBe('release')
    expect((e as InlayError).message).toContain('The migration failed.')
    expect(old.shutdowns()).toBe(0)
    await flush()
    expect(forks).toHaveLength(2)

    // The old worker is still the current one: a later crash of it is respawned.
    old.exit(1)
    await flush()
    expect(fireLast()).toBe(1000)
    await forked(3)
    expect(forks[2]!.env.INLAY_WORKER_RELEASE).toBe('rel-1')
  })

  it('a new worker that exits before it is ready fails the activation', async () => {
    const old = await started(null)
    const activation = sup.activate('rel-2')
    await forked(2)
    forks[1]!.exit(1)
    await expect(activation).rejects.toBeInstanceOf(InlayError)
    expect(old.shutdowns()).toBe(0)
  })

  it('respawns a crashed worker with a limit', async () => {
    await writeCurrentPointer(config.paths.releases, { id: 'rel-1', name: 'one', activatedAt: '2026-11-04T00:00:00.000Z' })
    await started('rel-1')
    const delays: number[] = []
    for (let crash = 1; crash <= 5; crash++) {
      forks.at(-1)!.exit(1)
      await flush()
      expect(forks).toHaveLength(crash)
      delays.push(fireLast())
      await forked(crash + 1)
      expect(forks.at(-1)!.env.INLAY_WORKER_RELEASE).toBe('rel-1')
      clock += 1000
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000])
    expect(logs.filter((l) => l.id === 'host.workerCrashed')).toHaveLength(5)

    // The sixth crash within ten minutes: the primary gives up on the release and serves "temporarily unavailable".
    forks.at(-1)!.exit(1)
    await forked(7)
    expect(forks[6]!.env.INLAY_WORKER_NO_SITE).toBe('unavailable')
    expect(forks[6]!.env.INLAY_WORKER_RELEASE).toBe('')
    expect(logs.map((l) => l.id)).toContain('host.workerGaveUp')
  })

  it('forgets crashes older than ten minutes', async () => {
    await started(null)
    for (let crash = 1; crash <= 5; crash++) {
      forks.at(-1)!.exit(1)
      await flush()
      fireLast()
      await forked(crash + 1)
      clock += 3 * 60_000
    }
    forks.at(-1)!.exit(1)
    await flush()
    // Only the crashes of the last ten minutes count, so this one is respawned with a shorter delay.
    expect(fireLast()).toBeLessThan(16000)
    await forked(7)
    expect(forks[6]!.env.INLAY_WORKER_NO_SITE).toBe('')
    expect(logs.map((l) => l.id)).not.toContain('host.workerGaveUp')
  })

  it('falls back to "no site yet" when a host without a release keeps crashing', async () => {
    await started(null)
    for (let crash = 1; crash <= 5; crash++) {
      forks.at(-1)!.exit(1)
      await flush()
      fireLast()
      await forked(crash + 1)
    }
    forks.at(-1)!.exit(1)
    await forked(7)
    expect(forks[6]!.env.INLAY_WORKER_NO_SITE).toBe('empty')
  })

  it('reports a release made current whose worker then fails as current but not serving', async () => {
    const old = await started('rel-1')
    const activation = sup.activate('rel-2')
    await forked(2)
    forks[1]!.reply({ type: 'activated', activation: summary })
    forks[1]!.reply({ type: 'failed', error: { code: 'release', message: 'Port in use.' } })
    forks[1]!.exit(1)
    const e = await activation.then(
      () => null,
      (err: unknown) => err as InlayError,
    )
    expect(e?.messageId).toBe('error.releaseActivatedNotServing')
    expect(e?.message).toContain('Port in use.')
    expect(old.shutdowns()).toBe(0)

    // A worker that leaves after `activated` without a word is reported the same way.
    const exited = sup.activate('rel-3')
    await forked(3)
    forks[2]!.reply({ type: 'activated', activation: summary })
    forks[2]!.exit(1)
    await expect(exited).rejects.toMatchObject({ messageId: 'error.releaseActivatedNotServing' })
  })

  it('kills an activation worker that hangs, so later activations still run', async () => {
    const old = await started('rel-1')
    const hung = sup.activate('rel-2')
    await forked(2)
    const deadline = timers.find((t) => t.ms === ACTIVATION_TIMEOUT_MS && !t.cancelled)!
    expect(deadline).toBeDefined()
    deadline.fn()
    await expect(hung).rejects.toMatchObject({ messageId: 'error.releaseActivationTimeout' })
    expect(forks[1]!.killed).toBe(true)
    expect(old.shutdowns()).toBe(0)

    const next = sup.activate('rel-3')
    await forked(3)
    forks[2]!.reply({ type: 'ready', releaseId: 'rel-3', activation: summary })
    expect(await next).toEqual(summary)
    expect(old.shutdowns()).toBe(1)
  })

  it('reports a worker that hangs after activating as current but not serving', async () => {
    const old = await started('rel-1')
    const hung = sup.activate('rel-2')
    await forked(2)
    forks[1]!.reply({ type: 'activated', activation: summary })
    timers.find((t) => t.ms === ACTIVATION_TIMEOUT_MS && !t.cancelled)!.fn()
    const e = await hung.then(
      () => null,
      (err: unknown) => err as InlayError,
    )
    expect(e?.messageId).toBe('error.releaseActivatedNotServing')
    expect(e?.params).toEqual({ problem: t('error.releaseWorkerTimeout') })
    expect(forks[1]!.killed).toBe(true)
    expect(old.shutdowns()).toBe(0)
    // The release is current now: the old worker, should it crash, is replaced by one for the new release.
    old.exit(1)
    await flush()
    fireLast()
    await forked(3)
    expect(forks[2]!.env.INLAY_WORKER_RELEASE).toBe('rel-2')
  })

  it('a deadline is cancelled once the worker is ready', async () => {
    await started('rel-1')
    const activation = sup.activate('rel-2')
    await forked(2)
    forks[1]!.reply({ type: 'ready', releaseId: 'rel-2', activation: summary })
    await activation
    expect(timers.filter((t) => t.ms === ACTIVATION_TIMEOUT_MS).every((t) => t.cancelled)).toBe(true)
  })

  it("passes an activation's own error through", async () => {
    await started('rel-1')
    const activation = sup.activate('rel-bad')
    await forked(2)
    const error = { code: 'release', message: 'x', messageId: 'error.releaseSecret', params: { name: 'HOOK' } }
    forks[1]!.reply({ type: 'failed', error })
    forks[1]!.exit(1)
    const e = await activation.then(
      () => null,
      (err: unknown) => err as InlayError,
    )
    expect(e?.messageId).toBe('error.releaseSecret')
    expect(e?.message).toBe(new InlayError('release', 'error.releaseSecret', { name: 'HOOK' }).message)
  })

  it('answers an activate request only from the current worker', async () => {
    const old = await started('rel-1')
    sup.activate('rel-2').catch(() => null)
    await forked(2)
    // The activation worker isn't serving yet: it may not ask.
    forks[1]!.reply({ type: 'activate', requestId: 'req-x', releaseId: 'rel-3' })
    expect(forks[1]!.sent).toContainEqual({
      type: 'activation',
      requestId: 'req-x',
      ok: false,
      error: expect.objectContaining({ messageId: 'error.activationNotCurrent' }),
    })
    forks[1]!.reply({ type: 'ready', releaseId: 'rel-2', activation: summary })
    await vi.waitFor(() => expect(old.shutdowns()).toBe(1))
    // Nor may the worker being replaced.
    old.reply({ type: 'activate', requestId: 'req-y', releaseId: 'rel-3' })
    expect(old.sent).toContainEqual(expect.objectContaining({ requestId: 'req-y', ok: false }))
    await flush()
    expect(forks).toHaveLength(2)
  })

  it('a worker activate request is answered with what the activation did', async () => {
    const old = await started('rel-1')
    old.reply({ type: 'activate', requestId: 'req-1', releaseId: 'rel-2' })
    await forked(2)
    forks[1]!.reply({ type: 'activated', activation: summary })
    forks[1]!.reply({ type: 'ready', releaseId: 'rel-2', activation: summary })
    await vi.waitFor(() =>
      expect(old.sent).toContainEqual({ type: 'activation', requestId: 'req-1', ok: true, activation: summary }),
    )
    // The answer reaches the requesting worker before it is told to shut down.
    expect(old.sent.findIndex((m) => m.type === 'activation')).toBeLessThan(old.sent.findIndex((m) => m.type === 'shutdown'))

    const current = forks[1]!
    current.reply({ type: 'activate', requestId: 'req-2', releaseId: 'rel-bad' })
    await forked(3)
    forks[2]!.reply({ type: 'failed', error: { code: 'release', message: 'Nope.' } })
    forks[2]!.exit(1)
    await vi.waitFor(() =>
      expect(current.sent).toContainEqual({
        type: 'activation',
        requestId: 'req-2',
        ok: false,
        error: expect.objectContaining({ code: 'release' }),
      }),
    )
  })

  /** Asks for the preview of `releaseId` from `from` and, when `ready`, has the preview worker forked for it listen. */
  async function previewOf(from: FakeWorker, releaseId: string, requestId: string): Promise<FakeWorker> {
    const before = forks.length
    from.reply({ type: 'preview-start', requestId, releaseId })
    await forked(before + 1)
    const worker = forks.at(-1)!
    worker.reply({ type: 'preview-ready', releaseId, socket: `/run/${releaseId}.sock` })
    await flush()
    return worker
  }

  const idleTimers = () => timers.filter((t) => t.ms === PREVIEW_IDLE_MS && !t.cancelled)

  it('starts a preview worker on request and answers with its socket; requests meanwhile wait for the same one', async () => {
    const current = await started('rel-1')
    current.reply({ type: 'preview-start', requestId: 'a', releaseId: 'rel-2' })
    current.reply({ type: 'preview-start', requestId: 'b', releaseId: 'rel-2' })
    await forked(2)
    await flush()
    expect(forks).toHaveLength(2)
    const preview = forks[1]!
    const socket = previewSocket(dataDir, 'rel-2')
    expect(socket).toMatch(/[\\/]run[\\/]p-[0-9a-f]{12}\.sock$/)
    expect(preview.env).toEqual({
      INLAY_WORKER_RELEASE: '',
      INLAY_WORKER_ACTIVATE: '',
      INLAY_WORKER_NO_SITE: '',
      INLAY_WORKER_LISTEN: `socket:${socket}`,
      INLAY_WORKER_PREVIEW: 'rel-2',
      INLAY_WORKER_PREVIEW_DIR: '',
    })
    expect(current.sent).toEqual([])
    // The socket the primary chose is the answer, whatever the worker says.
    preview.reply({ type: 'preview-ready', releaseId: 'rel-2', socket: '/elsewhere.sock' })
    await flush()
    expect(current.sent).toEqual([
      { type: 'preview', requestId: 'a', ok: true, socket },
      { type: 'preview', requestId: 'b', ok: true, socket },
    ])

    // Once running, a request is answered at once.
    current.reply({ type: 'preview-start', requestId: 'c', releaseId: 'rel-2' })
    await flush()
    expect(forks).toHaveLength(2)
    expect(current.sent.at(-1)).toEqual({ type: 'preview', requestId: 'c', ok: true, socket })

    // A preview worker that stops is not respawned as the current one, and the next request starts another.
    preview.exit(1)
    await flush()
    expect(forks).toHaveLength(2)
    await previewOf(current, 'rel-2', 'd')
    expect(forks).toHaveLength(3)
    expect(current.sent.at(-1)).toEqual({ type: 'preview', requestId: 'd', ok: true, socket })
  })

  it('ignores a preview-ready for another release, and logs it', async () => {
    const current = await started('rel-1')
    current.reply({ type: 'preview-start', requestId: 'a', releaseId: 'rel-2' })
    await forked(2)
    forks[1]!.reply({ type: 'preview-ready', releaseId: 'rel-3', socket: '/run/rel-3.sock' })
    await flush()
    expect(current.sent).toEqual([])
    expect(logs).toContainEqual({ id: 'host.previewMismatch', params: { id: 'rel-2', got: 'rel-3' } })
    forks[1]!.reply({ type: 'preview-ready', releaseId: 'rel-2', socket: '/run/rel-2.sock' })
    await flush()
    expect(current.sent).toEqual([{ type: 'preview', requestId: 'a', ok: true, socket: previewSocket(dataDir, 'rel-2') }])
  })

  it("starts a dry run's preview from a push scratch folder, and only from one", async () => {
    const current = await started('rel-1')
    const dir = join(config.paths.releases, '.push-abc123')
    current.reply({ type: 'preview-start', requestId: 'a', releaseId: 'rel-9', dir })
    await forked(2)
    expect(forks[1]!.env).toMatchObject({ INLAY_WORKER_PREVIEW: 'rel-9', INLAY_WORKER_PREVIEW_DIR: dir })

    for (const bad of [join(dataDir, '.push-abc123'), join(config.paths.releases, 'rel-1'), join(config.paths.releases, '.push-x', '..', '..')]) {
      current.reply({ type: 'preview-start', requestId: 'b', releaseId: 'rel-8', dir: bad })
      await flush()
      expect(current.sent.at(-1)).toEqual({ type: 'preview', requestId: 'b', ok: false, error: expect.objectContaining({ messageId: 'error.previewUnavailable' }) })
    }
    expect(forks).toHaveLength(2)
  })

  it('refuses a preview-start whose folder or release is not a string', async () => {
    const current = await started('rel-1')
    for (const bad of [{ releaseId: 'rel-8', dir: 42 }, { releaseId: 'rel-8', dir: { path: '/x' } }, { releaseId: 7 }]) {
      current.reply({ type: 'preview-start', requestId: 'b', ...bad } as never)
      await flush()
      expect(current.sent.at(-1)).toEqual({ type: 'preview', requestId: 'b', ok: false, error: expect.objectContaining({ messageId: 'error.previewUnavailable' }) })
    }
    expect(forks).toHaveLength(1)
  })

  it("passes a preview worker's failure on", async () => {
    const current = await started('rel-1')
    current.reply({ type: 'preview-start', requestId: 'a', releaseId: 'rel-2' })
    await forked(2)
    const error = {
      code: 'invalid_operation',
      message: t('error.previewNotStaged', { name: 'two' }),
      messageId: 'error.previewNotStaged',
      params: { name: 'two' },
    }
    forks[1]!.reply({ type: 'failed', error })
    await flush()
    expect(current.sent).toEqual([{ type: 'preview', requestId: 'a', ok: false, error: expect.objectContaining({ messageId: 'error.previewNotStaged' }) }])
    expect(forks[1]!.shutdowns()).toBe(1)
    forks[1]!.exit(1)

    // One that exits before it is ready.
    current.reply({ type: 'preview-start', requestId: 'b', releaseId: 'rel-2' })
    await forked(3)
    forks[2]!.exit(1)
    await flush()
    expect(current.sent.at(-1)).toEqual({ type: 'preview', requestId: 'b', ok: false, error: expect.objectContaining({ messageId: 'error.previewUnavailable' }) })

    // One that doesn't start within a minute is killed.
    current.reply({ type: 'preview-start', requestId: 'c', releaseId: 'rel-2' })
    await forked(4)
    timers.find((t) => t.ms === 60_000 && !t.cancelled)!.fn()
    await flush()
    expect(forks[3]!.killed).toBe(true)
    expect(current.sent.at(-1)).toMatchObject({ type: 'preview', requestId: 'c', ok: false })
    expect(forks).toHaveLength(4)
  })

  it('refuses preview requests from a worker that is not the current one, and a release ID that is not one', async () => {
    const old = await started('rel-1')
    const activation = sup.activate('rel-2').catch(() => null)
    await forked(2)
    forks[1]!.reply({ type: 'preview-start', requestId: 'a', releaseId: 'rel-3' })
    expect(forks[1]!.sent).toContainEqual({
      type: 'preview',
      requestId: 'a',
      ok: false,
      error: expect.objectContaining({ messageId: 'error.previewUnavailable' }),
    })
    old.reply({ type: 'preview-start', requestId: 'b', releaseId: '../etc' })
    await flush()
    expect(old.sent).toContainEqual({ type: 'preview', requestId: 'b', ok: false, error: expect.objectContaining({ messageId: 'error.releaseUnknown' }) })
    expect(forks).toHaveLength(2)
    forks[1]!.exit(1)
    await activation
  })

  it('stops a preview worker when asked, after ten idle minutes, and when a release is activated', async () => {
    const current = await started('rel-1')
    const first = await previewOf(current, 'rel-2', 'a')
    current.reply({ type: 'preview-stop', releaseId: 'rel-2' })
    expect(first.shutdowns()).toBe(1)
    first.exit(0)
    expect(idleTimers()).toHaveLength(0)

    const second = await previewOf(current, 'rel-3', 'b')
    const deadline = idleTimers()
    expect(deadline).toHaveLength(1)
    // Use restarts the deadline.
    current.reply({ type: 'preview-touch', releaseId: 'rel-3' })
    current.reply({ type: 'preview-start', requestId: 'c', releaseId: 'rel-3' })
    await flush()
    expect(deadline[0]!.cancelled).toBe(true)
    expect(idleTimers()).toHaveLength(1)
    expect(second.shutdowns()).toBe(0)
    const idle = idleTimers()[0]!
    idle.cancelled = true
    idle.fn()
    expect(second.shutdowns()).toBe(1)
    second.exit(0)

    // An activation stops the previews before it forks its worker, and waits for them to leave.
    const third = await previewOf(current, 'rel-4', 'd')
    const activation = sup.activate('rel-5')
    await vi.waitFor(() => expect(third.shutdowns()).toBe(1))
    await flush()
    expect(forks).toHaveLength(4)
    third.exit(0)
    await forked(5)
    forks[4]!.reply({ type: 'ready', releaseId: 'rel-5', activation: summary })
    await activation
    expect(idleTimers()).toHaveLength(0)
  })

  it('stops a preview started during an activation once the release is live', async () => {
    const current = await started('rel-1')
    const activation = sup.activate('rel-2')
    await forked(2)
    const during = await previewOf(current, 'rel-3', 'a')
    expect(during.shutdowns()).toBe(0)
    forks[1]!.reply({ type: 'ready', releaseId: 'rel-2', activation: summary })
    await activation
    expect(during.shutdowns()).toBe(1)
  })

  it('a preview that does not leave holds the activation up only for the shutdown grace period', async () => {
    const current = await started('rel-1')
    const preview = await previewOf(current, 'rel-2', 'a')
    const activation = sup.activate('rel-3')
    await vi.waitFor(() => expect(preview.shutdowns()).toBe(1))
    expect(fireLast()).toBe(10_000)
    expect(preview.killed).toBe(true)
    await forked(3)
    forks[2]!.reply({ type: 'ready', releaseId: 'rel-3', activation: summary })
    await activation
  })

  it('stop shuts every worker down', async () => {
    const old = await started(null)
    const activation = sup.activate('rel-2').catch(() => null)
    await forked(2)
    const stopping = sup.stop()
    await flush()
    expect(old.shutdowns()).toBe(1)
    expect(forks[1]!.shutdowns()).toBe(1)
    old.exit(0)
    // The new worker doesn't leave in time and is killed.
    await vi.waitFor(() => expect(timers.some((t) => t.ms === 10_000 && !t.cancelled)).toBe(true))
    for (const t of timers.filter((t) => t.ms === 10_000 && !t.cancelled)) t.fn()
    await stopping
    expect(old.killed).toBe(false)
    expect(forks[1]!.killed).toBe(true)
    await activation
    // Nothing is respawned after stop.
    await flush()
    expect(forks).toHaveLength(2)
  })
})

describe('sweepLeftovers', () => {
  it('removes half-received pushes and everything previews left in run/, and nothing else', async () => {
    const { releases } = config.paths
    await mkdir(join(releases, '.upload-a1'), { recursive: true })
    await writeFile(join(releases, '.upload-a1', 'release.tgz'), 'x')
    await mkdir(join(releases, '.push-b2', 'rel'), { recursive: true })
    await mkdir(join(releases, 'rel-1'), { recursive: true })
    await writeFile(join(releases, 'rel-1.tgz'), 'x')
    await writeFile(join(releases, 'current.json'), '{}')
    await mkdir(join(dataDir, 'run', 'preview-rel-2', 'media'), { recursive: true })
    await writeFile(join(dataDir, 'run', 'p-0123456789ab.sock'), '')
    await sweepLeftovers(config)
    expect((await readdir(releases)).sort()).toEqual(['current.json', 'rel-1', 'rel-1.tgz'])
    expect(await readdir(join(dataDir, 'run'))).toEqual([])
    // Nothing to sweep is fine too.
    await rm(join(dataDir, 'run'), { recursive: true })
    await sweepLeftovers(config)
  })
})

describe('requestActivation', () => {
  function channel(isWorker = true) {
    const sent: WorkerMessage[] = []
    let listener: ((m: unknown) => void) | null = null
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
    const ch: ActivationChannel = {
      isWorker,
      send: (m) => sent.push(m),
      onMessage: (fn) => {
        listener = fn
        return () => {
          listener = null
        }
      },
      setTimeout: (fn, ms) => {
        const timer = { fn, ms, cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimeout: (handle) => {
        ;(handle as { cleared: boolean }).cleared = true
      },
    }
    return { ch, sent, timers, deliver: (m: unknown) => listener?.(m), listening: () => listener !== null }
  }

  it('refuses outside a worker of inlaycms serve', async () => {
    const { ch, sent } = channel(false)
    await expect(requestActivation('rel-2', ch)).rejects.toMatchObject({ messageId: 'error.hostNoPrimary' })
    expect(sent).toEqual([])
    // This test process isn't a cluster worker either.
    await expect(requestActivation('rel-2')).rejects.toMatchObject({ messageId: 'error.hostNoPrimary' })
  })

  it('resolves with the summary the primary forwards, and rejects with its error', async () => {
    const { ch, sent, timers, deliver, listening } = channel()
    const ok = requestActivation('rel-2', ch)
    const request = sent[0] as Extract<WorkerMessage, { type: 'activate' }>
    expect(request).toMatchObject({ type: 'activate', releaseId: 'rel-2' })
    deliver({ type: 'activation', requestId: 'someone-else', ok: true, activation: summary })
    deliver({ type: 'activation', requestId: request.requestId, ok: true, activation: summary })
    expect(await ok).toEqual(summary)
    expect(listening()).toBe(false)
    expect(timers[0]!.cleared).toBe(true)

    const bad = requestActivation('rel-3', ch)
    const second = sent[1] as Extract<WorkerMessage, { type: 'activate' }>
    deliver({ type: 'activation', requestId: second.requestId, ok: false, error: { code: 'release', message: 'Nope.' } })
    await expect(bad).rejects.toThrow('Nope.')
  })

  it('gives up after ten minutes', async () => {
    const { ch, timers, listening } = channel()
    const pending = requestActivation('rel-2', ch)
    expect(timers[0]!.ms).toBe(ACTIVATION_TIMEOUT_MS)
    expect(ACTIVATION_TIMEOUT_MS).toBe(10 * 60_000)
    timers[0]!.fn()
    await expect(pending).rejects.toMatchObject({ messageId: 'error.activationTimeout' })
    expect(listening()).toBe(false)
  })
})

describe('requestPreview', () => {
  function channel(isWorker = true) {
    const sent: WorkerMessage[] = []
    let listener: ((m: unknown) => void) | null = null
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
    const ch: ActivationChannel = {
      isWorker,
      send: (m) => sent.push(m),
      onMessage: (fn) => {
        listener = fn
        return () => {
          listener = null
        }
      },
      setTimeout: (fn, ms) => {
        const timer = { fn, ms, cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimeout: (handle) => {
        ;(handle as { cleared: boolean }).cleared = true
      },
    }
    return { ch, sent, timers, deliver: (m: unknown) => listener?.(m), listening: () => listener !== null }
  }

  it('resolves with the socket the primary names, and rejects with its error', async () => {
    const { ch, sent, timers, deliver, listening } = channel()
    const ok = requestPreview('rel-2', ch)
    const request = sent[0] as Extract<WorkerMessage, { type: 'preview-start' }>
    expect(request).toMatchObject({ type: 'preview-start', releaseId: 'rel-2' })
    deliver({ type: 'preview', requestId: 'someone-else', ok: true, socket: '/nope.sock' })
    deliver({ type: 'preview', requestId: request.requestId, ok: true, socket: '/run/preview.sock' })
    expect(await ok).toBe('/run/preview.sock')
    expect(listening()).toBe(false)
    expect(timers[0]!.cleared).toBe(true)

    const bad = requestPreview('rel-3', ch)
    const second = sent[1] as Extract<WorkerMessage, { type: 'preview-start' }>
    const error = { code: 'invalid_operation', message: t('error.previewUnavailable'), messageId: 'error.previewUnavailable' }
    deliver({ type: 'preview', requestId: second.requestId, ok: false, error })
    await expect(bad).rejects.toMatchObject({ messageId: 'error.previewUnavailable' })

    // A dry run's preview names the scratch folder its release is in.
    void requestPreview('rel-4', ch, { dir: '/data/releases/.push-x' }).catch(() => {})
    expect(sent[2]).toMatchObject({ type: 'preview-start', releaseId: 'rel-4', dir: '/data/releases/.push-x' })
    expect(sent[1]).not.toHaveProperty('dir')
  })

  it('gives up after a minute, and refuses outside a worker of inlaycms serve', async () => {
    const { ch, timers, listening } = channel()
    const pending = requestPreview('rel-2', ch)
    expect(timers[0]!.ms).toBe(PREVIEW_START_TIMEOUT_MS)
    timers[0]!.fn()
    await expect(pending).rejects.toMatchObject({ messageId: 'error.previewUnavailable' })
    expect(listening()).toBe(false)
    await expect(requestPreview('rel-2', channel(false).ch)).rejects.toMatchObject({ messageId: 'error.hostNoPrimary' })
  })

  it('stopPreview tells the primary inside a worker only', async () => {
    const inside = channel()
    await stopPreview('rel-2', inside.ch)
    expect(inside.sent).toEqual([{ type: 'preview-stop', releaseId: 'rel-2' }])
    const outside = channel(false)
    await stopPreview('rel-2', outside.ch)
    expect(outside.sent).toEqual([])
  })

  it('touchPreview tells the primary inside a worker only', () => {
    const inside = channel()
    touchPreview('rel-2', inside.ch)
    expect(inside.sent).toEqual([{ type: 'preview-touch', releaseId: 'rel-2' }])
    const outside = channel(false)
    touchPreview('rel-2', outside.ch)
    expect(outside.sent).toEqual([])
  })
})
