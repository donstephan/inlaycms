// @vitest-environment happy-dom
import { install } from '../../client/site/consent.js'

const KEY = 'inlay-consent'
const BODY =
  '<p id="a"></p><template data-inlay-consent="marketing"><script src="/public/m.js" async></script><img id="px" src="/public/p.gif"></template><template data-inlay-consent="analytics"><script>window.an=1</script></template>'

interface Consent {
  decided: boolean
  analytics: boolean
  marketing: boolean
  functional: boolean
}
interface Api {
  grant(categories: string[] | 'all'): void
  revoke(categories: string[] | 'all'): void
  get(): Consent
}
const api = () => (window as unknown as { inlay: { consent: Api } }).inlay.consent

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = BODY
  vi.restoreAllMocks()
})

describe('consent client', () => {
  it('before any choice: undecided, everything false, templates left alone', () => {
    install(window)
    expect(api().get()).toEqual({ decided: false, analytics: false, marketing: false, functional: false })
    expect(document.querySelectorAll('template')).toHaveLength(2)
  })

  it('grant releases matching templates in place, once', () => {
    install(window)
    const original = document.querySelector<HTMLTemplateElement>('template[data-inlay-consent="marketing"]')!.content.querySelector('script')
    api().grant(['marketing'])
    expect(document.querySelector('template[data-inlay-consent="marketing"]')).toBeNull()
    expect(document.querySelector('template[data-inlay-consent="analytics"]')).not.toBeNull()
    const a = document.getElementById('a')!
    const script = a.nextElementSibling as HTMLScriptElement
    expect(script.tagName).toBe('SCRIPT')
    expect(script.getAttribute('src')).toBe('/public/m.js')
    expect(script.hasAttribute('async')).toBe(true)
    expect(script).not.toBe(original)
    expect(script.nextElementSibling?.id).toBe('px')
    api().grant(['marketing'])
    expect(document.querySelectorAll('script[src="/public/m.js"]')).toHaveLength(1)
    expect(document.querySelectorAll('#px')).toHaveLength(1)
  })

  it("grant('all') releases every category", () => {
    install(window)
    api().grant('all')
    expect(document.querySelectorAll('template')).toHaveLength(0)
    expect(api().get()).toEqual({ decided: true, analytics: true, marketing: true, functional: true })
  })

  it('a stored grant releases on install', () => {
    install(window)
    api().grant(['marketing'])
    document.body.innerHTML = BODY
    install(window)
    expect(document.querySelector('template[data-inlay-consent="marketing"]')).toBeNull()
    expect(document.querySelector('template[data-inlay-consent="analytics"]')).not.toBeNull()
  })

  it('revoke records the choice and get() reflects it', () => {
    install(window)
    api().grant('all')
    api().revoke(['marketing'])
    expect(api().get()).toEqual({ decided: true, analytics: true, marketing: false, functional: true })
  })

  it('unknown categories are ignored', () => {
    install(window)
    api().grant(['nope', 'marketing'])
    expect(api().get()).toEqual({ decided: true, analytics: false, marketing: true, functional: false })
  })

  it('a choice older than 365 days counts as undecided', () => {
    localStorage.setItem(KEY, JSON.stringify({ at: Date.now() - 366 * 86400000, analytics: true, marketing: true, functional: true }))
    install(window)
    expect(api().get().decided).toBe(false)
    expect(document.querySelectorAll('template')).toHaveLength(2)
  })

  it('unreadable stored data counts as undecided', () => {
    localStorage.setItem(KEY, '{nope')
    install(window)
    expect(api().get().decided).toBe(false)
  })

  it('inlay:consent fires on install, grant and revoke with get() as detail', () => {
    const seen: Consent[] = []
    document.addEventListener('inlay:consent', (e) => seen.push((e as CustomEvent<Consent>).detail))
    install(window)
    api().grant(['analytics'])
    api().revoke(['analytics'])
    expect(seen).toHaveLength(3)
    expect(seen[0]?.decided).toBe(false)
    expect(seen[1]?.analytics).toBe(true)
    expect(seen[2]?.analytics).toBe(false)
  })

  describe('document order within a template', () => {
    const ORDERED =
      '<p id="a"></p><template data-inlay-consent="analytics"><script src="/slow.js"></script><span id="s1"></span><script src="/fast.js"></script><script>window.inl=1</script><i id="end"></i></template>'
    const inDoc = (selector: string) => document.querySelector(selector) !== null
    const settle = () => new Promise((r) => setTimeout(r, 0))
    // happy-dom loads no script files and reports each one failed; only the events fired here may reach the scripts
    const ours = new WeakSet<Event>()
    const fire = (selector: string, type: 'load' | 'error') => {
      const event = new Event(type)
      ours.add(event)
      document.querySelector(selector)!.dispatchEvent(event)
    }
    const swallow = (e: Event) => {
      if (!ours.has(e)) e.stopImmediatePropagation()
    }
    beforeEach(() => {
      window.addEventListener('load', swallow, true)
      window.addEventListener('error', swallow, true)
    })
    afterEach(() => {
      window.removeEventListener('load', swallow, true)
      window.removeEventListener('error', swallow, true)
    })

    it('holds later nodes back until a blocking script loads or fails, and ends in template order', async () => {
      document.body.innerHTML = ORDERED
      install(window)
      api().grant(['analytics'])
      await settle()
      expect(document.querySelector('template')).toBeNull()
      expect(inDoc('script[src="/slow.js"]')).toBe(true)
      expect((document.querySelector('script[src="/slow.js"]') as HTMLScriptElement).async).toBe(false)
      expect(inDoc('#s1')).toBe(false)
      expect(inDoc('script[src="/fast.js"]')).toBe(false)
      fire('script[src="/slow.js"]', 'load')
      await settle()
      expect(inDoc('#s1')).toBe(true)
      expect(inDoc('script[src="/fast.js"]')).toBe(true)
      expect(document.querySelectorAll('script:not([src])')).toHaveLength(0)
      expect(inDoc('#end')).toBe(false)
      fire('script[src="/fast.js"]', 'error')
      await settle()
      expect(inDoc('#end')).toBe(true)
      const order = Array.from(document.body.children).map((el) => el.id || el.getAttribute('src') || `inline:${el.textContent}`)
      expect(order).toEqual(['a', '/slow.js', 's1', '/fast.js', 'inline:window.inl=1', 'end'])
    })

    it('an async external script does not hold up what follows it', async () => {
      document.body.innerHTML =
        '<template data-inlay-consent="analytics"><script src="/a.js" async></script><i id="after"></i></template>'
      install(window)
      api().grant(['analytics'])
      await settle()
      expect(inDoc('script[src="/a.js"]')).toBe(true)
      expect(inDoc('#after')).toBe(true)
    })

    it('a script the browser will not run (another type, nomodule) does not hold up what follows it', async () => {
      document.body.innerHTML =
        '<template data-inlay-consent="analytics"><script type="text/plain" src="/p.js"></script><script nomodule src="/n.js"></script><i id="after"></i></template>'
      install(window)
      api().grant(['analytics'])
      await settle()
      expect(inDoc('#after')).toBe(true)
    })

    it('templates are independent, and a second grant while one waits releases nothing twice', async () => {
      document.body.innerHTML = `${ORDERED}<template data-inlay-consent="marketing"><b id="m"></b></template>`
      install(window)
      api().grant(['analytics'])
      api().grant(['marketing'])
      await settle()
      expect(inDoc('#m')).toBe(true)
      expect(document.querySelectorAll('script[src="/slow.js"]')).toHaveLength(1)
      fire('script[src="/slow.js"]', 'load')
      await settle()
      fire('script[src="/fast.js"]', 'load')
      await settle()
      expect(document.querySelectorAll('#s1')).toHaveLength(1)
      expect(document.querySelectorAll('#end')).toHaveLength(1)
    })
  })

  it('works when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    install(window)
    expect(() => api().grant(['marketing'])).not.toThrow()
    expect(document.querySelector('template[data-inlay-consent="marketing"]')).toBeNull()
  })
})
