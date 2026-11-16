// The publish dialog end to end: the real editor page and publish routes, with the dialog's requests sent to the app.
// It runs in Node, since the app finds its assets by file URL, with a happy-dom window for the page.
import { Window } from 'happy-dom'
import { initPublishDialog } from '../../client/admin/publish.js'
import { t } from '../../src/core/messages/index.js'
import { signIn } from '../helpers/admin.js'
import { makeApp } from '../helpers/app.js'

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** A browser window at `url` showing `html`, with the DOM classes the dialog script uses as globals. */
function browse(url: string, html: string): Window {
  const window = new Window({ url })
  window.document.write(html)
  for (const name of [
    'DOMParser',
    'Element',
    'HTMLElement',
    'HTMLDialogElement',
    'HTMLFormElement',
    'HTMLButtonElement',
    'HTMLAnchorElement',
    'HTMLDetailsElement',
    'FormData',
    'CustomEvent',
  ] as const) {
    vi.stubGlobal(name, window[name])
  }
  return window
}

afterEach(() => vi.unstubAllGlobals())

it('saves and publishes from the editor without leaving it', async () => {
  const { app, core } = await makeApp({ withOwner: true })
  const owner = await signIn(app, 'owner@example.com')
  const home = (await core.findSingleton('home', 'en'))!
  const editor = `/admin/documents/${home.id}`

  const window = browse(`https://example.com${editor}`, (await owner.get(editor)).body)
  const document = window.document as unknown as Document
  const sent: string[] = []
  // The browser's fetch: requests go to the app, following its redirects.
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    let url = new URL(input, window.location.href)
    sent.push(`${init.method ?? 'GET'} ${url.pathname}`)
    let res =
      init.method === 'POST'
        ? await owner.post(url.pathname, new URLSearchParams(String(init.body)))
        : await owner.get(`${url.pathname}${url.search}`)
    while (res.statusCode === 303) {
      url = new URL(res.headers.location as string, url)
      res = await owner.get(`${url.pathname}${url.search}`)
    }
    return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'text/html' } })
  })
  const reload = vi.fn()
  const submit = vi.spyOn(window.HTMLFormElement.prototype, 'requestSubmit')
  initPublishDialog(document, { reload })

  document.querySelector<HTMLInputElement>('#editor-form [name="fields.title"]')!.value = 'Home again'
  document.querySelector<HTMLButtonElement>('button[name="_action"][value="publish"]')!.click()
  await settle()

  expect(submit).not.toHaveBeenCalled()
  expect(sent).toEqual([`POST ${editor}`, 'GET /admin/publish'])
  const saved = (await core.getDocument(home.id))!
  expect(saved.data.fields.title).toBe('Home again')
  expect(document.querySelector<HTMLInputElement>('#editor-form input[name="base"]')!.value).toBe(String(saved.headRev))
  const dialog = document.querySelector<HTMLDialogElement>('#publish-dialog')!
  expect(dialog.open).toBe(true)
  expect(document.querySelector('#publish-panel')!.getAttribute('data-state')).toBe('review')

  document.querySelector<HTMLButtonElement>('#publish-dialog-body form button[type="submit"]')!.click()
  await settle()
  expect(document.querySelector('#publish-panel')!.getAttribute('data-state')).toBe('done')
  const published = (await core.getDocument(home.id))!
  expect(published.publishedRev).toBe(published.headRev)

  document.querySelector<HTMLElement>('#publish-dialog-body [data-dialog-cancel]')!.click()
  await settle()
  expect(dialog.open).toBe(false)
  expect(reload).not.toHaveBeenCalled()
  expect(sent.at(-1)).toBe(`GET ${editor}`)
  expect(document.querySelector('#editor-status')!.textContent).toContain(t('admin.status.published'))
  expect(window.location.pathname + window.location.search).toBe(editor)
  await app.close()
})
