// @vitest-environment happy-dom
import { initCopyButtons } from '../../client/admin/copy.js'

afterEach(() => vi.unstubAllGlobals())

describe('initCopyButtons', () => {
  it('copies the named field and confirms', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    document.body.innerHTML = `<input id="addr" value="https://example.com/media/1" readonly>
      <button type="button" data-copy="addr" data-copied="Copied">Copy</button>`
    initCopyButtons()
    const button = document.querySelector('button')!
    button.click()
    await Promise.resolve()
    await Promise.resolve()
    expect(writeText).toHaveBeenCalledWith('https://example.com/media/1')
    expect(button.textContent).toBe('Copied')
  })

  it('selects the field when there is no clipboard', () => {
    vi.stubGlobal('navigator', {})
    document.body.innerHTML = `<input id="addr2" value="https://example.com/media/2" readonly>
      <button type="button" data-copy="addr2" data-copied="Copied">Copy</button>`
    initCopyButtons()
    const input = document.querySelector('input')!
    expect(() => document.querySelector('button')!.click()).not.toThrow()
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
  })

  it('selects the field when copying is refused', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    document.body.innerHTML = `<input id="addr3" value="https://example.com/media/3" readonly>
      <button type="button" data-copy="addr3" data-copied="Copied">Copy</button>`
    initCopyButtons()
    const button = document.querySelector('button')!
    button.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(document.activeElement).toBe(document.querySelector('input'))
    expect(button.textContent).toBe('Copy')
  })
})
