// @vitest-environment happy-dom
// happy-dom has no XPathEvaluator, which htmx creates when it loads (to find `hx-on` attributes).
vi.hoisted(() => {
  Object.assign(globalThis, {
    XPathEvaluator: class {
      createExpression() {
        return { evaluate: () => ({ iterateNext: () => null }) }
      }
    },
  })
})

import { createPageWriter, createUpdater, fitScale, slotElements, slotOf, type PreviewResult } from '../../client/admin/preview.js'

const SIGNED_OUT = 'You were signed out.'
const FAILED = 'The preview failed.'

function formWith(value: string): HTMLFormElement {
  const form = document.createElement('form')
  form.innerHTML = `<input name="fields.title" value="${value}">`
  return form
}

const page = (html: string) => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, getForm: () => HTMLFormElement | null = () => formWith('Hi')) {
  const fetch = vi.fn(fetchImpl)
  const results: PreviewResult[] = []
  const onStart = vi.fn()
  const updater = createUpdater({
    url: '/admin/documents/x/preview',
    getForm,
    delay: 400,
    fetch: fetch as unknown as typeof globalThis.fetch,
    signedOutMessage: SIGNED_OUT,
    failedMessage: FAILED,
    onStart,
    onResult: (r) => results.push(r),
  })
  return { fetch, results, onStart, updater }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('preview client', () => {
  it('posts once after changes settle', async () => {
    const { fetch, results, updater } = setup(async () => page('<p>ok</p>'))
    updater.schedule()
    await vi.advanceTimersByTimeAsync(100)
    updater.schedule()
    await vi.advanceTimersByTimeAsync(100)
    updater.schedule()
    await vi.advanceTimersByTimeAsync(400)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('/admin/documents/x/preview')
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', credentials: 'same-origin' })
    expect(results).toEqual([{ kind: 'page', html: '<p>ok</p>' }])
  })

  it('aborts an older request and ignores its late answer', async () => {
    let releaseFirst: (r: Response) => void = () => {}
    let calls = 0
    const { fetch, results, updater } = setup((_url, _init) => {
      calls++
      if (calls === 1) return new Promise<Response>((resolve) => (releaseFirst = resolve))
      return Promise.resolve(page('<p>second</p>'))
    })
    updater.schedule()
    await vi.advanceTimersByTimeAsync(400)
    updater.schedule()
    await vi.advanceTimersByTimeAsync(400)
    expect(fetch).toHaveBeenCalledTimes(2)
    releaseFirst(page('<p>first</p>'))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(true)
    expect(fetch.mock.calls[1]![1].signal!.aborted).toBe(false)
    expect(results).toEqual([{ kind: 'page', html: '<p>second</p>' }])
  })

  it('posts the current form after htmx replaced it', async () => {
    let form = formWith('Old')
    const { fetch, updater } = setup(async () => page(''), () => form)
    updater.schedule()
    form = formWith('New')
    await vi.advanceTimersByTimeAsync(400)
    const body = fetch.mock.calls[0]![1].body
    expect(body).toBeInstanceOf(URLSearchParams)
    expect((body as URLSearchParams).get('fields.title')).toBe('New')
  })

  it('posts the form urlencoded, with every value', async () => {
    const form = document.createElement('form')
    form.innerHTML = `<input name="fields.title" value="A &amp; B">
      <input name="fields.tags" value="x"><input name="fields.tags" value="y">
      <input type="checkbox" name="fields.featured" value="on">`
    const { fetch, updater } = setup(async () => page(''), () => form)
    updater.schedule()
    await vi.advanceTimersByTimeAsync(400)
    const request = new Request('https://example.com/', { method: 'POST', body: fetch.mock.calls[0]![1].body })
    expect(request.headers.get('content-type')).toBe('application/x-www-form-urlencoded;charset=UTF-8')
    expect(await request.text()).toBe('fields.title=A+%26+B&fields.tags=x&fields.tags=y')
  })

  it('reads 422 and 500 answers as messages', async () => {
    const answers = [json(422, { message: 'Fill this in: Headline' }), json(500, { message: 'Broken' }), new Response('', { status: 404 })]
    const { results, updater } = setup(async () => answers.shift()!)
    for (let i = 0; i < 3; i++) {
      updater.schedule()
      await vi.advanceTimersByTimeAsync(400)
    }
    expect(results).toEqual([
      { kind: 'incomplete', message: 'Fill this in: Headline' },
      { kind: 'error', message: 'Broken' },
      { kind: 'error', message: FAILED },
    ])
  })

  it('treats a redirect or 401 as signed out', async () => {
    const redirect = { type: 'opaqueredirect', status: 0, ok: false } as Response
    const answers = [redirect, new Response('', { status: 401 })]
    const { results, updater } = setup(async () => answers.shift()!)
    for (let i = 0; i < 2; i++) {
      updater.schedule()
      await vi.advanceTimersByTimeAsync(400)
    }
    expect(results).toEqual([
      { kind: 'error', message: SIGNED_OUT },
      { kind: 'error', message: SIGNED_OUT },
    ])
  })

  it('stops after dispose', async () => {
    const { fetch, updater } = setup(async () => page(''))
    updater.schedule()
    updater.dispose()
    await vi.advanceTimersByTimeAsync(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('finds slot elements between markers', () => {
    const doc = new DOMParser().parseFromString(
      '<!doctype html><html><body><main><!--inlay:slot hero--><section id=a></section><p id=b><em>x</em></p><!--/inlay:slot hero-->text<!--inlay:slot quotes--><section id=c></section><!--/inlay:slot quotes--></main></body></html>',
      'text/html',
    )
    const slots = slotElements(doc)
    expect([...slots.keys()]).toEqual(['hero', 'quotes'])
    expect(slots.get('hero')!.map((el) => el.id)).toEqual(['a', 'b'])
    expect(slots.get('quotes')!.map((el) => el.id)).toEqual(['c'])
    expect(slotOf(doc, doc.querySelector('#b em')!)).toBe('hero')
    const text = [...doc.querySelector('main')!.childNodes].find((n) => n.nodeType === 3)!
    expect(text.nodeValue).toBe('text')
    expect(slotOf(doc, text)).toBeNull()
  })

  it('scales to fit', () => {
    expect(fitScale(800, 1280)).toBe(0.625)
    expect(fitScale(800, 390)).toBe(1)
  })

  it('sends the open items and closed cards with a list button request', () => {
    document.body.innerHTML = `<form id="editor-form">
      <details data-card="fields" open></details>
      <details data-card="hero"><details data-item="slots.hero.data.items.0" open></details><details data-item="slots.hero.data.items.1"></details></details>
      <details data-card="quotes"></details>
      <button id="op"></button>
    </form>`
    const formData = new FormData()
    document.getElementById('op')!.dispatchEvent(
      new CustomEvent('htmx:configRequest', { bubbles: true, detail: { elt: document.getElementById('op'), formData } }),
    )
    expect(formData.get('_open')).toBe('slots.hero.data.items.0')
    expect(formData.get('_closed')).toBe('hero,quotes')
  })

  it('marks the page as having unsaved changes when the form changes', () => {
    document.body.innerHTML = `<span id="save-state" data-text-unsaved="Unsaved changes">Last saved</span><form id="editor-form"><input name="x"></form>`
    document.querySelector('input')!.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.getElementById('save-state')!.textContent).toBe('Unsaved changes')
  })
})

describe('preview page writer', () => {
  const BLANK = '/admin/documents/x/preview/blank'

  /** An iframe whose window and document are stand-ins that record what the writer does. */
  /** A stand-in `<link rel="stylesheet">`: `loaded` ones already have their sheet. */
  const sheetLink = (loaded = false) => Object.assign(new EventTarget(), { sheet: loaded ? {} : null })

  function fakeFrame(links: Array<ReturnType<typeof sheetLink>> = []) {
    const frame = document.createElement('iframe')
    const calls: string[] = []
    const location = {
      href: 'https://example.com/admin/documents/x/preview/blank',
      replace: vi.fn((url: string) => {
        location.href = new URL(url, 'https://example.com').href
      }),
    }
    const win = { location, history: { replaceState: (_s: unknown, _t: string, url: string) => calls.push(`path ${url}`) } }
    const doc = {
      open: () => calls.push('open'),
      write: (html: string) => calls.push(`write ${html}`),
      close: () => calls.push('close'),
      querySelectorAll: (selector: string) => (selector === 'link[rel~="stylesheet"]' ? links : []),
    }
    Object.defineProperty(frame, 'contentWindow', { get: () => win })
    Object.defineProperty(frame, 'contentDocument', { get: () => doc })
    const load = (n?: number) => {
      if (n !== undefined) location.href = `https://example.com${BLANK}?n=${n}`
      frame.dispatchEvent(new Event('load'))
    }
    return { frame, calls, location, load }
  }

  function writerFor(frame: HTMLIFrameElement) {
    const onSwap = vi.fn()
    const writer = createPageWriter({ blankUrl: BLANK, pagePath: '/about', back: () => frame, onSwap, fallbackMs: 1000 })
    return { writer, onSwap }
  }

  it('loads a fresh empty page before each write, then writes the page at its own address and shows it', () => {
    const { frame, calls, location, load } = fakeFrame()
    const { writer, onSwap } = writerFor(frame)
    writer.write('<p>A</p>')
    expect(location.replace).toHaveBeenCalledWith(`${BLANK}?n=1`)
    expect(calls).toEqual([])
    load()
    expect(calls).toEqual(['open', 'path /about', 'write <p>A</p>', 'close'])
    // Browsers fire no load event for a written page, so nothing may wait for one.
    expect(onSwap).toHaveBeenCalledTimes(1)

    writer.write('<p>B</p>')
    expect(location.replace).toHaveBeenLastCalledWith(`${BLANK}?n=2`)
    load()
    expect(calls.slice(4)).toEqual(['open', 'path /about', 'write <p>B</p>', 'close'])
    expect(onSwap).toHaveBeenCalledTimes(2)
  })

  it('keeps only the latest write', () => {
    const { frame, calls, load } = fakeFrame()
    const { writer, onSwap } = writerFor(frame)
    writer.write('<p>A</p>')
    writer.write('<p>B</p>')
    load(1)
    expect(calls).toEqual([])
    expect(onSwap).not.toHaveBeenCalled()
    load(2)
    expect(calls).toEqual(['open', 'path /about', 'write <p>B</p>', 'close'])
    expect(onSwap).toHaveBeenCalledTimes(1)
  })

  it('waits for the page\'s stylesheets before showing it, counting a failed one as done', () => {
    const css = sheetLink()
    const broken = sheetLink()
    const { frame, load } = fakeFrame([css, sheetLink(true), broken])
    const { writer, onSwap } = writerFor(frame)
    writer.write('<p>A</p>')
    load()
    expect(onSwap).not.toHaveBeenCalled()
    css.dispatchEvent(new Event('load'))
    expect(onSwap).not.toHaveBeenCalled()
    broken.dispatchEvent(new Event('error'))
    expect(onSwap).toHaveBeenCalledTimes(1)
  })

  it('shows the page anyway when a stylesheet never loads', async () => {
    const css = sheetLink()
    const { frame, load } = fakeFrame([css])
    const { writer, onSwap } = writerFor(frame)
    writer.write('<p>A</p>')
    load()
    await vi.advanceTimersByTimeAsync(999)
    expect(onSwap).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onSwap).toHaveBeenCalledTimes(1)
    css.dispatchEvent(new Event('load'))
    expect(onSwap).toHaveBeenCalledTimes(1)
  })

  it('drops a written page still waiting for its stylesheets when canceled', async () => {
    const css = sheetLink()
    const { frame, calls, load } = fakeFrame([css])
    const { writer, onSwap } = writerFor(frame)
    writer.write('<p>A</p>')
    load()
    expect(calls).toContain('write <p>A</p>')
    writer.cancel()
    css.dispatchEvent(new Event('load'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(onSwap).not.toHaveBeenCalled()
  })
})
