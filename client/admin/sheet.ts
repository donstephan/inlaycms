const FIELD = 'input:not([type="hidden"]):not([type="radio"]), select, textarea'

const dirty = new WeakSet<HTMLDialogElement>()
const boundDocs = new WeakSet<Document>()
const boundSheets = new WeakSet<Element>()

const visible = (el: HTMLElement) => !el.closest('[hidden]')

const hasProblems = (sheet: Element) =>
  [...sheet.querySelectorAll<HTMLElement>('[role="alert"], [aria-invalid="true"]')].some(visible)

export function openSheet(sheet: HTMLDialogElement): void {
  if (!sheet.open) sheet.showModal()
  const pick = (selector: string) => [...sheet.querySelectorAll<HTMLElement>(selector)].find(visible)
  const alert = pick('[role="alert"]')
  if (alert) {
    if (!alert.hasAttribute('tabindex')) alert.setAttribute('tabindex', '-1')
    alert.focus()
    return
  }
  const invalid = pick('[aria-invalid="true"]')
  if (invalid) {
    const blank = [...sheet.querySelectorAll<HTMLInputElement>('input[type="password"]')].find((i) => visible(i) && i.value === '')
    const first = blank && blank.compareDocumentPosition(invalid) & Node.DOCUMENT_POSITION_FOLLOWING ? blank : invalid
    first.focus()
    return
  }
  ;(pick('[autofocus]') ?? pick(FIELD))?.focus()
}

function syncShown(root: ParentNode): void {
  for (const sheet of root.querySelectorAll('dialog.sheet')) {
    for (const el of sheet.querySelectorAll<HTMLElement>('[data-shown-when]')) {
      const [name = '', value = ''] = (el.dataset.shownWhen ?? '').split('=')
      const checked = [...sheet.querySelectorAll<HTMLInputElement>('input')].find((i) => i.name === name && i.checked)
      el.hidden = checked?.value !== value
    }
  }
}

function forgetSheetParam(): void {
  const url = new URL(location.href)
  if (!url.searchParams.has('sheet')) return
  url.searchParams.delete('sheet')
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

function bindSheet(sheet: HTMLDialogElement): void {
  if (boundSheets.has(sheet)) return
  boundSheets.add(sheet)
  const markDirty = () => dirty.add(sheet)
  sheet.addEventListener('input', markDirty)
  sheet.addEventListener('change', markDirty)
  sheet.addEventListener('close', () => {
    dirty.delete(sheet)
    forgetSheetParam()
  })
}

export function initSheets(doc: Document): void {
  const sheets = doc.querySelectorAll<HTMLDialogElement>('dialog.sheet')
  for (const sheet of sheets) bindSheet(sheet)

  if (!boundDocs.has(doc)) {
    boundDocs.add(doc)
    doc.addEventListener('click', (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const opener = target.closest<HTMLElement>('[data-sheet-open]')
      if (opener) {
        const sheet = doc.getElementById(opener.dataset.sheetOpen ?? '')
        if (sheet instanceof HTMLDialogElement) openSheet(sheet)
        return
      }
      const closer = target.closest('[data-sheet-close]')
      if (closer) {
        closer.closest('dialog')?.close()
        return
      }
      if (target instanceof HTMLDialogElement && target.classList.contains('sheet') && !dirty.has(target)) target.close()
    })
    doc.addEventListener('change', (event) => {
      const sheet = event.target instanceof Element ? event.target.closest('dialog.sheet') : null
      if (sheet) syncShown(sheet.parentNode ?? doc)
    })
  }

  syncShown(doc)
  for (const sheet of doc.querySelectorAll<HTMLDialogElement>('dialog.sheet[data-sheet-autoopen]')) {
    if (hasProblems(sheet)) dirty.add(sheet)
    openSheet(sheet)
  }
}
