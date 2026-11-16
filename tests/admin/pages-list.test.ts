import type { FastifyInstance } from 'fastify'
import type { Core } from '../../src/core/core.js'
import { defineContent } from '../../src/core/registry/content.js'
import { defineSingleton, defineSite } from '../../src/core/registry/define.js'
import type { Ctx } from '../../src/core/types.js'
import { makeApp } from '../helpers/app.js'
import { parseHtml, signIn, type AdminClient } from '../helpers/admin.js'
import { Page, webSite } from '../fixtures/web.js'

const textOf = (html: string) => parseHtml(html).body.textContent.replace(/\s+/g, ' ')

describe('pages and site-wide content tables', () => {
  let app: FastifyInstance
  let core: Core
  let editor: Ctx
  let eddie: AdminClient

  beforeEach(async () => {
    ;({ app, core, editor } = await makeApp({ withOwner: true }))
    await app.ready()
    eddie = await signIn(app, 'editor@example.com')
  })
  afterEach(() => app.close())

  const rowOf = (html: string, label: string) =>
    [...parseHtml(html).querySelectorAll('tbody tr')].find((r) => r.querySelector('th')?.textContent.includes(label))!

  it('lists pages as a table with their addresses', async () => {
    const html = (await eddie.get('/admin/pages')).body
    const doc = parseHtml(html)
    expect(doc.querySelector('div#pages table caption')!.textContent).toBe('Pages')
    expect(rowOf(html, 'About').querySelector('code')!.textContent).toBe('/about')
    expect(rowOf(html, 'Page not found').textContent).toContain('No address of its own')
  })

  it('shows each language with its own status', async () => {
    const es = (await core.findSingleton('home', 'es'))!
    await core.publish([es.id], editor)
    const current = (await core.getDocument(es.id))!
    await core.patchDraft(es.id, { baseRevisionId: current.headRev, ops: [{ path: ['fields', 'title'], value: 'Inicio 2' }] }, editor)
    const html = (await eddie.get('/admin/pages')).body
    const row = rowOf(html, 'Home')
    expect(row.querySelector('a[aria-label="ES: Unpublished changes"]')).not.toBeNull()
    expect(row.textContent).toContain('Published')
  })

  it('offers to translate a page that is missing a language', async () => {
    const row = rowOf((await eddie.get('/admin/pages')).body, 'About')
    const form = row.querySelector('form[action$="/translations"]')!
    expect(form.querySelector('input[name=locale]')!.getAttribute('value')).toBe('es')
    expect(form.querySelector('button')!.getAttribute('aria-label')).toBe('Translate into ES')
  })

  it('has no languages column on a one-language site', async () => {
    const single = defineSite({
      locales: ['en'],
      defaultLocale: 'en',
      singletons: [
        defineSingleton({ name: 'about', label: 'About', template: Page, path: '/about' }),
      ],
      content: [defineContent('about', { edition: 1, content: { en: { fields: { title: 'About us', body: 'Hi' } } } })],
    })
    const made = await makeApp({ withOwner: true, site: single })
    await made.app.ready()
    try {
      const client = await signIn(made.app, 'editor@example.com')
      const html = (await client.get('/admin/pages')).body
      const heads = [...parseHtml(html).querySelectorAll('th')].map((th) => th.textContent.trim())
      expect(heads).toContain('Page')
      expect(heads).not.toContain('Languages')
      expect(parseHtml(html).querySelector('form[action$="/translations"]')).toBeNull()
    } finally {
      await made.app.close()
    }
  })

  it('lists site-wide content the same way', async () => {
    const html = (await eddie.get('/admin/globals')).body
    const doc = parseHtml(html)
    expect(doc.querySelector('div#globals table')).not.toBeNull()
    expect(rowOf(html, 'Navigation')).toBeDefined()
    const heads = [...doc.querySelectorAll('th')].map((th) => th.textContent.trim())
    expect(heads).toContain('Item')
    expect(heads).not.toContain('Address')
    expect(textOf(html)).toContain('Navigation')
  })
})
