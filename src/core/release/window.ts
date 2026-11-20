import { inlayVersion, NEXT_OLDEST_RELEASE, OLDEST_RELEASE } from '../version.js'

export interface ReleaseWindow {
  version: string
  oldest: string
  nextOldest: string | null
}

export type ReleaseFit = 'ok' | 'warn' | 'tooOld' | 'tooNew'

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/

function parts(version: string): [number, number, number] | null {
  const m = VERSION.exec(version)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

export function runningWindow(): ReleaseWindow {
  return { version: inlayVersion(), oldest: OLDEST_RELEASE, nextOldest: NEXT_OLDEST_RELEASE }
}

/** Whether a release packed with `packed` runs in `window`: packed with the oldest version or later, and not a newer minor than the host. */
export function releaseFit(packed: string, window: ReleaseWindow = runningWindow()): ReleaseFit {
  const have = parts(packed)
  if (!have) return 'tooOld'
  const host = parts(window.version)
  const oldest = parts(window.oldest)
  if (!host || !oldest) return 'tooOld'
  if (have[0] > host[0] || (have[0] === host[0] && have[1] > host[1])) return 'tooNew'
  if (compare(have, oldest) < 0) return 'tooOld'
  const next = window.nextOldest === null ? null : parts(window.nextOldest)
  if (next && compare(have, next) < 0) return 'warn'
  return 'ok'
}

/** A stored release's `inlay_range` without its leading caret. */
export function packedVersion(range: string): string {
  return range.startsWith('^') ? range.slice(1) : range
}
