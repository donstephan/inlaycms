// @vitest-environment happy-dom
import { initPublishDialog } from '../../client/admin/publish.js'
import { t } from '../../src/core/messages/index.js'
import { PublishDialog } from '../../src/adapters/admin/views/layout.js'
import { renderToString } from '../../src/jsx/html.js'

const page = (html: string) => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })

/** A publish page with `panel` as its `#publish-panel`, the way the dialog receives it. */
const panelPage = (state: string, title: string, inner: string) =>
  page(`<!doctype html><html><body><h1>${title}</h1><div id="publish-panel" data-state="${state}" data-title="${title}">${inner}</div></body></html>`)

const REVIEW = () =>
  panelPage(
  'review',
  'Publish changes',
  `<ul><li>Home (en)</li></ul><form method="post" action="/admin/publish" data-busy-label="Publishing…">` +
    `<input type="hidden" name="ids" value="h1"><input type="hidden" name="expect" value='{"h1":3}'>` +
    `<button type="submit">Publish</button><a href="/admin" class="btn" data-dialog-cancel>Cancel</a></form>`,
)
const DONE = () =>
  panelPage(
  'done',
  'Published',
  `<ul><li><a href="/">Home (en)</a></li></ul><p><a href="/admin" data-dialog-cancel data-dialog-label="Close">Back to the start page</a></p>`,
)
const CHANGED = () =>
  panelPage('changed', 'Nothing was published', `<p><a href="/admin/publish?ids=h1&amp;action=publish">See the latest changes</a></p>`)

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
const reload = vi.fn()

const dialog = () => document.querySelector<HTMLDialogElement>('#publish-dialog')!
const body = () => document.querySelector<HTMLElement>('#publish-dialog-body')!
const heading = () => document.querySelector<HTMLElement>('#publish-dialog-title')!.textContent
const shownIcons = () => [...document.querySelectorAll<HTMLElement>('[data-state-icon]')].filter((i) => !i.hidden).map((i) => i.dataset.stateIcon)
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function mount(extra: string): Promise<void> {
  document.body.innerHTML = extra + (await renderToString(PublishDialog()))
  initPublishDialog(document, { reload })
}

