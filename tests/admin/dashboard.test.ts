import type { FastifyInstance } from 'fastify'
import type { Core } from '../../src/core/core.js'
import type { Ctx } from '../../src/core/types.js'
import { makeApp } from '../helpers/app.js'
import { parseHtml, signIn, submittedForm, type AdminClient } from '../helpers/admin.js'
import { t } from '../../src/core/messages/index.js'
import { defineContent } from '../../src/core/registry/content.js'
import { defineSingleton, defineSite } from '../../src/core/registry/define.js'
import { Page } from '../fixtures/web.js'

const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Text' }] }] }

describe('admin dashboard and lists', () => {
  let app: FastifyInstance
  let core: Core
  let owner: Ctx
  let editor: Ctx
  let eddie: AdminClient

  beforeEach(async () => {
    ;({ app, core, owner, editor } = await makeApp({ withOwner: true }))
    await app.ready()
    eddie = await signIn(app, 'editor@example.com')
  })
  afterEach(() => app.close())

  const post = (title: string) => core.createEntry('posts', { fields: { title, date: '2026-02-01', body } }, editor)
  const textOf = (html: string) => parseHtml(html).body.textContent.replace(/\s+/g, ' ')
  const rows = (html: string) => [...parseHtml(html).querySelectorAll('tbody tr')].map((r) => r.textContent.replace(/\s+/g, ' ').trim())

  it('lists what is waiting to be published, and what happened', async () => {
    const home = (await core.findSingleton('home'))!
    await core.patchDraft(
      home.id,
      { baseRevisionId: home.headRev, ops: [{ path: ['slots', 'hero', 'data', 'headline'], value: 'A brand new headline' }] },
      { ...editor, source: 'mcp' },
    )
    const res = await eddie.get('/admin')
    expect(res.statusCode).toBe(200)
    const text = textOf(res.body)
    expect(text).toContain('Home')
    expect(text).toContain('Unpublished changes')
    expect(text).toContain('A brand new headline')
    expect(text).toContain('Eddie Editor changed Home using the assistant')
    const doc = parseHtml(res.body)
    const box = doc.querySelector(`input[name="ids"][value="${home.id}"]`)
    expect(box?.hasAttribute('checked')).toBe(true)
    expect(doc.querySelector(`label[for="${box?.getAttribute('id')}"]`)).not.toBeNull()
    expect(doc.querySelector('form[action="/admin/publish"] button[data-publish-dialog]')?.textContent).toBe('Publish selected')
  })

  it('links Upload media to the upload sheet', async () => {
    const doc = parseHtml((await eddie.get('/admin')).body)
    const link = [...doc.querySelectorAll('a')].find((a) => a.textContent.trim() === 'Upload media')
    expect(link?.getAttribute('href')).toBe('/admin/media?sheet=upload')
  })

  it('shows tiles with counts', async () => {
    await post('One')
    await post('Two')
    const doc = parseHtml((await eddie.get('/admin')).body)
    const tile = doc.querySelector('main a[href="/admin/collections/posts"]')
    expect(tile?.textContent.trim()).toMatch(/^Posts\s*2\s*\d+ changed this week$/)
    const linkTexts = (href: string) => [...doc.querySelectorAll(`main a[href="${href}"]`)].map((a) => a.textContent)
    expect(linkTexts('/admin/pages').some((text) => text.includes('Missing a translation: '))).toBe(true)
    expect(linkTexts('/admin/media').some((text) => text.includes('in total'))).toBe(true)
    const add = doc.querySelector('details.dropdown summary')
    expect(add?.textContent).toContain('Add new')
    expect(doc.querySelector('details.dropdown a[href="/admin/collections/posts/new"]')).not.toBeNull()
    expect(doc.querySelector('main a[href="/admin/publish"]:not(form *)')).toBeNull()
  })

  it('collapses the shipped content into one line', async () => {
    const section = parseHtml((await eddie.get('/admin')).body).querySelector('section[aria-labelledby="activity-heading"]')
    const text = section!.textContent.replace(/\s+/g, ' ')
    expect(text).toMatch(/\d+ items of content shipped with the site/)
    expect(text).not.toMatch(/changed .*\(Shipped with the site\)/)
  })

  it('lists what needs attention and hides the card when nothing does', async () => {
    const doc = parseHtml((await eddie.get('/admin')).body)
    const heads = [...doc.querySelectorAll('h2')].map((h) => h.textContent.trim())
    expect(heads).toContain('Needs attention')
    expect(textOf((await eddie.get('/admin')).body)).toContain('About is not translated into ES yet.')
    expect(doc.querySelector('section[aria-labelledby="attention-heading"] a[href="/admin/pages"]')).not.toBeNull()

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
      const html = (await client.get('/admin')).body
      expect([...parseHtml(html).querySelectorAll('h2')].map((h) => h.textContent.trim())).not.toContain('Needs attention')
      expect(textOf(html)).not.toContain('not translated')
      expect(textOf(html)).not.toContain('All translated')
    } finally {
      await made.app.close()
    }
  })

  it('shows the last backup only to owners', async () => {
    const olivia = await signIn(app, 'owner@example.com')
    expect(textOf((await olivia.get('/admin')).body)).toContain('No backup yet')
    expect((await olivia.post('/admin/backups', {})).statusCode).toBe(303)
    const doc = parseHtml((await olivia.get('/admin')).body)
    const tile = doc.querySelector('main a[href="/admin/backups"]')
    expect(tile?.textContent).toContain('Last backup')
    expect(tile?.textContent).toContain('Made by hand')
    expect(tile?.querySelector('time[data-relative]')).not.toBeNull()
    expect(textOf((await eddie.get('/admin')).body)).not.toContain('Last backup')
  })

  it('goes by the site’s clock for this week, today and the last backup', async () => {
    await post('Fresh post')
    const doc = parseHtml((await eddie.get('/admin')).body)
    const tile = doc.querySelector('main a[href="/admin/collections/posts"]')!
    expect(tile.textContent).toContain(t('admin.dashboard.tile.changed', { count: 1 }))
    const days = [...doc.querySelectorAll('section[aria-labelledby="activity-heading"] h3')].map((h) => h.textContent.trim())
    expect(days[0]).toBe(t('admin.activity.today'))

    const olivia = await signIn(app, 'owner@example.com')
    expect((await olivia.post('/admin/backups', {})).statusCode).toBe(303)
    const backup = parseHtml((await olivia.get('/admin')).body).querySelector('main a[href="/admin/backups"]')!
    expect(backup.textContent).toContain('Last backup')
    expect(backup.textContent).not.toContain(t('admin.dashboard.tile.backupOld'))
    expect(backup.querySelector('.text-error')).toBeNull()
  })

  it('says so when nothing is waiting', async () => {
    expect(textOf((await eddie.get('/admin')).body)).toContain('Nothing is waiting to be published')
  })

  it('opens the publish review for repeated ids', async () => {
    const home = (await core.findSingleton('home'))!
    const about = (await core.findSingleton('about'))!
    for (const doc of [home, about]) {
      await core.patchDraft(doc.id, { baseRevisionId: doc.headRev, ops: [{ path: ['fields', 'title'], value: `${doc.title} 2` }] }, editor)
    }
    const res = await eddie.get(`/admin/publish?ids=${home.id}&ids=${about.id}`)
    expect(res.statusCode).toBe(200)
    const text = textOf(res.body)
    expect(text).toContain('Home 2')
    expect(text).toContain('About 2')
  })

  it('says nothing was chosen when every box is unticked, and publishes everything waiting without ids', async () => {
    const home = (await core.findSingleton('home'))!
    await core.patchDraft(home.id, { baseRevisionId: home.headRev, ops: [{ path: ['fields', 'title'], value: 'Home 2' }] }, editor)
    const form = submittedForm((await eddie.get('/admin')).body, { form: 'form[action="/admin/publish"]' })
    form.delete('ids', home.id)
    const res = await eddie.get(`/admin/publish?${form.toString()}`)
    expect(res.statusCode).toBe(200)
    const text = textOf(res.body)
    expect(text).toContain(t('admin.publish.noneSelected'))
    expect(text).not.toContain('Home 2')
    expect(parseHtml(res.body).querySelector('main a[href="/admin"]')).not.toBeNull()
    expect(parseHtml(res.body).querySelector('form[action="/admin/publish"]')).toBeNull()

    const ticked = submittedForm((await eddie.get('/admin')).body, { form: 'form[action="/admin/publish"]' })
    expect(textOf((await eddie.get(`/admin/publish?${ticked.toString()}`)).body)).toContain('Home 2')
    expect(textOf((await eddie.get('/admin/publish')).body)).toContain('Home 2')
  })

  it('lists pages and site-wide content', async () => {
    const pages = textOf((await eddie.get('/admin/pages')).body)
    for (const label of ['Home', 'About', 'Blog', 'Page not found']) expect(pages).toContain(label)
    expect(parseHtml((await eddie.get('/admin/pages')).body).querySelector('code')!.textContent).toBe('/')
    expect([...parseHtml((await eddie.get('/admin/pages')).body).querySelectorAll('code')].map((c) => c.textContent)).toContain('/about')
    expect(textOf((await eddie.get('/admin/globals')).body)).toContain('Navigation')
  })

  it('searches, pages and filters collections by language', async () => {
    await post('Hello world')
    await post('Goodbye')
    expect(rows((await eddie.get('/admin/collections/posts?q=hello')).body)).toHaveLength(1)
    expect(rows((await eddie.get('/admin/collections/posts?q=hello')).body)[0]).toContain('Hello world')

    for (let i = 0; i < 49; i += 1) await post(`Filler ${i}`)
    expect(rows((await eddie.get('/admin/collections/posts')).body)).toHaveLength(25)
    expect(rows((await eddie.get('/admin/collections/posts?size=50')).body)).toHaveLength(50)
    const second = await eddie.get('/admin/collections/posts?size=50&page=2')
    expect(rows(second.body)).toHaveLength(1)
    expect(parseHtml(second.body).querySelector('a[href*="/admin/collections/posts"]')).not.toBeNull()

    const hola = await core.createTranslation((await post('Hola')).groupId, 'es', editor)
    const current = (await core.getDocument(hola.id))!
    await core.patchDraft(hola.id, { baseRevisionId: current.headRev, ops: [{ path: ['fields', 'title'], value: 'Hola' }] }, editor)
    const es = rows((await eddie.get('/admin/collections/posts?locale=es')).body)
    expect(es).toHaveLength(1)
    expect(es[0]).toContain('Hola')
    expect(rows((await eddie.get('/admin/collections/posts?locale=xx&q=hello')).body)).toHaveLength(1)
  })

  it('answers 404 for an unknown or non-collection type', async () => {
    expect((await eddie.get('/admin/collections/nope')).statusCode).toBe(404)
    expect((await eddie.get('/admin/collections/home')).statusCode).toBe(404)
  })

  it('shows deleted entries to the owner only', async () => {
    const gone = await post('Removed post')
    await core.deleteEntry(gone.groupId, owner)
    expect((await eddie.get('/admin/collections/posts?deleted=1')).statusCode).toBe(403)
    const olivia = await signIn(app, 'owner@example.com')
    const res = await olivia.get('/admin/collections/posts?deleted=1')
    expect(res.statusCode).toBe(200)
    expect(rows(res.body)[0]).toContain('Removed post')
    const label = t('admin.editor.restoreItem', { title: 'Removed post' })
    const restore = parseHtml(res.body).querySelector(`tbody form button[type="submit"][aria-label="${label}"]`)
    expect(restore).not.toBeNull()
    expect(rows((await olivia.get('/admin/collections/posts')).body)).toEqual([t('admin.list.empty')])
  })

  it('escapes hostile titles', async () => {
    const hostile = '"><script>alert(1)</script>'
    await post(hostile)
    for (const url of ['/admin', '/admin/collections/posts']) {
      const res = await eddie.get(url)
      expect(res.body).not.toContain('<script>alert')
      expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    }
  })
})
