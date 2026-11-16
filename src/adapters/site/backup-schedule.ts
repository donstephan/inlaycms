export interface BackupSchedule {
  stop(): Promise<void>
}

/** Runs `run` now and then every `intervalMs`, skipping a tick while one is still running. */
export function startBackupSchedule(
  run: () => Promise<unknown>,
  opts: { intervalMs: number; onError(e: unknown): void },
): BackupSchedule {
  let inFlight: Promise<void> | null = null
  let stopped = false
  const tick = () => {
    if (stopped || inFlight) return
    const current: Promise<void> = (async () => {
      try {
        await run()
      } catch (e) {
        opts.onError(e)
      }
    })().finally(() => {
      if (inFlight === current) inFlight = null
    })
    inFlight = current
  }
  tick()
  const timer = setInterval(tick, opts.intervalMs)
  timer.unref()
  return {
    async stop() {
      stopped = true
      clearInterval(timer)
      await inFlight
    },
  }
}
