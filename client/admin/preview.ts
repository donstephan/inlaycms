/**
 * The editor's live preview pane. The form is posted about 400ms after it changes; the page that comes back is written
 * into a hidden iframe stacked over the visible one, and the two swap once it has loaded, so there is no blank frame
 * between updates. Also: device sizes, block highlighting and click-to-jump, hide/show, the narrow-screen switch, and the
 * `_open` / `_closed` values htmx list buttons send. Every text comes from `data-text-*` attributes the server renders.
 */

export type PreviewResult =
  /** `hashes`: the page's inline-script hashes, which the empty page it is written into must allow. */
  | { kind: 'page'; html: string; hashes: string[] }
  | { kind: 'incomplete'; message: string }
  | { kind: 'error'; message: string }

const FORM = 'editor-form'

async function messageOf(res: Response, fallback: string): Promise<string> {
  try {
    const data: unknown = await res.json()
    const message = typeof data === 'object' && data !== null ? (data as { message?: unknown }).message : undefined
    return typeof message === 'string' && message !== '' ? message : fallback
  } catch {
    return fallback
  }
}

async function readResult(res: Response, signedOutMessage: string, failedMessage: string): Promise<PreviewResult> {
  if (res.type === 'opaqueredirect' || res.status === 401) return { kind: 'error', message: signedOutMessage }
  if (res.status === 200) {
    const hashes = (res.headers.get('x-inlay-script-hashes') ?? '').split(' ').filter((hash) => hash !== '')
    return { kind: 'page', html: await res.text(), hashes }
  }
  if (res.status === 422) return { kind: 'incomplete', message: await messageOf(res, failedMessage) }
  if (res.status === 500) return { kind: 'error', message: await messageOf(res, failedMessage) }
  return { kind: 'error', message: failedMessage }
}

/** The form urlencoded, as htmx sends it: the admin reads no other kind of form. A file goes by its name, as a browser sends it. */
export function encoded(form: HTMLFormElement): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of new FormData(form)) params.append(key, typeof value === 'string' ? value : value.name)
  return params
}

/** Debounced, cancel-previous poster. `getForm` is called at send time, so a form htmx replaced is never posted. */
export function createUpdater(opts: {
  url: string
  getForm: () => HTMLFormElement | null
  delay: number // 400 in production
  fetch: typeof fetch
  signedOutMessage: string
  /** Shown when the answer is neither a page nor a message. */
  failedMessage: string
  onStart: () => void
  onResult: (r: PreviewResult) => void
}): { schedule(): void; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | null = null
  let seq = 0

  async function send(): Promise<void> {
    timer = undefined
    const form = opts.getForm()
    if (!form) return
    controller?.abort()
    const mine = new AbortController()
    controller = mine
    const at = ++seq
    opts.onStart()
    let result: PreviewResult
    try {
      const res = await opts.fetch(opts.url, {
        method: 'POST',
        body: encoded(form),
        redirect: 'manual',
        credentials: 'same-origin',
        signal: mine.signal,
      })
      result = await readResult(res, opts.signedOutMessage, opts.failedMessage)
    } catch {
      result = { kind: 'error', message: opts.failedMessage }
    }
    // Only the latest request's answer counts: an older one that arrives late is dropped.
    if (at !== seq || mine.signal.aborted) return
    controller = null
    opts.onResult(result)
  }

  return {
    schedule() {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => void send(), opts.delay)
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      seq++
      controller?.abort()
      controller = null
    },
  }
}

/** Whether `win` shows the empty page loaded for write `token`. */
function showsBlank(win: Window, token: number): boolean {
  try {
    return new URL(win.location.href).searchParams.get('n') === String(token)
  } catch {
    return false
  }
}

/**
 * Writes pages into the hidden frame. Each write first loads the empty pane page into the frame, so the page's scripts
 * start in a fresh window (rewriting a used document would keep its window: its globals, its timers, its modules), then
 * writes the page there under the page's own address, and calls `onSwap` once its stylesheets have loaded. Only the
 * latest write counts: a newer write or `cancel()` drops a pending one.
 */
