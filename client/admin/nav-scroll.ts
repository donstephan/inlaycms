const KEY = 'inlay:nav'

/**
 * Keeps the menu's scroll from one page to the next. `admin.js` calls this as it loads rather than on
 * DOMContentLoaded: the page waits for it before it first paints (`blocking="render"`), so the menu never shows
 * scrolled to the top.
 */
export function keepNavScroll(): void {
  const nav = document.getElementById('admin-nav')
  if (!nav) return
  try {
    const top = Number(sessionStorage.getItem(KEY))
    if (top > 0) nav.scrollTop = top
  } catch {}
  window.addEventListener('pagehide', () => {
    try {
      if (nav.isConnected) sessionStorage.setItem(KEY, String(nav.scrollTop))
    } catch {}
  })
}
