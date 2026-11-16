import type { FastifyInstance } from 'fastify'
import type { Core } from '../../src/core/core.js'
import { t } from '../../src/core/messages/index.js'
import type { Ctx, DocumentSummary } from '../../src/core/types.js'
import { makeApp } from '../helpers/app.js'
import { parseHtml, signIn, submittedForm, type AdminClient } from '../helpers/admin.js'

const FORM = '#editor-form'
const SAVE = { name: '_action', value: 'save' }
const rich = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const LANGS = `nav[aria-label="${t('admin.editor.languages')}"]`
const editorUrl = (id: string) => `/admin/documents/${id}`

describe('admin entries and translations (web site)', () => {
  let app: FastifyInstance
  let core: Core
  let owner: Ctx
  let eddie: AdminClient
  let boss: AdminClient
  let home: DocumentSummary

  beforeEach(async () => {
    ;({ app, core, owner } = await makeApp({ withOwner: true }))
    await app.ready()
    eddie = await signIn(app, 'editor@example.com')
    boss = await signIn(app, 'owner@example.com')
    home = (await core.findSingleton('home', 'en'))!
  })
  afterEach(() => app.close())

  async function createPost(client: AdminClient, fields: Record<string, string>) {
    const page = await client.get('/admin/collections/posts/new')
    expect(page.statusCode).toBe(200)
    const form = submittedForm(page.body, { form: FORM, submitter: SAVE })
    for (const [k, v] of Object.entries(fields)) form.set(k, v)
    return client.post('/admin/collections/posts', form)
  }

  it('creates a post with a slug made from its title, unpublished', async () => {
    const res = await createPost(eddie, { 'fields.title': 'Hello world', slug: '' })
    expect(res.statusCode, res.body.slice(0, 1500)).toBe(303)
    const location = res.headers.location as string
    expect(location).toMatch(/^\/admin\/documents\/[^?]+\?notice=created$/)
    const doc = (await core.getDocument(location.split('?')[0]!.split('/').pop()!))!
    expect(doc.data.slug).toBe('hello-world')
    expect(doc.publishedRev).toBeNull()
    expect((await eddie.get(location)).body).toContain(t('admin.notice.created'))
  })

  it('places a duplicate slug on the slug field', async () => {
    await createPost(eddie, { 'fields.title': 'Hello world', slug: '' })
    const res = await createPost(eddie, { 'fields.title': 'Other', slug: 'hello-world' })
    expect(res.statusCode).toBe(400)
    const doc = parseHtml(res.body)
    expect(doc.querySelector('#f-slug')!.getAttribute('value')).toBe('hello-world')
    expect(res.body).toContain('is already used by another entry')
    expect(doc.querySelector('#f-slug')!.closest('div')!.textContent).toContain('already used')
  })

  it('shows the path field for collections with custom paths and rejects a bad path', async () => {
    const page = await eddie.get('/admin/collections/posts/new')
    expect(parseHtml(page.body).querySelector('#f-path')).not.toBeNull()
    const none = await eddie.get('/admin/collections/testimonials/new')
    expect(parseHtml(none.body).querySelector('#f-path')).toBeNull()
    const res = await createPost(eddie, { 'fields.title': 'X', path: '/admin/x' })
    expect(res.statusCode).toBe(400)
    expect(parseHtml(res.body).querySelector('[role="alert"]')).not.toBeNull()
  })

  it('404s for an unknown collection', async () => {
    expect((await eddie.get('/admin/collections/nope/new')).statusCode).toBe(404)
  })

  describe('translations', () => {
    it('offers an Add button for a missing translation and a link for an existing one', async () => {
      const about = (await core.findSingleton('about', 'en'))!
      expect(await core.findTranslation(about.groupId, 'es')).toBeNull()
      const withButton = parseHtml((await eddie.get(editorUrl(about.id))).body)
      const nav = withButton.querySelector(`nav[aria-label="${t('admin.editor.languages')}"]`)!
      const form = nav.querySelector('form')!
      expect(form.getAttribute('action')).toBe(`${editorUrl(about.id)}/translations`)
      expect(form.textContent).toContain('Add Spanish')
      expect(form.querySelector('input[name="locale"]')!.getAttribute('value')).toBe('es')

      expect(await core.findTranslation(home.groupId, 'es')).not.toBeNull()
      const linked = parseHtml((await eddie.get(editorUrl(home.id))).body)
      expect(linked.querySelector(`${LANGS} form`)).toBeNull()
    })

    it('creates the translation and marks it as current', async () => {
      const about = (await core.findSingleton('about', 'en'))!
      const res = await eddie.post(`${editorUrl(about.id)}/translations`, { locale: 'es' })
      expect(res.statusCode).toBe(303)
      const es = (await core.findTranslation(about.groupId, 'es'))!
      expect(res.headers.location).toBe(`${editorUrl(es.id)}?notice=translated`)
      const page = await eddie.get(res.headers.location as string)
      expect(page.body).toContain(t('admin.notice.translated'))
      const current = parseHtml(page.body).querySelector(`${LANGS} a[aria-current="page"]`)!
      expect(current.getAttribute('href')).toBe(editorUrl(es.id))
    })

    it('rejects an unknown language', async () => {
      const about = (await core.findSingleton('about', 'en'))!
      const res = await eddie.post(`${editorUrl(about.id)}/translations`, { locale: 'xx' })
      expect(res.statusCode).toBe(400)
      expect(res.body).toContain('is not a language of this site')
    })

    it('adds the button to the pages list', async () => {
      const list = parseHtml((await eddie.get('/admin/pages')).body)
      const forms = [...list.querySelectorAll('form[action$="/translations"]')]
      expect(forms.length).toBeGreaterThan(0)
      expect(forms[0]!.querySelector('input[name="locale"]')!.getAttribute('value')).toBe('es')
    })
  })

  describe('deleting and restoring', () => {
    it('refuses to delete a testimonial that Home uses', async () => {
      const maria = await core.createEntry('testimonials', { fields: { author: 'María', quote: 'Great' } }, owner)
      const draft = (await core.getDocument(home.id))!
      await core.saveDraft(
        home.id,
        {
          baseRevisionId: draft.headRev,
          data: { ...draft.data, slots: { ...draft.data.slots, quotes: { enabled: true, data: { items: [maria.groupId] } } } },
        },
        owner,
      )
      expect((await eddie.get(`${editorUrl(maria.id)}/delete`)).statusCode).toBe(200)
      const res = await eddie.post(`${editorUrl(maria.id)}/delete`, {})
      expect(res.statusCode).toBe(409)
      const doc = parseHtml(res.body)
      expect(doc.querySelector(`a[href="${editorUrl(home.id)}"]`)!.textContent).toBe('Home')
      expect((await core.getDocument(maria.id))!.deletedAt).toBeNull()
    })

    it('deletes an unused post, which the owner can restore and the editor cannot', async () => {
      const post = await core.createEntry('posts', { fields: { title: 'Gone', date: '2026-01-02', body: rich('Hi') } }, owner)
      const res = await eddie.post(`${editorUrl(post.id)}/delete`, {})
      expect(res.statusCode).toBe(303)
      expect(res.headers.location).toBe('/admin/collections/posts?notice=deleted')
      expect((await eddie.get('/admin/collections/posts')).body).not.toContain('Gone')
      expect((await eddie.get(editorUrl(post.id))).statusCode).toBe(404)

      const listed = await boss.get('/admin/collections/posts?deleted=1')
      expect(listed.body).toContain('Gone')
      expect(parseHtml(listed.body).querySelector(`form[action="${editorUrl(post.id)}/restore"]`)).not.toBeNull()

      const denied = await eddie.post(`${editorUrl(post.id)}/restore`, {})
      expect(denied.statusCode).toBe(403)
      expect((await core.getDocument(post.id))!.deletedAt).not.toBeNull()

      const restored = await boss.post(`${editorUrl(post.id)}/restore`, {})
      expect(restored.statusCode).toBe(303)
      expect(restored.headers.location).toBe(`${editorUrl(post.id)}?notice=restored`)
      expect((await core.getDocument(post.id))!.deletedAt).toBeNull()
    })

    it('does not delete pages', async () => {
      expect((await eddie.get(`${editorUrl(home.id)}/delete`)).statusCode).toBe(404)
      expect((await eddie.post(`${editorUrl(home.id)}/delete`, {})).statusCode).toBe(404)
    })
  })

  describe('action bar', () => {
    it('has no Delete or Unpublish on Home', async () => {
      const doc = parseHtml((await eddie.get(editorUrl(home.id))).body)
      expect(doc.querySelector(`a[href$="/delete"]`)).toBeNull()
      expect((await eddie.get(editorUrl(home.id))).body).not.toContain('action=unpublish')
    })

    it('has Delete on a post and Unpublish once it is published', async () => {
      const post = await core.createEntry('posts', { fields: { title: 'Live', date: '2026-01-02', body: rich('Hi') } }, owner)
      const before = await eddie.get(editorUrl(post.id))
      expect(parseHtml(before.body).querySelector(`a[href="${editorUrl(post.id)}/delete"]`)).not.toBeNull()
      expect(before.body).not.toContain('action=unpublish')
      await core.publish([post.id], owner)
      expect((await eddie.get(editorUrl(post.id))).body).toContain('action=unpublish')
    })
  })
})
