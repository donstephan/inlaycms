// @vitest-environment happy-dom
import { initLengthCounters } from '../../client/admin/length.js'

function mount(): { input: HTMLInputElement; count: Element; hint: Element } {
  document.body.innerHTML = `<input id="f" type="text">
    <p id="f-length" data-length-for="f" data-suggested-length="5" data-label="{count} of 5 characters">
      <span data-length-count>0 of 5 characters</span>
      <span data-length-hint hidden>Too long</span>
    </p>`
  initLengthCounters(document)
  return { input: document.querySelector('input')!, count: document.querySelector('[data-length-count]')!, hint: document.querySelector('[data-length-hint]')! }
}

const type = (input: HTMLInputElement, value: string) => {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('initLengthCounters', () => {
  it('counts as the editor types', () => {
    const { input, count, hint } = mount()
    type(input, 'abc')
    expect(count.textContent).toBe('3 of 5 characters')
    expect(hint.hasAttribute('hidden')).toBe(true)
  })

  it('shows the hint past the suggestion and hides it again', () => {
    const { input, hint } = mount()
    type(input, 'abcdef')
    expect(hint.hasAttribute('hidden')).toBe(false)
    type(input, 'abcde')
    expect(hint.hasAttribute('hidden')).toBe(true)
  })
})
