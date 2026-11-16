import htmxModule from 'htmx.org'

// htmx.org ships ESM without `"type": "module"`, so TypeScript reads its default export one level too deep.
const htmx = htmxModule as unknown as typeof htmxModule.default

/** What choosing a picker result gives: the stored value, its name and, for images, a thumbnail. */
export interface Pick {
  value: string
  label: string
  thumb?: string
}

declare global {
  interface Window {
    InlayAdmin?: { openPicker: typeof openPicker }
  }
}

const DIALOG = 'inlay-picker'

let opener: HTMLElement | null = null
let pending: ((pick: Pick) => void) | null = null

/** Tells listeners (the live preview) that a hidden input's value changed, as typing would. */
const changed = (input: HTMLInputElement): void => {
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

const dialog = (): HTMLDialogElement | null => {
  const el = document.getElementById(DIALOG)
  return el instanceof HTMLDialogElement ? el : null
}

/** The pick in a result's `data-pick`, or `null` if it isn't one. A thumbnail must be one of the site's media URLs. */
function parsePick(raw: string | null): Pick | null {
  if (raw === null) return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const { value, label, thumb } = data as Record<string, unknown>
  if (typeof value !== 'string' || typeof label !== 'string') return null
  return typeof thumb === 'string' && thumb.startsWith('/media/') ? { value, label, thumb } : { value, label }
}

/** Loads the picker fragment at `url` into the shared dialog and opens it; `onPick` gets the chosen result. */
export function openPicker(url: string, onPick: (pick: Pick) => void): void {
  const box = dialog()
  if (!box) return
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  pending = onPick
  box.querySelector('#inlay-picker-body')?.replaceChildren()
  void htmx.ajax('get', url, { target: '#inlay-picker-body', swap: 'innerHTML' })
  if (!box.open) box.showModal()
}

function showChosen(field: HTMLElement, label: string | null, thumb: string | undefined): void {
  const text = field.querySelector<HTMLElement>('[data-picker-label]')
  if (text) {
    text.textContent = label ?? text.dataset.empty ?? ''
    text.classList.remove('rounded-box', 'bg-warning', 'px-2', 'text-warning-content')
    text.classList.toggle('text-base-content/70', label === null)
  }
  const img = field.querySelector<HTMLImageElement>('img[data-picker-thumb]')
  if (img) {
    if (thumb === undefined) img.removeAttribute('src')
    else img.src = thumb
    img.hidden = thumb === undefined
  }
}

/** Puts `pick` into a picker field: a single field takes its value, a many field gets one more chip (once). */
export function applyPick(field: HTMLElement, pick: Pick): void {
  if (field.hasAttribute('data-many')) {
    const list = field.querySelector('[data-picker-list]')
    const template = field.querySelector('template[data-picker-chip]')
    if (!list || !(template instanceof HTMLTemplateElement)) return
    const taken = [...list.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].some((input) => input.value === pick.value)
    if (taken) return
    const chip = template.content.firstElementChild?.cloneNode(true)
    if (!(chip instanceof HTMLElement)) return
    const input = chip.querySelector<HTMLInputElement>('input[type="hidden"]')
    if (input) input.value = pick.value
    const text = chip.querySelector('[data-chip-label]')
    if (text) text.textContent = pick.label
    const remove = chip.querySelector('[data-picker-remove]')
    const removeLabel = template.dataset.removeLabel
    if (remove && removeLabel !== undefined) remove.setAttribute('aria-label', removeLabel.replace('{item}', pick.label))
    list.append(chip)
    if (input) changed(input)
    return
  }
  const input = field.querySelector<HTMLInputElement>('input[data-picker-value]')
  if (input) input.value = pick.value
  showChosen(field, pick.label, pick.thumb)
  // Choosing a page for a link means the link goes to that page.
  const mode = field.closest('[data-link]')?.querySelector<HTMLInputElement>('input[data-link-mode="document"]')
  if (mode) mode.checked = true
  if (input) changed(input)
}

/** Empties a picker field. */
export function clearField(field: HTMLElement): void {
  if (field.hasAttribute('data-many')) {
    const list = field.querySelector('[data-picker-list]')
    // Told while they are still in the form, so the event reaches it.
    for (const input of list?.querySelectorAll<HTMLInputElement>('input[type="hidden"]') ?? []) changed(input)
    list?.replaceChildren()
    return
  }
  const input = field.querySelector<HTMLInputElement>('input[data-picker-value]')
  if (input) input.value = ''
  showChosen(field, null, undefined)
  if (input) changed(input)
}

/** Removes the chip `button` belongs to, and moves focus to the field's Add button. */
export function removeChip(button: HTMLElement): void {
  const field = button.closest<HTMLElement>('[data-picker]')
  const chip = button.closest('li')
  // Told while it is still in the form, so the event reaches it.
  for (const input of chip?.querySelectorAll<HTMLInputElement>('input[type="hidden"]') ?? []) changed(input)
  chip?.remove()
  field?.querySelector<HTMLElement>('[data-picker-open]')?.focus()
}

/** Closes the picker and hands `pick` to whoever opened it. */
function choose(pick: Pick): void {
  const done = pending
  if (!done) return
  pending = null
  dialog()?.close()
  done(pick)
}

/** Mirrors the core's `isRichTextHref`: an address on this site, or an http(s), mailto or tel URL, without control characters. */
function isLinkAddress(href: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(href)) return false
  if (href.startsWith('/')) return !href.startsWith('//') && !href.startsWith('/\\')
  try {
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(new URL(href).protocol)
  } catch {
    return false
  }
}

