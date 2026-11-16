/** Loads `url`'s `#bulk-delete-confirm` into the dialog. htmx is imported when needed, so this module loads without it. */
async function loadConfirm(url: string): Promise<void> {
  const mod = await import('htmx.org')
  // htmx.org ships ESM without `"type": "module"`, so TypeScript reads its default export one level too deep.
  const htmx = mod.default as unknown as typeof mod.default.default
  await htmx.ajax('get', url, { target: '#bulk-delete-body', select: '#bulk-delete-confirm' })
}

const bound = new WeakSet<Element>()

/** Cancel inside the dialog closes it; without JS, Cancel stays a link back to the list. */
function bindDialog(dialog: HTMLDialogElement): void {
  if (bound.has(dialog)) return
  bound.add(dialog)
  dialog.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || event.target.closest('[data-dialog-cancel]') === null) return
    event.preventDefault()
    dialog.close()
  })
}

/** Opens the dialog and loads the confirmation for `url` into it; if that fails, goes to the confirmation page instead. */
function confirmIn(dialog: HTMLDialogElement, url: string): void {
  const doc = dialog.ownerDocument
  const body = doc.getElementById('bulk-delete-body')
  body?.replaceChildren()
  bindDialog(dialog)
  if (!dialog.open) dialog.showModal()
  const fallBack = () => {
    dialog.close()
    doc.defaultView?.location.assign(url)
  }
  loadConfirm(url).then(
    () => {
      const confirm = body?.querySelector<HTMLElement>('#bulk-delete-confirm')
      if (confirm == null) return fallBack()
      confirm.querySelector<HTMLElement>('form button[type="submit"]')?.focus()
    },
    fallBack,
  )
}

function bindBar(bar: HTMLElement): void {
  if (bound.has(bar)) return
  bound.add(bar)
  const form = bar.querySelector('form')
  if (form === null || form.id === '') return
  const doc = bar.ownerDocument
  const tied = (selector: string) =>
    [...doc.querySelectorAll<HTMLInputElement>(selector)].filter((input) => input.getAttribute('form') === form.id)
  const boxes = () => tied('input[type="checkbox"][name="ids"]')
  const selectAlls = () => tied('input[type="checkbox"][data-select-all]')
  const count = bar.querySelector('[data-selected-count]')
  const template = bar.dataset.selectedTemplate ?? '{count}'

  const update = () => {
    const all = boxes()
    const ticked = all.filter((box) => box.checked).length
    bar.hidden = ticked === 0
    if (count !== null) count.textContent = ticked === 0 ? '' : template.replace('{count}', String(ticked))
    for (const selectAll of selectAlls()) {
      selectAll.checked = ticked > 0 && ticked === all.length
      selectAll.indeterminate = ticked > 0 && ticked < all.length
    }
  }

  for (const box of boxes()) box.addEventListener('change', update)
  for (const selectAll of selectAlls()) {
    selectAll.addEventListener('change', () => {
      for (const box of boxes()) box.checked = selectAll.checked
      update()
    })
  }
  for (const button of bar.querySelectorAll<HTMLButtonElement>('button[data-bulk-delete]')) {
    button.addEventListener('click', (event) => {
      const dialog = doc.getElementById('bulk-delete-dialog')
      const action = button.getAttribute('formaction')
      if (!(dialog instanceof HTMLDialogElement) || action === null) return
      event.preventDefault()
      const params = new URLSearchParams()
      for (const box of boxes()) if (box.checked) params.append('ids', box.value)
      const back = tied('input[name="back"]')[0]
      if (back !== undefined) params.set('back', back.value)
      confirmIn(dialog, `${action}?${params.toString()}`)
    })
  }
  bar.querySelector('[data-clear-selection]')?.addEventListener('click', () => {
    for (const box of boxes()) box.checked = false
    update()
    selectAlls()[0]?.focus()
  })
  update()
}

/**
 * Wires up row selection for every table with a bulk bar under `root`: the bar shows only while rows are ticked.
 * Bulk Delete asks in `dialog#bulk-delete-dialog` instead of leaving the page.
 */
export function initDataTables(root: ParentNode): void {
  if (root instanceof HTMLElement && root.matches('[data-bulk-bar]')) bindBar(root)
  for (const bar of root.querySelectorAll<HTMLElement>('[data-bulk-bar]')) bindBar(bar)
}

const dropdownsBound = new WeakSet<Document>()

/**
 * Makes `details.dropdown` menus behave like menus: Escape inside an open one closes it and puts focus back on its
 * button, and a click anywhere outside an open one (including on another menu's button) closes it.
 */
export function initDropdowns(doc: Document): void {
  if (dropdownsBound.has(doc)) return
  dropdownsBound.add(doc)
  const openMenus = () => [...doc.querySelectorAll<HTMLDetailsElement>('details.dropdown[open]')]

  doc.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !(event.target instanceof Element)) return
    const menu = event.target.closest<HTMLDetailsElement>('details.dropdown[open]')
    if (menu === null) return
    event.preventDefault()
    menu.open = false
    menu.querySelector<HTMLElement>(':scope > summary')?.focus()
  })

  doc.addEventListener('click', (event) => {
    const target = event.target instanceof Node ? event.target : null
    for (const menu of openMenus()) if (target === null || !menu.contains(target)) menu.open = false
  })
}
