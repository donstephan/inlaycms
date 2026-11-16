import type { FastifyInstance } from 'fastify'
import type { Core } from '../../src/core/core.js'
import { t } from '../../src/core/messages/index.js'
import type { Ctx } from '../../src/core/types.js'
import { jpeg } from '../fixtures/media.js'
import { makeApp } from '../helpers/app.js'
import { parseHtml, signIn, type AdminClient } from '../helpers/admin.js'

const HX = { 'hx-request': 'true' }
const rich = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

describe('global search', () => {
  let app: FastifyInstance
  let core: Core
  let owner: Ctx
  let olivia: AdminClient

  beforeEach(async () => {
    ;({ app, core, owner } = await makeApp({ withOwner: true }))
    await app.ready()
    olivia = await signIn(app, 'owner@example.com')
  })
  afterEach(() => app.close())

  const post = (title: string) => core.createEntry('posts', { fields: { title, date: '2026-02-01', body: rich('Text') } }, owner)
  const headings = (html: string) => [...parseHtml(html).querySelectorAll('main h2')].map((h) => h.textContent.trim())

  it('finds posts, pages and media by name', async () => {
    const hello = await post('Hello, Inlay')
    const res = await olivia.get('/admin/search?q=hello')
    expect(res.statusCode).toBe(200)
    const doc = parseHtml(res.body)
    expect(doc.querySelector('h1')?.textContent).toBe(t('admin.search.title'))
    expect(doc.querySelector<HTMLInputElement>('main input[name="q"]')?.getAttribute('value')).toBe('hello')
    expect(headings(res.body)).toContain('Posts')
    expect(doc.querySelector(`main a[href="/admin/documents/${hello.id}"]`)?.textContent).toContain('Hello, Inlay')

    const about = await olivia.get('/admin/search?q=about')
    expect(headings(about.body)).toContain(t('admin.nav.pages'))
    const aboutDoc = (await core.findSingleton('about'))!
    expect(parseHtml(about.body).querySelector(`main a[href="/admin/documents/${aboutDoc.id}"]`)).not.toBeNull()

    const { media } = await core.addMedia({ data: await jpeg(20, 20), filename: 'studio.jpg' }, owner)
    const studio = await olivia.get('/admin/search?q=studio')
    expect(headings(studio.body)).toEqual([t('admin.nav.media')])
    expect(parseHtml(studio.body).querySelector(`main a[href="/admin/media/${media.id}"]`)?.textContent).toContain('studio.jpg')
  })

  it('answers htmx with just the results list', async () => {
    const hello = await post('Hello, Inlay')
    const res = await olivia.get('/admin/search?q=hello', HX)
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('<html')
    const doc = parseHtml(res.body)
    const results = doc.querySelector('#global-search-results')
    expect(results).not.toBeNull()
    const listbox = results!.querySelector('ul#global-search-listbox[role="listbox"]')
    expect(listbox?.getAttribute('aria-label')).toBe(t('admin.search.results'))
    const options = [...listbox!.querySelectorAll('li[role="option"]')]
    expect(options.map((o) => o.id)).toEqual(options.map((_, i) => `global-search-opt-${i}`))
    expect(options.some((o) => o.querySelector(`a[href="/admin/documents/${hello.id}"]`) !== null)).toBe(true)
    expect([...listbox!.querySelectorAll('li[role="presentation"]')].map((li) => li.textContent.trim())).toContain('Posts')
    // Each group is an ARIA group named after its heading; the visible heading is hidden from screen readers.
    const posts = listbox!.querySelector(':scope > li[role="presentation"] > ul[role="group"][aria-label="Posts"]')!
    expect(posts.querySelector('[role="option"]')).not.toBeNull()
    for (const child of posts.children) {
      expect(child.getAttribute('role') === 'option' || child.getAttribute('aria-hidden') === 'true').toBe(true)
    }
    expect([...listbox!.children].every((li) => li.getAttribute('role') === 'presentation')).toBe(true)
  })

  it('caps each group at four with a see-all link', async () => {
    for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']) await post(`Cat ${name}`)
    const doc = parseHtml((await olivia.get('/admin/search?q=cat', HX)).body)
    const options = [...doc.querySelectorAll('[role="option"]')]
    expect(options).toHaveLength(5)
    const seeAll = options[4]!.querySelector('a')!
    expect(seeAll.textContent.trim()).toBe(t('admin.search.seeAll', { count: 6, label: 'Posts' }))
    expect(seeAll.getAttribute('href')).toBe('/admin/collections/posts?q=cat')

    const full = parseHtml((await olivia.get('/admin/search?q=cat')).body)
    expect(full.querySelectorAll('main a[href^="/admin/documents/"]')).toHaveLength(6)
  })

  it('shows search text as text', async () => {
    const res = await olivia.get(`/admin/search?q=${encodeURIComponent('<b>x</b>')}`)
    expect(res.statusCode).toBe(200)
    const main = parseHtml(res.body).querySelector('main')!
    expect(main.querySelector('b')).toBeNull()
    expect(main.textContent).toContain(t('admin.search.none', { query: '<b>x</b>' }))

    const fragment = parseHtml((await olivia.get(`/admin/search?q=${encodeURIComponent('<b>x</b>')}`, HX)).body)
    const results = fragment.querySelector('#global-search-results')!
    expect(results.querySelector('b')).toBeNull()
    expect(results.querySelector('p')?.textContent).toBe(t('admin.search.none', { query: '<b>x</b>' }))
    expect(results.querySelector('[role="listbox"]')).toBeNull()
    expect(results.querySelector('[role="status"]')).not.toBeNull()
  })

  it('shows recently changed content for an empty search', async () => {
    const hello = await post('Hello, Inlay')
    const doc = parseHtml((await olivia.get('/admin/search?q=', HX)).body)
    const listbox = doc.querySelector('#global-search-listbox')!
    expect(listbox.querySelector('[role="presentation"]')?.textContent).toContain(t('admin.search.recent'))
    expect(listbox.querySelector(`a[href="/admin/documents/${hello.id}"]`)).not.toBeNull()
    expect(listbox.querySelectorAll('[role="option"]').length).toBeLessThanOrEqual(6)
  })

  it('lets an editor search', async () => {
    const eddie = await signIn(app, 'editor@example.com')
    const res = await eddie.get('/admin/search?q=home')
    expect(res.statusCode).toBe(200)
    expect(headings(res.body)).toContain(t('admin.nav.pages'))
  })
})
