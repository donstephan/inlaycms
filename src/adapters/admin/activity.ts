import { t } from '../../core/messages/index.js'
import type { Activity, DocumentSummary, RevisionSource } from '../../core/types.js'

/** One line of recent activity: as the core reports it, or a burst of edits by one person collapsed into one. */
export type ActivityLine =
  | Activity
  | { kind: 'edits'; at: string; authorName: string; source: RevisionSource; documents: DocumentSummary[] }

const BURST_GAP_MS = 10 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const SHORT_DATE = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const LONG_DATE = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

const utcDay = (date: Date) => Math.floor(date.getTime() / DAY_MS)

function dayLabel(at: Date, now: Date): string {
  const diff = utcDay(now) - utcDay(at)
  if (diff === 0) return t('admin.activity.today')
  if (diff === 1) return t('admin.activity.yesterday')
  return at.getUTCFullYear() === now.getUTCFullYear() ? SHORT_DATE.format(at) : LONG_DATE.format(at)
}

/** Whether `item` (older) continues the run of edits that `line` (newer) ends with. */
function continues(line: ActivityLine | undefined, item: Activity, last: string): boolean {
  if (line === undefined || item.kind !== 'edit' || (line.kind !== 'edit' && line.kind !== 'edits')) return false
  if (line.authorName !== item.authorName || line.source !== item.source) return false
  return Date.parse(last) - Date.parse(item.at) <= BURST_GAP_MS
}

/**
 * Recent activity (newest first) grouped by UTC calendar day, labeled relative to `now`. Within a day, consecutive
 * edits by the same person through the same channel, each within 10 minutes of the one before, become one line.
 */
export function groupActivity(items: readonly Activity[], now: Date): Array<{ day: string; lines: ActivityLine[] }> {
  const days: Array<{ key: number; day: string; lines: ActivityLine[] }> = []
  let last = ''
  for (const item of items) {
    const at = new Date(item.at)
    const key = utcDay(at)
    let group = days[days.length - 1]
    if (group === undefined || group.key !== key) {
      group = { key, day: dayLabel(at, now), lines: [] }
      days.push(group)
    }
    const prev = group.lines[group.lines.length - 1]
    if (item.kind === 'edit' && prev !== undefined && continues(prev, item, last)) {
      if (prev.kind === 'edit') {
        group.lines[group.lines.length - 1] = {
          kind: 'edits',
          at: prev.at,
          authorName: prev.authorName,
          source: prev.source,
          documents: [prev.document],
        }
      }
      const merged = group.lines[group.lines.length - 1]
      if (merged?.kind === 'edits' && !merged.documents.some((d) => d.id === item.document.id)) merged.documents.push(item.document)
    } else {
      group.lines.push(item)
    }
    last = item.at
  }
  return days.map(({ day, lines }) => ({ day, lines }))
}
