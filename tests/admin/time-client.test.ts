// @vitest-environment happy-dom
import { localiseTimes } from '../../client/admin/time.js'

const NOW = new Date('2026-11-02T10:00:00Z')
const DAY = 86_400_000

function mount(iso: string, relative: boolean): HTMLTimeElement {
  document.body.innerHTML = `<time datetime="${iso}" data-local${relative ? ' data-relative' : ''}>x UTC</time>`
  localiseTimes(document, NOW)
  return document.querySelector('time')!
}

describe('localiseTimes', () => {
  it('writes recent times relatively', () => {
    const el = mount(new Date(NOW.getTime() - 2 * DAY).toISOString(), true)
    expect(el.textContent).toMatch(/2 days ago/)
    expect(el.title).not.toBe('')
  })

  it('writes old times as a date', () => {
    const el = mount(new Date(NOW.getTime() - 40 * DAY).toISOString(), true)
    expect(el.textContent).not.toMatch(/ago/)
    expect(el.textContent).toMatch(/2026/)
  })

  it('leaves absolute times absolute', () => {
    const el = mount(new Date(NOW.getTime() - 2 * DAY).toISOString(), false)
    expect(el.textContent).not.toMatch(/ago/)
    expect(el.textContent).not.toBe('x UTC')
  })
})
