/** A sliding window of failure times per key, with a cap on how many keys it remembers. */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>()
  private readonly max: number
  private readonly windowMs: number
  private readonly maxKeys: number

  constructor(opts: { max: number; windowMs: number; maxKeys?: number }) {
    this.max = opts.max
    this.windowMs = opts.windowMs
    this.maxKeys = opts.maxKeys ?? 10_000
  }

  private recent(key: string, now: number): number[] {
    return (this.failures.get(key) ?? []).filter((at) => at > now - this.windowMs)
  }

  blocked(key: string, now: number): boolean {
    return this.recent(key, now).length >= this.max
  }

  fail(key: string, now: number): void {
    const times = this.recent(key, now)
    times.push(now)
    this.failures.delete(key)
    this.failures.set(key, times)
    while (this.failures.size > this.maxKeys) {
      const oldest = this.failures.keys().next()
      if (oldest.done) break
      this.failures.delete(oldest.value)
    }
  }

  /** Takes back the newest failure for `key`, for an attempt counted up front that turned out fine. */
  refund(key: string): void {
    const times = this.failures.get(key)
    if (times === undefined) return
    times.pop()
    if (times.length === 0) this.failures.delete(key)
  }
}
