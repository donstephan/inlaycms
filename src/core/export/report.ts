import { t } from '../messages/index.js'
import type { CheckProblem } from '../report.js'
import type { SiteLockRow } from '../site-lock/site-lock.js'

export type ImportTypeStatus = 'compatible' | 'hidden'

/**
 * One content type of the export: `current` is its name in the code, or null when the site doesn't
 * have it (its content is kept, hidden). `gaps`: documents that will need attention once imported.
 */
export interface ImportTypeReport {
  type: string
  current: string | null
  label: string
  documents: number
  status: ImportTypeStatus
  gaps: number
}

export interface ImportLocaleReport {
  locale: string
  documents: number
  status: 'compatible' | 'hidden'
}

export type SiteLockEffect = 'on' | 'off' | 'set' | 'changed' | 'removed'

/** The lock an export carries; `effects` is what importing it does to the receiving site, or null when that site isn't known. */
export interface ImportSiteLock {
  enabled: boolean
  hasPassword: boolean
  effects: SiteLockEffect[] | null
}

/** What restoring an export would do, from a dry run. */
export interface ImportReport {
  /** No problems: the import would go ahead. */
  ok: boolean
  exportedAt: string
  inlayVersion: string
  types: ImportTypeReport[]
  locales: ImportLocaleReport[]
  /** Problems bringing the site up to date on top of the export; any of them blocks the import. */
  general: CheckProblem[]
  /** `files`: the media files that can be restored. `damaged`: filenames of the ones that can't, which the import leaves out. */
  media: { files: number; damaged: string[] }
  redirects: { count: number }
  /** Titles of the shipped content the import would create or replace. */
  shipped: string[]
  /** The export's lock, or null for an export made before the lock existed (the import leaves the lock alone). */
  siteLock: ImportSiteLock | null
  /** The integrations the export carries, or null for an export made before they existed (the import leaves them alone). */
  integrations: Array<{ name: string; enabled: boolean }> | null
}

/** What replacing the lock `current` with `exported` changes. */
export function siteLockEffects(exported: SiteLockRow, current: SiteLockRow): SiteLockEffect[] {
  const effects: SiteLockEffect[] = []
  if (exported.enabled && !current.enabled) effects.push('on')
  if (!exported.enabled && current.enabled) effects.push('off')
  if (exported.passwordHash !== null && current.passwordHash === null) effects.push('set')
  if (exported.passwordHash !== null && current.passwordHash !== null && exported.passwordHash !== current.passwordHash) effects.push('changed')
  if (exported.passwordHash === null && current.passwordHash !== null) effects.push('removed')
  return effects
}

export function siteLockLines(lock: ImportSiteLock | null): string[] {
  if (!lock) return []
  if (lock.effects) return lock.effects.map((effect) => t(`import.siteLock.${effect}`))
  const lines = [t(lock.enabled ? 'import.siteLock.exportOn' : 'import.siteLock.exportOff')]
  if (!lock.hasPassword) lines.push(t('import.siteLock.exportNoPassword'))
  return lines
}

export function integrationLines(report: ImportReport): string[] {
  if (!report.integrations) return []
  const list = report.integrations.map((i) => t(i.enabled ? 'import.integrations.on' : 'import.integrations.off', { name: i.name })).join(', ')
  return [t('import.integrations.replace', { list })]
}

/** The report as lines a person reads: one per type and locale, with the documents needing attention indented, then everything else. */
export function formatImportReport(report: ImportReport): string[] {
  const lines: string[] = []
  for (const row of report.types) {
    lines.push(t('import.typeLine', { label: row.label, status: t(`import.status.${row.status}`), documents: row.documents }))
    if (row.gaps > 0) lines.push(t('import.gaps', { count: row.gaps }))
  }
  for (const row of report.locales) {
    lines.push(t('import.localeLine', { locale: row.locale, status: t(`import.status.${row.status}`), documents: row.documents }))
  }
  for (const problem of report.general) {
    lines.push(t('import.general', { message: problem.message }))
    for (const issue of problem.issues ?? []) lines.push(t('import.issue', { message: issue.message }))
  }
  if (report.media.damaged.length > 0) {
    lines.push(t('import.damagedMedia', { count: report.media.damaged.length, names: report.media.damaged.join(', ') }))
  }
  if (report.shipped.length > 0) lines.push(t('import.shipped', { titles: report.shipped.join(', ') }))
  lines.push(...siteLockLines(report.siteLock))
  lines.push(...integrationLines(report))
  return lines
}