/** Picks the web address typed into the documents picker as `url:<address>`, or says why it can't be used. */
function pickWebAddress(box: Element): void {
  const input = box.querySelector<HTMLInputElement>('input')
  if (!input) return
  const href = input.value.trim()
  if (isLinkAddress(href)) {
    choose({ value: `url:${href}`, label: href })
    return
  }
  const problem = box.querySelector<HTMLElement>('[data-pick-web-problem]')
  if (problem) {
    problem.hidden = false
    const ids = (input.getAttribute('aria-describedby') ?? '').split(' ').filter((id) => id !== '')
    if (problem.id !== '' && !ids.includes(problem.id)) input.setAttribute('aria-describedby', [...ids, problem.id].join(' '))
  }
  input.setAttribute('aria-invalid', 'true')
  input.focus()
}

function onClick(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null
  if (!target) return

  const result = target.closest<HTMLElement>(`#${DIALOG} [data-pick]`)
  if (result) {
    const pick = parsePick(result.getAttribute('data-pick'))
    if (pick) choose(pick)
    return
  }
  const web = target.closest(`#${DIALOG} [data-pick-web-use]`)?.closest('[data-pick-web]')
  if (web) {
    pickWebAddress(web)
    return
  }

  const open = target.closest<HTMLElement>('[data-picker-open]')
  const field = target.closest<HTMLElement>('[data-picker]')
  if (open && field) {
    const url = field.dataset.picker
    if (url !== undefined) openPicker(url, (pick) => applyPick(field, pick))
    return
  }
  if (target.closest('[data-picker-clear]') && field) {
    clearField(field)
    return
  }
  const remove = target.closest<HTMLElement>('[data-picker-remove]')
  if (remove) removeChip(remove)
}

/** Typing a web address into a link means the link goes there. */
function onInput(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLInputElement) || !target.hasAttribute('data-link-url')) return
  const mode = target.closest('[data-link]')?.querySelector<HTMLInputElement>('input[data-link-mode="url"]')
  if (mode && target.value !== '') mode.checked = true
}

/** Enter in the web address box picks it, instead of submitting the form around the picker. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return
  const web = event.target.closest(`#${DIALOG} [data-pick-web]`)
  if (!web) return
  event.preventDefault()
  pickWebAddress(web)
}

function onClose(event: Event): void {
  if (!(event.target instanceof HTMLDialogElement) || event.target.id !== DIALOG) return
  pending = null
  if (opener?.isConnected) opener.focus()
  opener = null
}

/** Once a picker has loaded, its search box gets the focus. */
function onSwap(event: Event): void {
  const target = event.target
  if (!(target instanceof Element) || target.id !== 'inlay-picker-body') return
  target.querySelector<HTMLElement>('input[type="search"]')?.focus()
}

document.addEventListener('click', onClick)
document.addEventListener('input', onInput)
document.addEventListener('keydown', onKeydown)
// `close` doesn't bubble, so it is caught on the way down.
document.addEventListener('close', onClose, true)
document.addEventListener('htmx:afterSwap', onSwap)

window.InlayAdmin = { openPicker }
