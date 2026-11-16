import type { FastifyInstance } from 'fastify'
import type { Core } from '../../src/core/core.js'
import { makeApp } from '../helpers/app.js'
import { parseHtml, signIn, type AdminClient } from '../helpers/admin.js'

const textOf = (html: string) => parseHtml(html).body.textContent.replace(/\s+/g, ' ')

describe('admin redirects', () => {
  let app: FastifyInstance
  let core: Core
  let eddie: AdminClient

  beforeEach(async () => {
    ;({ app, core } = await makeApp({ withOwner: true }))
    await app.ready()
    eddie = await signIn(app, 'editor@example.com')
  })
  afterEach(() => app.close())

  const add = (form: Record<string, string>) => eddie.post('/admin/redirects', { to_mode: 'path', status: '301', ...form })

  it('puts the intro under the heading and the two actions beside it', async () => {
    const page = parseHtml((await eddie.get('/admin/redirects')).body)
    expect(page.querySelector('h1')?.nextElementSibling?.textContent.trim()).toBe('A redirect sends visitors from an old address to a new one.')
    const addButton = page.querySelector('button[data-sheet-open="add-redirect"]')
    expect(addButton?.textContent.trim()).toBe('Add a redirect')
    expect(addButton?.classList.contains('btn-primary')).toBe(true)
    expect(page.querySelector('button[data-sheet-open="import-redirects"]')?.textContent.trim()).toBe('Import from a file')
    expect(page.querySelector('dialog#add-redirect')).not.toBeNull()
    expect(page.querySelector('dialog#add-redirect')?.hasAttribute('data-sheet-autoopen')).toBe(false)
    expect(page.querySelector('dialog#import-redirects')?.hasAttribute('data-sheet-autoopen')).toBe(false)
    expect(page.querySelector('dialog#import-redirects')?.classList.contains('sheet-lg')).toBe(true)
    expect(page.querySelector('[data-shown-when="to_mode=path"]')?.hasAttribute('hidden')).toBe(false)
    expect(page.querySelector('[data-shown-when="to_mode=document"]')?.hasAttribute('hidden')).toBe(true)
  })

  it('adds a redirect to a path', async () => {
    const res = await add({ from: '/old', to_path: '/about' })
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/redirects?notice=redirectAdded')
    const page = await eddie.get(res.headers.location as string)
    const text = textOf(page.body)
    expect(text).toContain('The redirect is added.')
    expect(text).toContain('/old')
    expect(text).toContain('/about')
  })

  it('adds a redirect to a page, listed by its title', async () => {
    const about = (await core.findSingleton('about'))!
    const res = await add({ from: '/old', to_mode: 'document', to_document: about.groupId })
    expect(res.statusCode).toBe(303)
    const page = parseHtml((await eddie.get('/admin/redirects')).body)
    const link = [...page.querySelectorAll('td a')].find((a) => a.textContent.includes('About'))
    expect(link?.getAttribute('href')).toBe(`/admin/documents/${about.id}`)
  })

  it('adds a pattern redirect', async () => {
    const res = await add({ from: '/2019/:month/:slug', to_path: '/blog/:slug' })
    expect(res.statusCode).toBe(303)
    expect(textOf((await eddie.get('/admin/redirects')).body)).toContain('/2019/:month/:slug')
  })

  it('refuses the address of a live page, keeping what was typed', async () => {
    const res = await add({ from: '/about', to_path: '/blog' })
    expect(res.statusCode).toBe(400)
    expect(textOf(res.body)).toContain('is the address of a published page')
    expect(parseHtml(res.body).querySelector('#from')?.getAttribute('value')).toBe('/about')
    const dialog = parseHtml(res.body).querySelector('dialog#add-redirect')
    expect(dialog?.hasAttribute('data-sheet-autoopen')).toBe(true)
    expect(dialog?.querySelector('#redirect-error')).not.toBeNull()
    expect(await core.listRedirects()).toHaveLength(0)
  })

  it('reopens with the chosen page when adding to a page fails', async () => {
    const about = (await core.findSingleton('about'))!
    const res = await add({ from: '/about', to_mode: 'document', to_document: about.groupId })
    expect(res.statusCode).toBe(400)
    const page = parseHtml(res.body)
    expect((page.querySelector('#to-mode-document') as unknown as { checked?: boolean }).checked ?? page.querySelector('#to-mode-document')?.hasAttribute('checked')).toBeTruthy()
    expect(page.querySelector('#to-document-chosen')?.textContent).toContain('About')
    expect(page.querySelector('[data-shown-when="to_mode=path"]')?.hasAttribute('hidden')).toBe(true)
    expect(page.querySelector('[data-shown-when="to_mode=document"]')?.hasAttribute('hidden')).toBe(false)
  })

  it('deletes a redirect', async () => {
    await add({ from: '/old', to_path: '/about' })
    const [r] = await core.listRedirects()
    const page = parseHtml((await eddie.get('/admin/redirects')).body)
    expect(page.querySelector('summary[aria-label="More actions for /old"]')).not.toBeNull()
    const action = page.querySelector('button[form][type=submit]')
    const form = page.querySelector(`form[id="${action?.getAttribute('form')}"]`)
    expect(form?.getAttribute('action')).toBe(`/admin/redirects/${r!.id}/delete`)
    expect(form?.getAttribute('method')).toBe('post')
    const res = await eddie.post(`/admin/redirects/${r!.id}/delete`, {})
    expect(res.headers.location).toBe('/admin/redirects?notice=redirectRemoved')
    expect(await core.listRedirects()).toHaveLength(0)
  })

  it('filters by search', async () => {
    await add({ from: '/zebra', to_path: '/about' })
    await add({ from: '/other', to_path: '/blog' })
    const text = textOf((await eddie.get('/admin/redirects?q=other')).body)
    expect(text).toContain('/other')
    expect(text).not.toContain('/zebra')
  })

  it('escapes a hostile note', async () => {
    await add({ from: '/old', to_path: '/about', note: '</textarea><script>alert(1)</script>' })
    const body = (await eddie.get('/admin/redirects')).body
    expect(body).not.toContain('<script>alert(1)</script>')
    expect(textOf(body)).toContain('<script>alert(1)</script>')
  })

  describe('import', () => {
    const csv = 'from,to,status,note\n/a,/about,301,first\n/b,/blog,302,\n'

    it('imports pasted lines', async () => {
      const res = await eddie.post('/admin/redirects/import', { csv })
      expect(res.statusCode).toBe(303)
      expect(res.headers.location).toBe('/admin/redirects?notice=imported&created=2&updated=0')
      expect(textOf((await eddie.get(res.headers.location as string)).body)).toContain('2 added')
    })

    it('imports an uploaded file', async () => {
      const res = await eddie.upload('/admin/redirects/import', [{ filename: 'r.csv', data: Buffer.from(csv), type: 'text/csv' }])
      expect(res.statusCode).toBe(303)
      expect(await core.listRedirects()).toHaveLength(2)
    })

    it('reports bad lines and imports nothing', async () => {
      const res = await eddie.post('/admin/redirects/import', { csv: '/a,/about\n/b\n' })
      expect(res.statusCode).toBe(400)
      expect(textOf(res.body)).toContain('Line 2')
      const dialog = parseHtml(res.body).querySelector('dialog#import-redirects')
      expect(dialog?.hasAttribute('data-sheet-autoopen')).toBe(true)
      expect(dialog?.querySelector('textarea')?.textContent).toBe('/a,/about\n/b\n')
      expect(await core.listRedirects()).toHaveLength(0)
    })

    it('puts an uploaded file back in the paste box when it has problems', async () => {
      const res = await eddie.upload('/admin/redirects/import', [{ filename: 'r.csv', data: Buffer.from('/a,/about\n/b\n'), type: 'text/csv' }])
      expect(res.statusCode).toBe(400)
      expect(textOf(res.body)).toContain('Line 2')
      expect(parseHtml(res.body).querySelector('textarea[name="csv"]')?.textContent).toBe('/a,/about\n/b\n')
    })

    it('asks for something to import when both are empty', async () => {
      const res = await eddie.post('/admin/redirects/import', { csv: '' })
      expect(res.statusCode).toBe(400)
      expect(parseHtml(res.body).querySelector('dialog#import-redirects')?.hasAttribute('data-sheet-autoopen')).toBe(true)
      expect(textOf(res.body)).toContain('Choose a file or paste some lines to import.')
    })

    it('escapes hostile lines sent back', async () => {
      const res = await eddie.post('/admin/redirects/import', { csv: '</textarea><script>alert(1)</script>\n' })
      expect(res.statusCode).toBe(400)
      expect(res.body).not.toContain('<script>alert(1)</script>')
      expect(parseHtml(res.body).querySelector('textarea[name="csv"]')?.textContent).toContain('<script>alert(1)</script>')
    })

    it('opens the import sheet from the old address', async () => {
      const old = await eddie.get('/admin/redirects/import')
      expect(old.statusCode).toBe(303)
      expect(old.headers.location).toBe('/admin/redirects?sheet=import')
      const page = await eddie.get('/admin/redirects?sheet=import')
      const dialog = parseHtml(page.body).querySelector('dialog#import-redirects')
      expect(dialog?.hasAttribute('data-sheet-autoopen')).toBe(true)
      expect(dialog?.querySelector('textarea[name="csv"]')).not.toBeNull()
      expect(dialog?.querySelector('form')?.getAttribute('enctype')).toBe('multipart/form-data')
      expect(textOf(page.body)).toContain('the old address, the new address')
    })
  })

  it('ignores an unknown sheet', async () => {
    const res = await eddie.get('/admin/redirects?sheet=nope')
    expect(res.statusCode).toBe(200)
    expect(parseHtml(res.body).querySelector('[data-sheet-autoopen]')).toBeNull()
  })
})
