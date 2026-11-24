// @vitest-environment happy-dom
import { keepNavScroll } from '../../client/admin/nav-scroll.js'

function mount(): HTMLElement {
  document.body.innerHTML = '<div id="admin-nav"></div>'
  return document.getElementById('admin-nav')!
}

const leave = () => window.dispatchEvent(new Event('pagehide'))

beforeEach(() => sessionStorage.clear())

describe('keepNavScroll', () => {
  it('puts the menu back where it was on the page before', () => {
    const before = mount()
    keepNavScroll()
    before.scrollTop = 240
    leave()
    const after = mount()
    expect(after.scrollTop).toBe(0)
    keepNavScroll()
    expect(after.scrollTop).toBe(240)
  })

  it('leaves the saved place alone on a page without a menu', () => {
    const before = mount()
    keepNavScroll()
    before.scrollTop = 240
    leave()
    document.body.innerHTML = '<main></main>'
    keepNavScroll()
    leave()
    const after = mount()
    keepNavScroll()
    expect(after.scrollTop).toBe(240)
  })

  it('ignores a saved place it cannot read', () => {
    sessionStorage.setItem('inlay:nav', 'nonsense')
    const nav = mount()
    keepNavScroll()
    expect(nav.scrollTop).toBe(0)
  })
})
