const KEY = 'inlay-consent'
const MAX_AGE = 365 * 24 * 60 * 60 * 1000
const CATEGORIES = ['analytics', 'marketing', 'functional'] as const
type Category = (typeof CATEGORIES)[number]

type Choice = Record<Category, boolean>
export type Consent = Choice & { decided: boolean }

const isCategory = (value: string): value is Category => (CATEGORIES as readonly string[]).includes(value)

export function install(win: Window): void {
  const doc = win.document
  let memory: (Choice & { at: number }) | null = null

  function read(): (Choice & { at: number }) | null {
    let stored: (Choice & { at: number }) | null = memory
    try {
      const raw = win.localStorage.getItem(KEY)
      if (raw !== null) {
        const data = JSON.parse(raw) as Partial<Choice & { at: number }> | null
        if (data && typeof data.at === 'number') {
          stored = { at: data.at, analytics: data.analytics === true, marketing: data.marketing === true, functional: data.functional === true }
        }
      }
    } catch {
      // unreadable or blocked storage counts as no stored choice
    }
    if (!stored || Date.now() - stored.at > MAX_AGE || Date.now() < stored.at - 60000) return null
    return stored
  }

  function get(): Consent {
    const stored = read()
    return {
      decided: stored !== null,
      analytics: stored?.analytics ?? false,
      marketing: stored?.marketing ?? false,
      functional: stored?.functional ?? false,
    }
  }

  /** A copy of `old` the browser will run once inserted; a parsed-in script never would. */
  function runnable(old: HTMLScriptElement): HTMLScriptElement {
    const script = doc.createElement('script')
    for (const attr of Array.from(old.attributes)) script.setAttribute(attr.name, attr.value)
    script.text = old.text
    return script
  }

  const isScript = (node: Node): node is HTMLScriptElement => node.nodeName === 'SCRIPT'

  /** An external script the browser fetches and runs, so it fires `load` or `error`, and one that keeps its place: no `async`. */
  const blocks = (node: Node): node is HTMLScriptElement => {
    if (!isScript(node) || !node.hasAttribute('src') || node.hasAttribute('async') || node.hasAttribute('nomodule')) return false
    const type = (node.getAttribute('type') ?? '').trim().toLowerCase()
    return type === '' || type === 'module' || /^(text|application)\/(x-)?(javascript|ecmascript)$/.test(type)
  }

  /** Runs once `script` has loaded or failed. */
  const settled = (script: HTMLScriptElement) =>
    new Promise<void>((resolve) => {
      script.addEventListener('load', () => resolve(), { once: true })
      script.addEventListener('error', () => resolve(), { once: true })
    })

  /**
   * Puts the template's nodes in its place one by one, in document order. An
   * external script without `async` holds back what follows it until it has
   * loaded or failed, as it would have in the page. The template leaves the
   * document at once, so it is released only once.
   */
  async function releaseTemplate(template: HTMLTemplateElement): Promise<void> {
    const marker = doc.createComment('')
    template.replaceWith(marker)
    const content = doc.importNode(template.content, true)
    for (const original of Array.from(content.childNodes)) {
      if (original.nodeType === 1) for (const old of Array.from((original as Element).querySelectorAll('script'))) old.replaceWith(runnable(old))
      const node = isScript(original) ? runnable(original) : original
      if (blocks(node)) node.async = false
      const done = blocks(node) ? settled(node) : null
      marker.before(node)
      if (done) await done
    }
    marker.remove()
  }

  function release(): void {
    const current = get()
    for (const template of Array.from(doc.querySelectorAll<HTMLTemplateElement>('template[data-inlay-consent]'))) {
      const category = template.getAttribute('data-inlay-consent') ?? ''
      if (!isCategory(category) || !current[category] || !template.parentNode) continue
      void releaseTemplate(template)
    }
  }

  function change(categories: string[] | 'all', value: boolean): void {
    const names = categories === 'all' ? [...CATEGORIES] : categories.filter(isCategory)
    const next = { at: Date.now(), ...get() } as Choice & { at: number; decided?: boolean }
    delete next.decided
    for (const name of names) next[name] = value
    memory = next
    try {
      win.localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // the choice then holds for this page only
    }
    release()
    announce()
  }

  function announce(): void {
    doc.dispatchEvent(new (win as unknown as typeof globalThis).CustomEvent('inlay:consent', { detail: get() }))
  }

  const w = win as Window & { inlay?: { consent?: unknown } }
  w.inlay = { ...w.inlay, consent: { grant: (c: string[] | 'all') => change(c, true), revoke: (c: string[] | 'all') => change(c, false), get } }

  const start = () => {
    release()
    announce()
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
}
