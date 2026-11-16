import type { FastifyInstance } from 'fastify'
import type { Core } from '../../src/core/core.js'
import { t } from '../../src/core/messages/index.js'
import type { Ctx } from '../../src/core/types.js'
import { makeApp } from '../helpers/app.js'
import { parseHtml, signIn, submittedForm, type AdminClient } from '../helpers/admin.js'

const rich = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const linkTo = (groupId: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'See this', marks: [{ type: 'link', attrs: { document: groupId } }] }] }],
})

describe('collection lists with bulk actions', () => {
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

  const post = (title: string, body: unknown = rich('Text')) =>
    core.createEntry('posts', { fields: { title, date: '2026-02-01', body } }, editor)
  const textOf = (html: string) => parseHtml(html).body.textContent.replace(/\s+/g, ' ')
  const rows = (html: string) => [...parseHtml(html).querySelectorAll('tbody tr')]
  const deletedAt = async (id: string) => (await core.getDocument(id))!.deletedAt

  it('pages the list 25 at a time', async () => {
    for (let i = 0; i < 104; i += 1) await post(`Post ${i}`)
    const first = await eddie.get('/admin/collections/posts')
    expect(first.statusCode).toBe(200)
    expect(rows(first.body)).toHaveLength(25)
    expect(textOf(first.body)).toContain('Showing 1–25 of 104')
    expect(rows((await eddie.get('/admin/collections/posts?size=50&page=3')).body)).toHaveLength(4)
    const past = await eddie.get('/admin/collections/posts?page=999')
    expect(past.statusCode).toBe(200)
    expect(rows(past.body)).toHaveLength(4)
  })

  it('filters by status and sorts by title', async () => {
    const a = await post('Banana')
    const b = await post('Apple')
    await post('Cherry')
    await core.publish([a.id, b.id], editor)
    const published = rows((await eddie.get('/admin/collections/posts?status=published')).body)
    expect(published).toHaveLength(2)
    const sorted = rows((await eddie.get('/admin/collections/posts?sort=title&dir=asc')).body)
    expect(sorted[0]!.querySelector('th')!.textContent).toContain('Apple')
    const fresh = rows((await eddie.get('/admin/collections/posts?status=new')).body)
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.textContent).toContain('Cherry')
  })

  it('switches language from the toolbar of another language’s list', async () => {
    await post('English post')
    const es = await eddie.get('/admin/collections/posts?locale=es')
    expect(rows(es.body)[0]!.textContent).toContain(t('admin.list.empty'))
    const select = parseHtml(es.body).querySelector('#entries-table-filters select[name="locale"]')!
    expect(select.getAttribute('form')).toBe('entries-table-filters')
    // Only the picker sends the language, so choosing English is the one value the list gets.
    const form = submittedForm(es.body, { form: '#entries-table-filters' })
    expect(form.getAll('locale')).toEqual(['es'])
    form.set('locale', 'en')
    const en = await eddie.get(`/admin/collections/posts?${form.toString()}`)
    expect(rows(en.body)[0]!.textContent).toContain('English post')
  })

  it('offers bulk Publish with a way back, and bulk Delete', async () => {
    await post('One')
    const doc = parseHtml((await eddie.get('/admin/collections/posts?status=new')).body)
    const publish = doc.querySelector('form#entries-table-bulk button[formaction="/admin/publish"][formmethod="get"][data-publish-dialog]')
    expect(publish).not.toBeNull()
    const back = doc.querySelector('input[name="back"][form="entries-table-bulk"]')!
    expect(back.getAttribute('value')).toBe('/admin/collections/posts?status=new')
    expect(doc.querySelector('button[formaction="/admin/collections/posts/delete"][formmethod="get"][data-bulk-delete]')).not.toBeNull()
    const dialog = doc.querySelector('dialog#bulk-delete-dialog')!
    const heading = dialog.querySelector('h2')!
    expect(dialog.getAttribute('aria-labelledby')).toBe(heading.id)
    expect(dialog.querySelector('#bulk-delete-body')).not.toBeNull()
    const close = dialog.querySelector('.modal-box form[method="dialog"] button[type="submit"]')!
    expect(close.getAttribute('aria-label')).toBe(t('admin.bulkDelete.close'))
    expect(dialog.querySelector(':scope > form.modal-backdrop[method="dialog"] button')).not.toBeNull()
  })

  it('says nothing was chosen when bulk Publish is sent with nothing ticked', async () => {
    await post('First post')
    await post('Second post')
    const list = await eddie.get('/admin/collections/posts?status=new')
    const form = submittedForm(list.body, { form: '#entries-table-bulk' })
    expect(form.getAll('ids')).toEqual([''])
    const res = await eddie.get(`/admin/publish?${form.toString()}`)
    expect(res.statusCode).toBe(200)
    const text = textOf(res.body)
    expect(text).toContain(t('admin.publish.noneSelected'))
    expect(text).not.toContain('First post')
    expect(parseHtml(res.body).querySelector('form[action="/admin/publish"][method="post"]')).toBeNull()
    expect(parseHtml(res.body).querySelector('main a[href="/admin/collections/posts?status=new"]')).not.toBeNull()
  })

  it('sends ticked posts to the publish review and back to the list', async () => {
    const a = await post('First post')
    const b = await post('Second post')
    const back = '/admin/collections/posts?status=new'
    const res = await eddie.get(`/admin/publish?ids=${a.id}&ids=${b.id}&back=${encodeURIComponent(back)}`)
    expect(res.statusCode).toBe(200)
    expect(textOf(res.body)).toContain('First post')
    expect(textOf(res.body)).toContain('Second post')
    const form = 'form[action="/admin/publish"][method="post"]'
    expect(parseHtml(res.body).querySelector(`${form} input[name="back"]`)!.getAttribute('value')).toBe(back)
    const done = await eddie.post('/admin/publish', submittedForm(res.body, { form }))
    expect(done.statusCode).toBe(303)
    expect(done.headers.location).toBe(`${back}&notice=published`)
    expect((await core.getDocument(a.id))!.publishedRev).not.toBeNull()
    expect(parseHtml((await eddie.get(done.headers.location as string)).body).querySelector('[role="status"]')!.textContent).toBe(
      t('admin.notice.published'),
    )

    const none = await eddie.get(`/admin/publish?ids=&back=${encodeURIComponent(back)}`)
    expect(parseHtml(none.body).querySelector(`main a[href="${back}"]`)).not.toBeNull()
  })

  it('never sends the publish page off the site', async () => {
    const a = await post('First post')
    for (const back of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/admin//evil.example', '/admin\n']) {
      const res = await eddie.get(`/admin/publish?ids=${a.id}&back=${encodeURIComponent(back)}`)
      const input = parseHtml(res.body).querySelector('form[action="/admin/publish"] input[name="back"]')!
      expect(input.getAttribute('value')).toBe('/admin')
    }
  })

  it('asks before deleting and says it covers every language', async () => {
    const a = await post('First post')
    const b = await post('Second post')
    const res = await eddie.get(`/admin/collections/posts/delete?ids=${a.id},${b.id}`)
    expect(res.statusCode).toBe(200)
    const doc = parseHtml(res.body)
    const confirm = doc.querySelector('#bulk-delete-confirm')!
    expect(confirm.textContent).toContain('First post')
    expect(confirm.textContent).toContain('Second post')
    expect(confirm.textContent).toContain('every language')
    const form = confirm.querySelector('form[method="post"]')!
    expect(form.getAttribute('action')).toBe('/admin/collections/posts/delete')
    expect(confirm.querySelector('a[href="/admin/collections/posts"][data-dialog-cancel]')).not.toBeNull()
    expect(await deletedAt(a.id)).toBeNull()
  })

  it('deletes the ticked posts and says how many', async () => {
    const a = await post('First post')
    const b = await post('Second post')
    const page = await eddie.get(`/admin/collections/posts/delete?ids=${a.id}&ids=${b.id}`)
    const res = await eddie.post('/admin/collections/posts/delete', submittedForm(page.body, { form: '#bulk-delete-confirm form' }))
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/collections/posts?notice=bulkDeleted&count=2')
    expect(await deletedAt(a.id)).not.toBeNull()
    expect(await deletedAt(b.id)).not.toBeNull()
    const list = await eddie.get(res.headers.location as string)
    expect(parseHtml(list.body).querySelector('[role="status"]')!.textContent).toContain('Entries deleted: 2.')
  })

  it('goes back to the filtered list after deleting', async () => {
    const a = await post('First post')
    const back = '/admin/collections/posts?status=new&sort=title'
    const page = await eddie.get(`/admin/collections/posts/delete?ids=${a.id}&back=${encodeURIComponent(back)}`)
    const res = await eddie.post('/admin/collections/posts/delete', submittedForm(page.body, { form: '#bulk-delete-confirm form' }))
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe(`${back}&notice=bulkDeleted&count=1`)
    const list = await eddie.get(res.headers.location as string)
    expect(parseHtml(list.body).querySelector('[role="status"]')!.textContent).toContain('Entries deleted: 1.')
  })

  it('deletes what it can and names what it could not', async () => {
    const a = await post('Used post')
    await post('Linking post', linkTo(a.groupId))
    const c = await post('Lonely post')
    const res = await eddie.post('/admin/collections/posts/delete', { ids: `${a.id},${c.id}` })
    expect(res.statusCode).toBe(200)
    expect(textOf(res.body)).toContain('Entries deleted: 1.')
    const alert = parseHtml(res.body).querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('Used post')
    expect(alert.textContent).toContain(t('error.entryInUse', { title: 'Used post', count: 1 }))
    expect(await deletedAt(c.id)).not.toBeNull()
    expect(await deletedAt(a.id)).toBeNull()
  })

  it('lets an editor bulk delete and ignores ids from another collection', async () => {
    const a = await post('First post')
    const quote = await core.createEntry('testimonials', { fields: { author: 'Maria', quote: 'Great' } }, editor)
    const confirm = await eddie.get(`/admin/collections/posts/delete?ids=${a.id},${quote.id}`)
    expect(textOf(confirm.body)).not.toContain('Maria')
    const res = await eddie.post('/admin/collections/posts/delete', { ids: [a.id, quote.id] })
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/collections/posts?notice=bulkDeleted&count=1')
    expect(await deletedAt(a.id)).not.toBeNull()
    expect(await deletedAt(quote.id)).toBeNull()
  })

  it('tells you when nothing was ticked', async () => {
    for (const url of ['/admin/collections/posts/delete?ids=', '/admin/collections/posts/delete?ids=nope']) {
      const res = await eddie.get(url)
      expect(res.statusCode).toBe(200)
      expect(textOf(res.body)).toContain(t('admin.bulkDelete.none'))
      expect(parseHtml(res.body).querySelector('#bulk-delete-confirm form')).toBeNull()
    }
    expect((await eddie.get('/admin/collections/nope/delete?ids=x')).statusCode).toBe(404)
  })
})
