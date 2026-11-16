import { renderPage, renderPane } from '../../src/adapters/site/render.js'
import type { Core } from '../../src/core/core.js'
import type { LiveDocument } from '../../src/core/types.js'
import { makeApp } from '../helpers/app.js'

describe('renderPane', () => {
  let app: Awaited<ReturnType<typeof makeApp>>['app']
  let core: Core
  let doc: LiveDocument
  const baseUrl = 'https://example.com'

  beforeEach(async () => {
    ;({ app, core } = await makeApp({ withOwner: true }))
    const home = await core.findSingleton('home', 'en')
    const docs = await core.liveDocuments([home!.groupId], 'en', { state: 'preview' })
    doc = docs.get(home!.groupId)!
  })
  afterEach(async () => {
    await app.close()
  })

  it('renders the page with slot markers and a base href, without the preview banner', async () => {
    const result = await renderPane(core, doc, { page: 1, baseUrl })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const html = result.html
    const start = html.indexOf('<!--inlay:slot hero-->')
    const text = html.indexOf('Welcome to Inlay')
    const end = html.indexOf('<!--/inlay:slot hero-->')
    expect(start).toBeGreaterThan(-1)
    expect(text).toBeGreaterThan(start)
    expect(end).toBeGreaterThan(text)
    expect(html).not.toContain('inlay:slot quotes')
    const base = html.indexOf('<base href="/">')
    expect(base).toBeGreaterThan(-1)
    const firstLink = html.search(/<link|<script/)
    if (firstLink !== -1) expect(base).toBeLessThan(firstLink)
    expect(html).not.toContain('class="inlay-preview"')
  })

  it('reports strict problems instead of rendering', async () => {
    const data = structuredClone(doc.data)
    data.slots.hero!.data.headline = ''
    const result = await renderPane(core, { ...doc, data }, { page: 1, baseUrl })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((i) => i.path[0] === 'slots' && i.path[1] === 'hero')).toBe(true)
  })

  it('leaves renderPage output untouched', async () => {
    const html = await renderPage(core, doc, { state: 'preview', page: 1, baseUrl })
    expect(html).not.toContain('inlay:slot')
    expect(html).not.toContain('<base ')
    expect(html).toContain('class="inlay-preview"')
  })

  it('escapes the page path in the base href', async () => {
    const result = await renderPane(core, { ...doc, path: '/a"b' }, { page: 1, baseUrl })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.html).toContain('<base href="/a&quot;b">')
  })

  it('refuses a document without an address', async () => {
    await expect(renderPane(core, { ...doc, path: null }, { page: 1, baseUrl })).rejects.toMatchObject({
      code: 'invalid_operation',
      messageId: 'error.paneNoPath',
      params: { title: doc.title },
    })
  })
})
