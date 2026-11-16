import { rm } from 'node:fs/promises'
import { listBackups, type BackupInfo, type BackupReason } from './backup.js'

export const SCHEDULE_INTERVAL_MS = 3_600_000
export const DEFAULT_KEEP = 14
const DAY_MS = 86_400_000

/** True when no scheduled backup was made in the 24 hours before `now`. */
export function scheduledBackupDue(backups: BackupInfo[], now: Date): boolean {
  const cutoff = now.getTime() - DAY_MS
  return !backups.some((b) => b.reason === 'scheduled' && Date.parse(b.createdAt) > cutoff)
}

/** True when something was published after the newest backup of any kind (`backups` is newest first). */
export function publishBackupDue(backups: BackupInfo[], lastPublishAt: string | null): boolean {
  if (lastPublishAt === null) return false
  const newest = backups[0]
  return newest === undefined || lastPublishAt > newest.createdAt
}

const PRUNED: readonly BackupReason[] = ['scheduled', 'post-publish']

/**
 * Removes scheduled and post-publish backups beyond the newest `keep` of each; other backups are never touched.
 * Returns what was removed.
 */
export async function pruneBackups(dir: string, keep: number): Promise<BackupInfo[]> {
  const all = await listBackups(dir)
  const old = PRUNED.flatMap((reason) => all.filter((b) => b.reason === reason).slice(Math.max(0, keep)))
  for (const b of old) await rm(b.path, { force: true })
  return old
}
