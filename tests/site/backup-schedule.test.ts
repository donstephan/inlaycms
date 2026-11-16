import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { inlay } from '../../src/adapters/site/plugin.js'
import { startBackupSchedule } from '../../src/adapters/site/backup-schedule.js'
import { listBackups } from '../../src/core/backup/backup.js'
import { InlayError } from '../../src/core/errors.js'
import { appOptions } from '../helpers/app.js'

async function dirs() {
  const root = await mkdtemp(join(tmpdir(), 'inlay-sched-'))
  return { db: join(root, 'inlay.db'), backups: join(root, 'backups') }
}

async function start(d: { db: string; backups: string }, backupSchedule: { keep?: number } | false, now?: () => Date) {
  const app = Fastify()
  await app.register(inlay, await appOptions({ db: d.db, backups: d.backups, backupSchedule, ...(now && { now }) }))
  await app.ready()
  return app
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('scheduled backups in the plugin', () => {
  it('makes one on first start, and none on a restart within 24 hours', async () => {
    const d = await dirs()
    const a = await start(d, {})
    await vi.waitFor(async () => expect(await listBackups(d.backups)).toHaveLength(1))
    expect((await listBackups(d.backups))[0]?.reason).toBe('scheduled')
    await a.close()
    const b = await start(d, {})
    await new Promise((r) => setTimeout(r, 200))
    expect(await listBackups(d.backups)).toHaveLength(1)
    await b.close()
  })

  it('refuses a keep that is not a whole number of at least 1', async () => {
    const d = await dirs()
    for (const keep of [0, -1, 1.5, Number.NaN, '3' as unknown as number]) {
      const app = Fastify()
      const err = await app.register(inlay, await appOptions({ db: d.db, backups: d.backups, backupSchedule: { keep } })).ready().then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(InlayError)
      expect((err as InlayError).messageId).toBe('config.backupKeep')
      await app.close()
    }
    expect(await listBackups(d.backups)).toHaveLength(0)
  })

  it('does nothing when turned off', async () => {
    const d = await dirs()
    const app = await start(d, false)
    await new Promise((r) => setTimeout(r, 100))
    expect(await listBackups(d.backups)).toHaveLength(0)
    await app.close()
  })
})

describe('startBackupSchedule', () => {
  it('close waits for an in-flight run', async () => {
    const gate = deferred()
    let settled = false
    const run = vi.fn(async () => {
      await gate.promise
      settled = true
    })
    const s = startBackupSchedule(run, { intervalMs: 1_000_000, onError: () => {} })
    expect(run).toHaveBeenCalledTimes(1)
    let stopped = false
    const p = s.stop().then(() => (stopped = true))
    await new Promise((r) => setTimeout(r, 30))
    expect(stopped).toBe(false)
    gate.resolve()
    await p
    expect(settled).toBe(true)
  })

  it('app.close waits for a slow run and logs no database error', async () => {
    const d = await dirs()
    const errors: string[] = []
    const app = Fastify({
      logger: { level: 'error', stream: { write: (m: string) => void errors.push(m) } },
    })
    await app.register(inlay, await appOptions({ db: d.db, backups: d.backups, backupSchedule: {} }))
    const { core } = app.inlay
    const real = core.scheduledBackup.bind(core)
    const started = deferred()
    let finished = false
    vi.spyOn(core, 'scheduledBackup').mockImplementation(async (keep) => {
      started.resolve()
      await new Promise((r) => setTimeout(r, 150))
      const made = await real(keep)
      finished = true
      return made
    })
    await app.ready()
    await started.promise
    await app.close()
    expect(finished).toBe(true)
    expect(errors).toEqual([])
    expect((await listBackups(d.backups)).map((b) => b.reason)).toEqual(['scheduled'])
  })

  it('reports failures and keeps ticking, skipping while in flight', async () => {
    vi.useFakeTimers()
    try {
      const onError = vi.fn()
      const gate = deferred()
      let calls = 0
      const run = vi.fn(async () => {
        calls++
        if (calls === 1) throw new Error('boom')
        if (calls === 3) await gate.promise
      })
      const s = startBackupSchedule(run, { intervalMs: 1000, onError })
      await vi.advanceTimersByTimeAsync(0)
      expect(onError).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(run).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1000)
      expect(run).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(3000)
      expect(run).toHaveBeenCalledTimes(3)
      gate.resolve()
      await s.stop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(run).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
