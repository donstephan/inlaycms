import { t } from '../messages/index.js'

const SIZE_UNITS = [
  { bytes: 1024 * 1024, id: 'size.mb' },
  { bytes: 1024, id: 'size.kb' },
] as const

/** A byte count in plain words: MB from 1 MB up, KB from 1 KB, bytes below that. */
export function formatSize(bytes: number): string {
  for (const unit of SIZE_UNITS) {
    if (bytes >= unit.bytes) return t(unit.id, { n: Math.round((bytes / unit.bytes) * 10) / 10 })
  }
  return t('size.bytes', { n: bytes })
}

const missingDate = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

export function missingMediaLabel(entry: { filename: string; deletedAt: string }): string {
  return t('media.missing', { filename: entry.filename, date: missingDate.format(new Date(entry.deletedAt)) })
}