export function createPageWriter(opts: {
  blankUrl: string
  pagePath: string
  /** The hidden frame, at the time of the write. */
  back: () => HTMLIFrameElement
  onSwap: () => void
  /** How long to wait for the written page's stylesheets before showing it anyway. */
  fallbackMs: number
}): { write(html: string, hashes?: readonly string[]): void; cancel(): void } {
  let seq = 0

  function write(html: string, hashes: readonly string[] = []): void {
    const token = ++seq
    const frame = opts.back()
    const onBlank = () => {
      if (token !== seq) {
        frame.removeEventListener('load', onBlank)
        return
      }
      const win = frame.contentWindow
      const doc = frame.contentDocument
      // A load from an earlier write: keep waiting for this one's.
      if (!win || !doc || !showsBlank(win, token)) return
      frame.removeEventListener('load', onBlank)
      doc.open()
      win.history.replaceState(null, '', opts.pagePath)
      doc.write(html)
      doc.close()
      // Browsers fire no load event for a written page (and `open()` drops the window's listeners), so wait only for
      // its stylesheets, so it never shows unstyled.
      const pending = [...doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')].filter((link) => link.sheet === null)
      let left = pending.length
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        for (const link of pending) {
          link.removeEventListener('load', settle)
          link.removeEventListener('error', settle)
        }
        if (token === seq) opts.onSwap()
      }
      const settle = () => {
        left--
        if (left === 0) finish()
      }
      if (left === 0) {
        finish()
        return
      }
      for (const link of pending) {
        link.addEventListener('load', settle)
        link.addEventListener('error', settle)
      }
      // A stylesheet that never answers: show the page anyway.
      timer = setTimeout(finish, opts.fallbackMs)
    }
    frame.addEventListener('load', onBlank)
    // The empty page's policy is the written page's too, so it is asked to allow that page's inline scripts.
    const allow = hashes.map((hash) => `&h=${encodeURIComponent(hash)}`).join('')
    const url = `${opts.blankUrl}${opts.blankUrl.includes('?') ? '&' : '?'}n=${token}${allow}`
    // `replace` keeps the frame's loads out of the browser's back button.
    const win = frame.contentWindow
    if (win) win.location.replace(url)
    else frame.src = url
  }

  return {
    write,
    cancel() {
      seq++
    },
  }
}

const START = /^inlay:slot (.+)$/
const END = /^\/inlay:slot (.+)$/

/** Top-level element nodes between each slot's start and end markers, by slot key. */
export function slotElements(doc: Document): Map<string, Element[]> {
  const out = new Map<string, Element[]>()
  const walker = doc.createTreeWalker(doc, 0x80 /* NodeFilter.SHOW_COMMENT */)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const key = START.exec(node.nodeValue ?? '')?.[1]
    if (key === undefined) continue
    const elements = out.get(key) ?? []
    for (let sib = node.nextSibling; sib; sib = sib.nextSibling) {
      if (sib.nodeType === 8 && END.exec(sib.nodeValue ?? '')?.[1] === key) break
      if (sib.nodeType === 1) elements.push(sib as Element)
    }
    out.set(key, elements)
  }
  return out
}

/** The slot key whose elements contain `node`, or null. */
export function slotOf(doc: Document, node: Node): string | null {
  for (const [key, elements] of slotElements(doc)) {
    if (elements.some((el) => el.contains(node))) return key
  }
  return null
}

/** The zoom for showing `deviceWidth` in `stageWidth`: min(1, stageWidth / deviceWidth). */
export function fitScale(stageWidth: number, deviceWidth: number): number {
  if (!(deviceWidth > 0) || !(stageWidth > 0)) return 1
  return Math.min(1, stageWidth / deviceWidth)
}

// ---------------------------------------------------------------------------
// On any page with the editor form

const inForm = (target: EventTarget | null): boolean => target instanceof Element && target.closest(`#${FORM}`) !== null

/** Whether a `htmx:afterSwap` put a new editor form in place. */
function swappedForm(event: Event): boolean {
  const detail = (event as CustomEvent<{ target?: unknown }>).detail
  const target = event.target
  return (target instanceof Element && target.id === FORM) || (detail?.target instanceof Element && detail.target.id === FORM)
}

let unsavedShown = false

/** Shows "Unsaved changes" with a dot in the header. */
function markUnsaved(): void {
  const state = document.getElementById('save-state')
  const text = state?.dataset.textUnsaved
  if (!state || text === undefined || unsavedShown) return
  unsavedShown = true
  const dot = document.createElement('span')
  dot.className = 'inline-block h-2 w-2 rounded-full bg-warning'
  dot.setAttribute('aria-hidden', 'true')
  const wrap = document.createElement('span')
  wrap.className = 'inline-flex items-center gap-1.5'
  wrap.append(dot, text)
  state.replaceChildren(wrap)
}

