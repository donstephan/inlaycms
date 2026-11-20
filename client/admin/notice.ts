/**
 * After a form is sent, the server redirects back with a notice and the browser loads the page from the top. When it
 * lands on the same page, this puts back where the form was sent from: the window's and each `[data-keep-scroll]`
 * pane's scroll, and which editor cards and list items were open.
 */

const KEY = 'inlay:place'

interface Place {
  path: string
  y: number
  panes: Record<string, number>
  open: string[]
  closed: string[]
}

const details = (selector: string) => [...document.querySelectorAll<HTMLDetailsElement>(selector)]

function remember(event: SubmitEvent): void {
  const form = event.target
  if (event.defaultPrevented || !(form instanceof HTMLFormElement) || form.method !== 'post') return
  const panes: Record<string, number> = {}
  for (const pane of document.querySelectorAll<HTMLElement>('[data-keep-scroll]')) if (pane.id !== '') panes[pane.id] = pane.scrollTop
  const place: Place = {
    path: location.pathname,
    y: window.scrollY,
    panes,
    open: details('details[data-item]').filter((d) => d.open).map((d) => d.dataset.item ?? ''),
    closed: details('details[data-card]').filter((d) => !d.open).map((d) => d.dataset.card ?? ''),
  }
  try {
    sessionStorage.setItem(KEY, JSON.stringify(place))
  } catch {}
}

function recall(): Place | null {
  try {
    const saved = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    return saved === null ? null : (JSON.parse(saved) as Place)
  } catch {
    return null
  }
}

function restore(place: Place): void {
  const open = new Set(place.open)
  const closed = new Set(place.closed)
  for (const d of details('details[data-item]')) if (open.has(d.dataset.item ?? '')) d.open = true
  for (const d of details('details[data-card]')) if (closed.has(d.dataset.card ?? '')) d.open = false
  requestAnimationFrame(() => {
    for (const [id, top] of Object.entries(place.panes)) {
      const pane = document.getElementById(id)
      if (pane?.hasAttribute('data-keep-scroll')) pane.scrollTop = top
    }
    window.scrollTo(0, place.y)
  })
}

function hideLater(notice: HTMLElement): void {
  const hide = () => {
    notice.classList.add('opacity-0')
    setTimeout(() => notice.remove(), 300)
  }
  const wait = Math.max(6000, (notice.textContent ?? '').length * 80)
  let timer = setTimeout(hide, wait)
  notice.addEventListener('pointerenter', () => clearTimeout(timer))
  notice.addEventListener('pointerleave', () => {
    timer = setTimeout(hide, 3000)
  })
  notice.querySelector('[data-notice-dismiss]')?.addEventListener('click', () => notice.remove())
}

/** Takes the notice out of the address, so reloading or coming back to the page doesn't show it again. */
function forget(notice: HTMLElement): void {
  const url = new URL(location.href)
  for (const name of (notice.dataset.noticeQuery ?? '').split(' ')) url.searchParams.delete(name)
  if (url.href !== location.href) history.replaceState(history.state, '', url)
}

/** Runs on DOMContentLoaded; the scroll waits a frame, until the editor has mounted its fields. */
export function initNotice(): void {
  const place = recall()
  const notice = document.getElementById('admin-notice')
  if (!notice) return
  hideLater(notice)
  forget(notice)
  if (place && place.path === location.pathname) restore(place)
}

document.addEventListener('submit', remember)
