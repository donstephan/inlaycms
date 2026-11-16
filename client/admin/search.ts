const INPUT = 'global-search'
const RESULTS = 'global-search-results'
const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

const bound = new WeakSet<Document>()
/** The results box each document showed last, to tell when htmx has put in a new one. */
const lastResults = new WeakMap<Document, HTMLElement | null>()

const inputOf = (doc: Document) => doc.getElementById(INPUT) as HTMLInputElement | null
const resultsOf = (doc: Document) => doc.getElementById(RESULTS)
const optionsOf = (doc: Document) => [...(resultsOf(doc)?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]

/** Whether the results box is showing something: hits, or a message that nothing matched. */
function shown(doc: Document): boolean {
  const results = resultsOf(doc)
  return results !== null && !results.hidden && results.childElementCount > 0
}

/** Whether the results box is showing a list of hits to move through. */
function expanded(doc: Document): boolean {
  return shown(doc) && resultsOf(doc)?.querySelector('[role="listbox"]') != null
}

function setActive(doc: Document, option: HTMLElement | null): void {
  const input = inputOf(doc)
  for (const other of optionsOf(doc)) {
    other.setAttribute('aria-selected', String(other === option))
    other.querySelector('a')?.classList.toggle('menu-active', other === option)
  }
  if (input === null) return
  if (option === null) input.removeAttribute('aria-activedescendant')
  else input.setAttribute('aria-activedescendant', option.id)
}

/** The highlighted option. New results reuse option ids, so an option counts only while it is still the one highlighted. */
function active(doc: Document): HTMLElement | null {
  const id = inputOf(doc)?.getAttribute('aria-activedescendant')
  if (id === null || id === undefined) return null
  return optionsOf(doc).find((o) => o.id === id && o.getAttribute('aria-selected') === 'true') ?? null
}

/**
 * Brings `aria-expanded` in line with the results box, and drops the active option when the results box was replaced
 * or no longer has it.
 */
function sync(doc: Document): void {
  const input = inputOf(doc)
  if (input === null) return
  const results = resultsOf(doc)
  if (lastResults.has(doc) && lastResults.get(doc) !== results) setActive(doc, null)
  lastResults.set(doc, results)
  const open = String(expanded(doc))
  if (input.getAttribute('aria-expanded') !== open) input.setAttribute('aria-expanded', open)
  if (input.hasAttribute('aria-activedescendant') && active(doc) === null) input.removeAttribute('aria-activedescendant')
}

function close(doc: Document): void {
  const results = resultsOf(doc)
  if (results !== null) results.hidden = true
  setActive(doc, null)
  sync(doc)
}

function move(doc: Document, step: 1 | -1): void {
  const options = optionsOf(doc)
  if (options.length === 0 || !expanded(doc)) return
  const at = options.indexOf(active(doc) ?? (step === 1 ? options[options.length - 1]! : options[0]!))
  const next = options[(at + step + options.length) % options.length] ?? null
  setActive(doc, next)
  next?.scrollIntoView?.({ block: 'nearest' })
}

function onInputKey(doc: Document, input: HTMLInputElement, event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp':
      if (!expanded(doc)) return
      event.preventDefault()
      move(doc, event.key === 'ArrowDown' ? 1 : -1)
      return
    case 'Enter': {
      const link = active(doc)?.querySelector('a')
      if (!link || !expanded(doc)) return
      event.preventDefault()
      link.click()
      return
    }
    case 'Escape':
      event.preventDefault()
      input.value = ''
      close(doc)
      return
  }
}

/**
 * Keyboard handling for the top bar's search box (a combobox over `#global-search-results`, which htmx fills):
 * `/` focuses it, the arrow keys move through the results, Enter follows the active one, and Escape or a click
 * elsewhere closes them.
 */
export function initGlobalSearch(doc: Document): void {
  sync(doc)
  if (bound.has(doc)) return
  bound.add(doc)

  doc.addEventListener('keydown', (event) => {
    const input = inputOf(doc)
    if (input === null) return
    if (event.target === input) {
      onInputKey(doc, input, event)
      return
    }
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
    const focused = doc.activeElement
    if (focused instanceof Element && focused.closest(TYPING) !== null) return
    event.preventDefault()
    input.focus()
  })

  // What is typed changes the results, so the highlighted one no longer stands.
  doc.addEventListener('input', (event) => {
    if (event.target === inputOf(doc)) setActive(doc, null)
  })

  doc.addEventListener('click', (event) => {
    const input = inputOf(doc)
    if (input === null || !shown(doc)) return
    const inside = input.form ?? input.parentElement
    if (event.target instanceof Node && inside?.contains(event.target)) return
    close(doc)
  })

  // htmx replaces the results box whole, so watch for that rather than for its events.
  const root = doc.body ?? doc.documentElement
  new MutationObserver(() => sync(doc)).observe(root, { childList: true, subtree: true })
}