/** Tells the server which list items are open and which cards are closed, so a list button keeps them that way. */
function onConfigRequest(event: Event): void {
  const detail = (event as CustomEvent<{ elt?: unknown; target?: unknown; formData?: unknown }>).detail
  const fromForm = (detail?.elt instanceof Element && inForm(detail.elt)) || (detail?.target instanceof Element && detail.target.id === FORM)
  const form = document.getElementById(FORM)
  if (!fromForm || !form || !(detail?.formData instanceof FormData)) return
  const open = [...form.querySelectorAll<HTMLDetailsElement>('details[data-item]')].filter((d) => d.open).map((d) => d.dataset.item ?? '')
  const closed = [...form.querySelectorAll<HTMLDetailsElement>('details[data-card]')].filter((d) => !d.open).map((d) => d.dataset.card ?? '')
  detail.formData.set('_open', open.filter((s) => s !== '').join(','))
  detail.formData.set('_closed', closed.filter((s) => s !== '').join(','))
}

/** Called on every change to the form; the pane sets it when there is one. */
let onFormChange: () => void = () => {}

document.addEventListener('input', (event) => {
  if (!inForm(event.target)) return
  markUnsaved()
  onFormChange()
})
document.addEventListener('change', (event) => {
  if (!inForm(event.target)) return
  markUnsaved()
  onFormChange()
})
document.addEventListener('htmx:afterSwap', (event) => {
  if (!swappedForm(event)) return
  markUnsaved()
  onFormChange()
})
document.addEventListener('htmx:configRequest', onConfigRequest)
// Save and publish saved the form in the background and put "Last saved" back: the next edit marks it unsaved again.
document.addEventListener('inlay:saved', () => {
  unsavedShown = false
})

// ---------------------------------------------------------------------------
// The pane

const DEVICES = { desktop: 1280, tablet: 768, phone: 390 } as const
type Device = keyof typeof DEVICES
const isDevice = (value: string | null | undefined): value is Device => value != null && Object.hasOwn(DEVICES, value)

const DEVICE_KEY = 'inlay.preview.device'
const HIDDEN_KEY = 'inlay.preview.hidden'
const HIGHLIGHT_ID = 'inlay-preview-highlight'
const DIM = 'opacity-60'

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private browsing: the choice just isn't remembered.
  }
}

const narrow = (): boolean => window.matchMedia?.('(width < 64rem)').matches === true