beforeEach(() => {
  fetchMock.mockReset()
  reload.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('the publish dialog', () => {
  it('opens a publish link in the dialog with the review it loads', async () => {
    await mount('<a id="go" href="/admin/publish" data-publish-dialog>Publish</a>')
    fetchMock.mockResolvedValueOnce(REVIEW())
    document.getElementById('go')!.click()
    expect(dialog().open).toBe(true)
    await settle()
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/admin\/publish$/)
    expect(heading()).toBe('Publish changes')
    expect(shownIcons()).toEqual(['review'])
    expect(body().querySelector('#publish-panel li')!.textContent).toBe('Home (en)')
    expect(document.activeElement?.textContent).toBe('Publish')
    expect(document.querySelector<HTMLElement>('[data-publish-loading]')!.hidden).toBe(true)
  })

  it('publishes from the dialog, shows what went live, and reloads the page when closed', async () => {
    await mount('<a id="go" href="/admin/publish" data-publish-dialog>Publish</a>')
    fetchMock.mockResolvedValueOnce(REVIEW()).mockResolvedValueOnce(DONE())
    document.getElementById('go')!.click()
    await settle()
    body().querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
    expect(body().querySelector('button[type="submit"]')!.textContent).toBe('Publishing…')
    await settle()
    const [url, init] = fetchMock.mock.calls[1]!
    expect(String(url)).toMatch(/\/admin\/publish$/)
    expect(init!.method).toBe('POST')
    const sent = init!.body as URLSearchParams
    expect(sent.get('ids')).toBe('h1')
    expect(sent.get('expect')).toBe('{"h1":3}')
    expect(sent.get('_dialog')).toBe('1')
    expect(heading()).toBe('Published')
    expect(shownIcons()).toEqual(['done'])
    const close = body().querySelector<HTMLAnchorElement>('[data-dialog-cancel]')!
    expect(close.textContent).toBe('Close')
    expect(reload).not.toHaveBeenCalled()
    close.click()
    expect(dialog().open).toBe(false)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('closes on Cancel without reloading anything', async () => {
    await mount('<a id="go" href="/admin/publish" data-publish-dialog>Publish</a>')
    fetchMock.mockResolvedValueOnce(REVIEW())
    document.getElementById('go')!.click()
    await settle()
    body().querySelector<HTMLAnchorElement>('[data-dialog-cancel]')!.click()
    expect(dialog().open).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('loads the latest changes into the dialog when the content changed', async () => {
    await mount('<a id="go" href="/admin/publish" data-publish-dialog>Publish</a>')
    fetchMock.mockResolvedValueOnce(CHANGED()).mockResolvedValueOnce(REVIEW())
    document.getElementById('go')!.click()
    await settle()
    expect(shownIcons()).toEqual(['changed'])
    body().querySelector<HTMLAnchorElement>('a')!.click()
    await settle()
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/admin/publish?ids=h1&action=publish')
    expect(heading()).toBe('Publish changes')
  })

  it('opens a form button with what the form would send', async () => {
    await mount(
      `<form id="f" method="get" action="/admin/publish"><input type="hidden" name="ids" value="">` +
        `<input type="checkbox" name="ids" value="a" checked><input type="checkbox" name="ids" value="b">` +
        `<button id="go" type="submit" data-publish-dialog>Publish selected</button></form>`,
    )
    fetchMock.mockResolvedValueOnce(REVIEW())
    document.getElementById('go')!.click()
    await settle()
    const url = new URL(String(fetchMock.mock.calls[0]![0]))
    expect(url.pathname).toBe('/admin/publish')
    expect(url.searchParams.getAll('ids')).toEqual(['', 'a'])
    expect(dialog().open).toBe(true)
  })

  it('goes to the publish page when the dialog gets no review back', async () => {
    await mount('<a id="go" href="/admin/publish?ids=h1" data-publish-dialog>Publish</a>')
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
    fetchMock.mockResolvedValueOnce(page('<!doctype html><p>Sign in</p>'))
    document.getElementById('go')!.click()
    await settle()
    expect(dialog().open).toBe(false)
    expect(String(assign.mock.calls[0]![0])).toMatch(/\/admin\/publish\?ids=h1$/)
    assign.mockRestore()
  })

  /** An editor: its form (with the revision it was opened from), status, save state, and Save and publish. */
  const EDITOR =
    `<span id="editor-status" data-refresh>Unpublished changes</span><span id="save-state">Unsaved changes</span>` +
    `<form id="editor-form" method="post" action="/admin/documents/h1"><input type="hidden" name="base" value="3">` +
    `<input name="fields.title" value="Home again"></form>` +
    `<button id="go" type="submit" form="editor-form" name="_action" value="publish" data-publish-dialog>Save and publish</button>`

  /** The editor page the server answers a save that worked with: it asks for the review. */
  const SAVED = () =>
    page(
      `<!doctype html><html><body><span id="editor-status" data-refresh>Unpublished changes</span>` +
        `<span id="save-state">Last saved just now</span><form id="editor-form"><input type="hidden" name="base" value="4">` +
        `<div hidden data-publish-open="/admin/publish?ids=h1&amp;action=publish"></div></form></body></html>`,
    )

  it('saves in the background on Save and publish, then opens the dialog without leaving the page', async () => {
    await mount(EDITOR)
    const form = document.querySelector<HTMLFormElement>('#editor-form')!
    const submit = vi.spyOn(form, 'requestSubmit')
    const saved = vi.fn()
    document.addEventListener('inlay:saved', saved)
    fetchMock.mockResolvedValueOnce(SAVED()).mockResolvedValueOnce(REVIEW())
    document.getElementById('go')!.click()
    await settle()
    await settle()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toMatch(/\/admin\/documents\/h1$/)
    const sent = init!.body as URLSearchParams
    expect(sent.get('fields.title')).toBe('Home again')
    expect(sent.get('_action')).toBe('publish')
    expect(sent.get('_dialog')).toBe('1')
    expect(submit).not.toHaveBeenCalled()
    expect(form.querySelector<HTMLInputElement>('input[name="base"]')!.value).toBe('4')
    expect(document.getElementById('save-state')!.textContent).toBe('Last saved just now')
    expect(saved).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[1]![0])).toBe('/admin/publish?ids=h1&action=publish')
    expect(dialog().open).toBe(true)
    expect(heading()).toBe('Publish changes')
    document.removeEventListener('inlay:saved', saved)
  })

  it('submits Save and publish the ordinary way when the save has problems', async () => {
    await mount(EDITOR)
    const form = document.querySelector<HTMLFormElement>('#editor-form')!
    const submit = vi.spyOn(form, 'requestSubmit').mockImplementation(() => {})
    fetchMock.mockResolvedValueOnce(page('<!doctype html><form id="editor-form"><p>Title is required.</p></form>'))
    document.getElementById('go')!.click()
    await settle()
    expect(submit).toHaveBeenCalledWith(document.getElementById('go'))
    expect(form.querySelector<HTMLInputElement>('input[name="_dialog"]')!.value).toBe('1')
    expect(form.querySelector<HTMLInputElement>('input[name="base"]')!.value).toBe('3')
    expect(dialog().open).toBe(false)
  })

  it('submits Save and publish the ordinary way on a page showing a failed save', async () => {
    await mount(EDITOR.replace('<form id="editor-form"', '<form id="editor-form" data-save-errors'))
    document.getElementById('editor-form')!.addEventListener('submit', (event) => event.preventDefault())
    const prevented = new Promise<boolean>((resolve) => {
      document.addEventListener('click', (event) => resolve(event.defaultPrevented), { once: true })
    })
    document.getElementById('go')!.click()
    expect(await prevented).toBe(false)
    expect(document.querySelector<HTMLInputElement>('#editor-form input[name="_dialog"]')!.value).toBe('1')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('in the editor, brings the page up to date after a publish instead of reloading it', async () => {
    await mount(EDITOR + '<a id="pub" href="/admin/publish" data-publish-dialog>Publish</a>')
    document.querySelector<HTMLInputElement>('input[name="fields.title"]')!.value = 'Not saved yet'
    fetchMock
      .mockResolvedValueOnce(REVIEW())
      .mockResolvedValueOnce(DONE())
      .mockResolvedValueOnce(page('<!doctype html><span id="editor-status" data-refresh>Published</span><span id="save-state">Last saved</span>'))
    document.getElementById('pub')!.click()
    await settle()
    body().querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
    await settle()
    body().querySelector<HTMLAnchorElement>('[data-dialog-cancel]')!.click()
    await settle()
    expect(reload).not.toHaveBeenCalled()
    expect(String(fetchMock.mock.calls[2]![0])).toBe(location.href)
    expect(document.getElementById('editor-status')!.textContent).toBe('Published')
    expect(document.getElementById('save-state')!.textContent).toBe('Unsaved changes')
    expect(document.querySelector<HTMLInputElement>('input[name="fields.title"]')!.value).toBe('Not saved yet')
  })

  it('opens straight away when the page asks, and forgets the ask in the address', async () => {
    history.replaceState(null, '', '/admin/documents/h1?review=publish')
    fetchMock.mockResolvedValueOnce(REVIEW())
    await mount('<div hidden data-publish-open="/admin/publish?ids=h1&amp;action=publish"></div>')
    expect(dialog().open).toBe(true)
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/admin/publish?ids=h1&action=publish')
    expect(location.pathname + location.search).toBe('/admin/documents/h1')
    expect(document.querySelector('[data-publish-open]')).toBeNull()
    await settle()
    expect(heading()).toBe(t('admin.publish.title'))
  })
})
