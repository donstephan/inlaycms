const absolute = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function relativeText(date: Date, now: Date): string {
  const diff = date.getTime() - now.getTime()
  const age = Math.abs(diff)
  if (age >= 7 * DAY) return dateOnly.format(date)
  if (age < HOUR) return relativeFormat.format(Math.round(diff / MINUTE), 'minute')
  if (age < DAY) return relativeFormat.format(Math.round(diff / HOUR), 'hour')
  return relativeFormat.format(Math.round(diff / DAY), 'day')
}

export function localiseTimes(root: ParentNode, now: Date = new Date()): void {
  for (const el of root.querySelectorAll<HTMLTimeElement>('time[data-local]')) {
    const date = new Date(el.dateTime)
    if (Number.isNaN(date.getTime())) continue
    const full = absolute.format(date)
    if (el.hasAttribute('data-relative')) {
      el.textContent = relativeText(date, now)
      el.title = full
    } else {
      el.textContent = full
    }
  }
}