const FOCUSABLE = [
  'input:not([type="hidden"]):not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[contenteditable="true"]',
  'button:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

interface PaneElements {
  pane: HTMLElement
  workspace: HTMLElement
  stage: HTMLElement
  device: HTMLElement
  first: HTMLIFrameElement
  status: HTMLElement
  announce: HTMLElement | null
  scaleText: HTMLElement | null
  hideButton: HTMLElement | null
  showButton: HTMLElement | null
}

function startPane(els: PaneElements): void {
  const { pane, workspace, stage, device, first, status, announce, scaleText, hideButton, showButton } = els

  const url = first.dataset.previewUrl ?? first.getAttribute('src') ?? ''
  const pagePath = first.dataset.pagePath ?? '/'
  const text = {
    updating: status.dataset.textUpdating ?? '',
    ready: status.dataset.textReady ?? '',
    signedOut: status.dataset.textSignedOut ?? '',
    failed: status.dataset.textFailed ?? '',
  }

  const blankUrl = first.dataset.blankUrl ?? `${url}/blank`

  // The second frame starts on the pane's empty page rather than about:blank, which would carry the admin's security
  // policy; every write loads that page again first.
  let front: HTMLIFrameElement = first
  const back0 = first.cloneNode(false) as HTMLIFrameElement
  back0.removeAttribute('id')
  back0.setAttribute('aria-hidden', 'true')
  back0.tabIndex = -1
  back0.style.visibility = 'hidden'
  back0.src = blankUrl
  let back: HTMLIFrameElement = back0

  let activeSlot: string | null = null
  let current: Device = isDevice(stored(DEVICE_KEY)) ? (stored(DEVICE_KEY) as Device) : 'desktop'
  let stale = false

  const setStatus = (message: string) => {
    status.textContent = message
    status.title = message
  }
  const say = (message: string) => {
    setStatus(message)
    if (announce) announce.textContent = message
  }

  // Highlighting --------------------------------------------------------

  function drawHighlight(scroll: boolean): void {
    const doc = front.contentDocument
    if (!doc) return
    doc.getElementById(HIGHLIGHT_ID)?.remove()
    if (activeSlot === null) return
    const elements = slotElements(doc).get(activeSlot) ?? []
    const view = doc.defaultView
    if (elements.length === 0 || !view) return
    let top = Infinity
    let left = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (const el of elements) {
      const r = el.getBoundingClientRect()
      top = Math.min(top, r.top)
      left = Math.min(left, r.left)
      right = Math.max(right, r.right)
      bottom = Math.max(bottom, r.bottom)
    }
    const box = doc.createElement('div')
    box.id = HIGHLIGHT_ID
    box.setAttribute('aria-hidden', 'true')
    Object.assign(box.style, {
      position: 'absolute',
      top: `${top + view.scrollY - 4}px`,
      left: `${left + view.scrollX - 4}px`,
      width: `${right - left + 8}px`,
      height: `${bottom - top + 8}px`,
      outline: '3px solid #1d4ed8',
      borderRadius: '4px',
      pointerEvents: 'none',
      zIndex: '2147483647',
      margin: '0',
    })
    doc.documentElement.append(box)
    if (scroll) elements[0]?.scrollIntoView({ block: 'nearest' })
  }

  function highlight(slot: string | null): void {
    const changed = slot !== activeSlot
    activeSlot = slot
    for (const card of document.querySelectorAll<HTMLElement>('details[data-card]')) {
      card.classList.toggle('is-active', slot !== null && card.dataset.card === slot)
    }
    drawHighlight(changed)
  }

  /** Opens the block's card, scrolls to it and focuses its first control. */
  function jumpTo(slot: string): void {
    const card = [...document.querySelectorAll<HTMLDetailsElement>('details[data-card]')].find((d) => d.dataset.card === slot)
    if (!card) return
    card.open = true
    if (narrow()) setView('edit')
    card.scrollIntoView({ block: 'start', behavior: 'smooth' })
    const body = card.querySelector(':scope > :not(summary)') ?? card
    const control = body.querySelector<HTMLElement>(FOCUSABLE)
    control?.focus({ preventScroll: true })
    highlight(slot)
  }

  /** Links and forms in the page don't go anywhere; a click inside a block jumps to its card. */
  function wire(doc: Document): void {
    doc.onclick = (event) => {
      event.preventDefault()
      const slot = event.target === null ? null : slotOf(doc, event.target as Node)
      if (slot !== null) jumpTo(slot)
    }
    doc.onsubmit = (event) => event.preventDefault()
  }

  document.addEventListener('focusin', (event) => {
    if (!inForm(event.target)) return
    const card = (event.target as Element).closest<HTMLElement>('details[data-card]')
    const slot = card?.dataset.card
    highlight(slot === undefined || slot === 'fields' ? null : slot)
  })

  // Writing pages -------------------------------------------------------

  function swap(): void {
    // A first load still pending is stale now: its frame is about to be reused as the hidden one.
    firstDone = true
    const next = back
    next.contentWindow?.scrollTo(0, front.contentWindow?.scrollY ?? 0)
    if (next.contentDocument) wire(next.contentDocument)
    next.style.visibility = ''
    next.removeAttribute('aria-hidden')
    next.removeAttribute('tabindex')
    next.id = 'preview-frame'
    next.classList.remove(DIM)
    front.style.visibility = 'hidden'
    front.setAttribute('aria-hidden', 'true')
    front.tabIndex = -1
    front.removeAttribute('id')
    front.classList.remove(DIM)
    back = front
    front = next
    drawHighlight(false)
    if (!busy) setStatus(text.ready)
    if (announce) announce.textContent = ''
  }

  const writer = createPageWriter({ blankUrl, pagePath, back: () => back, onSwap: swap, fallbackMs: 1000 })
  first.after(back0)

  let busy = false
  function onResult(result: PreviewResult): void {
    busy = false
    if (result.kind === 'page') {
      writer.write(result.html, result.hashes)
      return
    }
    // A page still on its way is older than this message, so it must not replace the dimmed page and the message.
    writer.cancel()
    if (result.kind === 'incomplete') front.classList.add(DIM)
    say(result.message)
  }

  // The first load is the saved draft from the pane address; after it the frame shows the page's own address.
  const previewPath = new URL(url, location.href).pathname
  let firstDone = false
  function onFirstLoad(): void {
    if (firstDone) return
    const win = first.contentWindow
    const doc = first.contentDocument
    firstDone = true
    if (!win || !doc) {
      say(text.failed)
      return
    }
    if (win.location.pathname !== previewPath) {
      // Sent to the sign-in page: don't show it in the pane.
      doc.open()
      doc.write('<!doctype html><title></title>')
      doc.close()
      say(text.signedOut)
      return
    }
    win.history.replaceState(null, '', pagePath)
    wire(doc)
    drawHighlight(false)
    setStatus(text.ready)
  }
  if (first.contentDocument?.readyState === 'complete' && first.contentWindow?.location.href !== 'about:blank') onFirstLoad()
  else first.addEventListener('load', onFirstLoad, { once: true })

  const updater = createUpdater({
    url,
    getForm: () => {
      const form = document.getElementById(FORM)
      return form instanceof HTMLFormElement ? form : null
    },
    delay: 400,
    fetch: (...args) => window.fetch(...args),
    signedOutMessage: text.signedOut,
    failedMessage: text.failed,
    onStart: () => {
      busy = true
      setStatus(text.updating)
    },
    onResult,
  })

  // Below `lg` the Edit / Preview switch decides what shows, and `.no-preview` does nothing.
  const hidden = () => workspace.classList.contains('no-preview') && !narrow()
  onFormChange = () => {
    // A hidden pane isn't updated; it catches up when it is shown again.
    if (hidden()) stale = true
    else updater.schedule()
  }
  const catchUp = () => {
    if (!stale) return
    stale = false
    updater.schedule()
  }

  // Devices -------------------------------------------------------------

  function fit(): void {
    const style = getComputedStyle(stage)
    const width = stage.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0')
    const height = stage.clientHeight - parseFloat(style.paddingTop || '0') - parseFloat(style.paddingBottom || '0')
    if (width <= 0 || height <= 0) return
    const deviceWidth = DEVICES[current]
    const scale = fitScale(width, deviceWidth)
    for (const frame of [front, back]) {
      frame.style.width = `${deviceWidth}px`
      frame.style.height = `${height / scale}px`
      frame.style.transform = `scale(${scale})`
    }
    device.style.width = `${deviceWidth * scale}px`
    device.style.height = `${height}px`
    if (scaleText) scaleText.textContent = scale < 1 ? `${Math.round(scale * 100)}%` : ''
    requestAnimationFrame(() => drawHighlight(false))
  }

  const deviceButtons = [...pane.querySelectorAll<HTMLButtonElement>('button[data-device]')]
  function setDevice(next: Device): void {
    current = next
    for (const button of deviceButtons) {
      const on = button.dataset.device === next
      button.setAttribute('aria-pressed', String(on))
      button.classList.toggle('btn-active', on)
    }
    fit()
  }
  for (const button of deviceButtons) {
    button.addEventListener('click', () => {
      const next = button.dataset.device
      if (!isDevice(next)) return
      store(DEVICE_KEY, next)
      setDevice(next)
    })
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => fit()).observe(stage)

  // Hide and show, Edit / Preview ---------------------------------------

  function setHidden(hide: boolean, focus: boolean): void {
    workspace.classList.toggle('no-preview', hide)
    if (showButton) showButton.hidden = !hide
    store(HIDDEN_KEY, hide ? '1' : '0')
    if (focus) (hide ? showButton : hideButton)?.focus()
    if (!hide) {
      fit()
      catchUp()
    }
  }
  hideButton?.addEventListener('click', () => setHidden(true, true))
  showButton?.addEventListener('click', () => setHidden(false, true))

  const viewButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-view-btn]')]
  function setView(view: string): void {
    workspace.dataset.view = view
    for (const button of viewButtons) {
      const on = button.dataset.viewBtn === view
      button.setAttribute('aria-pressed', String(on))
      button.classList.toggle('btn-active', on)
    }
    if (view === 'preview') {
      requestAnimationFrame(fit)
      catchUp()
    }
  }
  for (const button of viewButtons) button.addEventListener('click', () => setView(button.dataset.viewBtn ?? 'edit'))

  if (stored(HIDDEN_KEY) === '1') setHidden(true, false)
  setView(workspace.dataset.view ?? 'edit')
  setDevice(current)
}

function start(): void {
  const pane = document.getElementById('preview-pane')
  const workspace = document.getElementById('workspace')
  const stage = document.getElementById('preview-stage')
  const device = document.getElementById('preview-device')
  const first = document.getElementById('preview-frame')
  const status = document.getElementById('preview-status')
  if (!pane || !workspace || !stage || !device || !(first instanceof HTMLIFrameElement) || !status) return
  startPane({
    pane,
    workspace,
    stage,
    device,
    first,
    status,
    announce: document.getElementById('preview-announce'),
    scaleText: document.getElementById('preview-scale'),
    hideButton: document.getElementById('preview-hide'),
    showButton: document.getElementById('preview-show'),
  })
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
else start()
