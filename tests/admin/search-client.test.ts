// @vitest-environment happy-dom
import { initGlobalSearch } from '../../client/admin/search.js'

const results = (prefix: string) => `
  <div id="global-search-results">
    <ul id="global-search-listbox" role="listbox" aria-label="Search results">
      <li role="presentation">
        <ul role="group" aria-label="Posts">
          <li role="presentation" aria-hidden="true">Posts</li>
          <li role="option" id="global-search-opt-0" aria-selected="false"><a href="/admin/documents/${prefix}a" tabindex="-1">A</a></li>
          <li role="option" id="global-search-opt-1" aria-selected="false"><a href="/admin/documents/${prefix}b" tabindex="-1">B</a></li>
        </ul>
      </li>
    </ul>
  </div>`
const RESULTS = results('')
const NONE = '<div id="global-search-results"><div role="status"><p>Nothing matches "zz".</p></div></div>'

function mount(results = '<div id="global-search-results"></div>'): HTMLInputElement {
  document.body.innerHTML = `
    <form role="search" action="/admin/search" method="get">
      <label for="global-search">Search</label>
      <input id="global-search" name="q" type="search" role="combobox" aria-expanded="false" aria-controls="global-search-results" />
      ${results}
    </form>
    <textarea id="notes" aria-label="Notes"></textarea>
    <p id="outside">Elsewhere</p>`
  initGlobalSearch(document)
  return document.querySelector<HTMLInputElement>('#global-search')!
}

const press = (target: EventTarget, key: string) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

/** Lets the results' MutationObserver run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

it('focuses the box on / unless you are typing', () => {
  const input = mount()
  const slash = press(document.body, '/')
  expect(document.activeElement).toBe(input)
  expect(slash.defaultPrevented).toBe(true)

  const notes = document.querySelector<HTMLTextAreaElement>('#notes')!
  notes.focus()
  const typed = press(notes, '/')
  expect(document.activeElement).toBe(notes)
  expect(typed.defaultPrevented).toBe(false)
})

it('moves through the results with the arrow keys and closes on Escape', async () => {
  const input = mount()
  expect(input.getAttribute('aria-expanded')).toBe('false')
  document.querySelector('#global-search-results')!.outerHTML = RESULTS
  await settle()
  expect(input.getAttribute('aria-expanded')).toBe('true')

  press(input, 'ArrowDown')
  expect(input.getAttribute('aria-activedescendant')).toBe('global-search-opt-0')
  expect(document.querySelector('#global-search-opt-0 a')!.classList.contains('menu-active')).toBe(true)
  press(input, 'ArrowDown')
  expect(input.getAttribute('aria-activedescendant')).toBe('global-search-opt-1')
  expect(document.querySelector('#global-search-opt-0 a')!.classList.contains('menu-active')).toBe(false)
  press(input, 'ArrowUp')
  expect(input.getAttribute('aria-activedescendant')).toBe('global-search-opt-0')

  let followed = ''
  document.addEventListener('click', (e) => {
    const link = (e.target as Element).closest('a')
    if (link) {
      followed = link.getAttribute('href') ?? ''
      e.preventDefault()
    }
  })
  const enter = press(input, 'Enter')
  expect(enter.defaultPrevented).toBe(true)
  expect(followed).toBe('/admin/documents/a')

  input.value = 'hello'
  press(input, 'Escape')
  expect(input.value).toBe('')
  expect(input.getAttribute('aria-expanded')).toBe('false')
  expect(input.hasAttribute('aria-activedescendant')).toBe(false)
  expect(document.querySelector<HTMLElement>('#global-search-results')!.hidden).toBe(true)
})

it('closes when you click outside the search', async () => {
  const input = mount(RESULTS)
  expect(input.getAttribute('aria-expanded')).toBe('true')
  document.querySelector<HTMLElement>('#global-search-opt-0')!.click()
  expect(input.getAttribute('aria-expanded')).toBe('true')
  document.querySelector<HTMLElement>('#outside')!.click()
  expect(input.getAttribute('aria-expanded')).toBe('false')
  expect(document.querySelector<HTMLElement>('#global-search-results')!.hidden).toBe(true)
})

/** Records where clicking a result link would go, instead of going there. */
function followed(): { href: string } {
  const seen = { href: '' }
  document.addEventListener('click', (e) => {
    const link = (e.target as Element).closest('a')
    if (link) {
      seen.href = link.getAttribute('href') ?? ''
      e.preventDefault()
    }
  })
  return seen
}

it('forgets the highlighted result when new results come in', async () => {
  const input = mount(RESULTS)
  press(input, 'ArrowDown')
  press(input, 'ArrowDown')
  expect(input.getAttribute('aria-activedescendant')).toBe('global-search-opt-1')

  document.querySelector('#global-search-results')!.outerHTML = results('new-')
  await settle()
  expect(input.hasAttribute('aria-activedescendant')).toBe(false)
  const seen = followed()
  const enter = press(input, 'Enter')
  expect(enter.defaultPrevented).toBe(false)
  expect(seen.href).toBe('')

  press(input, 'ArrowDown')
  expect(input.getAttribute('aria-activedescendant')).toBe('global-search-opt-0')
  press(input, 'Enter')
  expect(seen.href).toBe('/admin/documents/new-a')
})

it('forgets the highlighted result as soon as you type, even if the same ids come back', async () => {
  const input = mount(RESULTS)
  press(input, 'ArrowDown')
  expect(input.getAttribute('aria-activedescendant')).toBe('global-search-opt-0')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  expect(input.hasAttribute('aria-activedescendant')).toBe(false)
  expect(document.querySelector('#global-search-opt-0')!.getAttribute('aria-selected')).toBe('false')

  // A stale id left on the box does not count once its option is no longer highlighted.
  input.setAttribute('aria-activedescendant', 'global-search-opt-1')
  const enter = press(input, 'Enter')
  expect(enter.defaultPrevented).toBe(false)
})

it('is not expanded when nothing matched, but still closes', async () => {
  const input = mount(NONE)
  expect(input.getAttribute('aria-expanded')).toBe('false')
  const down = press(input, 'ArrowDown')
  expect(down.defaultPrevented).toBe(false)
  document.querySelector<HTMLElement>('#outside')!.click()
  expect(document.querySelector<HTMLElement>('#global-search-results')!.hidden).toBe(true)
})
