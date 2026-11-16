import { t } from '../../../core/messages/index.js'
import type { DocumentSummary, RevisionSource } from '../../../core/types.js'
import type { Renderable } from '../../../jsx/html.js'

export type DocumentStatus = 'deleted' | 'new' | 'changed' | 'published'

export function documentStatus(d: DocumentSummary): DocumentStatus {
  if (d.deletedAt !== null) return 'deleted'
  if (d.publishedRev === null) return 'new'
  return d.publishedRev === d.headRev ? 'published' : 'changed'
}

type StatusTone = 'success' | 'warning' | 'info' | 'neutral'

export function statusTone(status: DocumentStatus): StatusTone {
  switch (status) {
    case 'published':
      return 'success'
    case 'changed':
      return 'warning'
    case 'new':
      return 'info'
    case 'deleted':
      return 'neutral'
  }
}

/** A tinted color, or `ghost` (plain gray) and `outline` (just a border) for quiet badges. */
export type BadgeTone = StatusTone | 'ghost' | 'outline'

const TONE_CLASS: Record<BadgeTone, string> = {
  success: 'badge-soft badge-success text-base-content',
  warning: 'badge-soft badge-warning text-base-content',
  info: 'badge-soft badge-info text-base-content',
  neutral: 'badge-soft badge-neutral text-base-content',
  ghost: 'badge-ghost',
  outline: 'badge-outline',
}

/** A badge's classes, for links and buttons that look like one; `md` lines up with the admin's small buttons. */
export function badgeClass(tone: BadgeTone, size: 'sm' | 'md' = 'sm'): string {
  const sized = size === 'md' ? 'badge-md gap-1.5 px-2.5' : 'badge-sm'
  return `badge ${sized} ${TONE_CLASS[tone]}`
}

/** A small label, such as a status or a count. `class` adds layout classes (margins, alignment). */
export function Badge({ tone, size, class: extra, children }: { tone: BadgeTone; size?: 'sm' | 'md'; class?: string; children?: Renderable }) {
  const cls = badgeClass(tone, size)
  return <span class={extra === undefined ? cls : `${cls} ${extra}`}>{children}</span>
}

const DOT_CLASS: Record<StatusTone, string> = {
  success: 'size-1.5 rounded-full bg-success',
  warning: 'size-1.5 rounded-full bg-warning',
  info: 'size-1.5 rounded-full bg-info',
  neutral: 'size-1.5 rounded-full bg-neutral',
}

/** A small colored dot; the status is always also written out. */
export function StatusDot({ status }: { status: DocumentStatus }) {
  return <span class={DOT_CLASS[statusTone(status)]} aria-hidden="true"></span>
}

/** A status name with its colored dot. */
export function StatusLabel({ status }: { status: DocumentStatus }) {
  return (
    <Badge tone={statusTone(status)}>
      <StatusDot status={status} />
      {t(`admin.status.${status}`)}
    </Badge>
  )
}

/** What a document's status is called, and the style that goes with it. */
export function StatusBadge({ doc }: { doc: DocumentSummary }) {
  return <StatusLabel status={documentStatus(doc)} />
}

/** The name of the channel a change came through. */
export function sourceLabel(s: RevisionSource): string {
  switch (s) {
    case 'admin':
      return t('source.admin')
    case 'mcp':
      return t('source.mcp')
    case 'restore':
      return t('source.restore')
    case 'import':
      return t('source.import')
    case 'release':
      return t('source.release')
    case 'system':
      return t('source.system')
  }
}
