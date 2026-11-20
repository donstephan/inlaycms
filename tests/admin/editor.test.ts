import type { FastifyInstance } from 'fastify'
import type { Core } from '../../src/core/core.js'
import { t } from '../../src/core/messages/index.js'
import type { Ctx, DocumentData, DocumentSummary } from '../../src/core/types.js'
import { defineCollection, defineSite } from '../../src/core/registry/define.js'
import { adminSite, Kitchen } from '../fixtures/admin.js'
import { webSite } from '../fixtures/web.js'
import { jpeg, pdf } from '../fixtures/media.js'
import { makeApp } from '../helpers/app.js'
import { parseHtml, signIn, submittedForm, type AdminClient } from '../helpers/admin.js'

const SAVE = { submitter: { name: '_action', value: 'save' } }
const FORM = '#editor-form'
const HOSTILE = '"><script>alert(1)</script>'

const rich = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

/**
 * `adminSite`'s kitchen template as an unrouted collection, so each test can create kitchens that leave required
 * fields empty.
 */
const kitchenSite = defineSite({
  locales: adminSite.locales,
  defaultLocale: adminSite.defaultLocale,
  collections: [...adminSite.collections, defineCollection({ name: 'kitchens', label: 'Kitchens', template: Kitchen })],
})

const editorUrl = (id: string) => `/admin/documents/${id}`
const publishUrl = (id: string, action: string) =>
  `/admin/publish?${new URLSearchParams({ ids: id, action, back: editorUrl(id) }).toString()}`
const saveForm = (html: string, submitter = SAVE.submitter) => submittedForm(html, { form: FORM, submitter })

/** Every document of the site, in every locale it exists in. */
async function allDocuments(core: Core): Promise<DocumentSummary[]> {
  const { registry } = core
  const out: DocumentSummary[] = []
  for (const locale of registry.locales) {
    for (const def of [...registry.site.singletons, ...registry.site.globals]) {
      const doc = await core.findSingleton(def.name, locale)
      if (doc) out.push(doc)
    }
    for (const c of registry.site.collections) out.push(...(await core.listEntries(c.name, { locale })))
  }
  return out
}

/** Opens each document's editor and submits it untouched: nothing changes. */
async function expectUnchangedSaves(core: Core, client: AdminClient, docs: DocumentSummary[]): Promise<void> {
  for (const doc of docs) {
    const before = (await core.listRevisions(doc.id)).length
    const page = await client.get(editorUrl(doc.id))
    expect(page.statusCode, doc.title).toBe(200)
    const res = await client.post(editorUrl(doc.id), saveForm(page.body))
    expect(res.statusCode, `${doc.type} ${doc.locale}: ${res.body.slice(0, 2000)}`).toBe(303)
    expect(res.headers.location, doc.title).toBe(`${editorUrl(doc.id)}?notice=unchanged`)
    expect((await core.listRevisions(doc.id)).length, doc.title).toBe(before)
  }
}

describe('admin editor (web site)', () => {
  let app: FastifyInstance
  let core: Core
  let owner: Ctx
  let editor: Ctx
  let eddie: AdminClient
  let home: DocumentSummary

  beforeEach(async () => {
    ;({ app, core, owner, editor } = await makeApp({ withOwner: true }))
    await app.ready()
    eddie = await signIn(app, 'editor@example.com')
    home = (await core.findSingleton('home', 'en'))!
  })
  afterEach(() => app.close())

  const viaMcp = (): Ctx => ({ ...editor, source: 'mcp' })

  it('shows the Home editor: labels, slots in order, the optional slot switch, settings, status and languages', async () => {
    const res = await eddie.get(editorUrl(home.id))
    expect(res.statusCode).toBe(200)
    const doc = parseHtml(res.body)
    expect(doc.querySelector('h1')!.textContent).toBe('Home')
    expect(doc.querySelectorAll('h1')).toHaveLength(1)
    const form = doc.querySelector(FORM)!
    expect(form.getAttribute('method')).toBe('post')
    expect(form.getAttribute('action')).toBe(editorUrl(home.id))
    expect(form.querySelector('input[name="base"]')!.getAttribute('value')).toBe(String(home.headRev))
    expect(doc.querySelector('label[for="f-slots-hero-data-headline"]')!.textContent).toContain('Headline')
    const slots = [...doc.querySelectorAll('details[data-card] > summary h2')].map((h) => h.textContent)
    expect(slots).toEqual(['Home page', 'Hero', 'Testimonials'])
    const toggle = doc.querySelector('#f-slots-quotes-enabled')!
    expect(toggle.getAttribute('type')).toBe('checkbox')
    expect(toggle.hasAttribute('checked')).toBe(false)
    expect(doc.querySelector(`${FORM} details:not([data-card]) summary`)!.textContent).toBe(t('admin.form.seo'))
    expect(res.body).toContain(t('admin.status.published'))
    expect(doc.querySelector('main time[datetime]')).not.toBeNull()
    expect(res.body).toContain(t('source.release'))

    const languages = doc.querySelector(`nav[aria-label="${t('admin.editor.languages')}"]`)!
    const links = [...languages.querySelectorAll('a')]
    const es = (await core.findTranslation(home.groupId, 'es'))!
    expect(links.map((a) => a.getAttribute('href'))).toEqual([editorUrl(home.id), editorUrl(es.id)])
    expect(links[0]!.getAttribute('aria-current')).toBe('page')
    expect(links[1]!.hasAttribute('aria-current')).toBe(false)

    const actions = [...doc.querySelectorAll('button[form="editor-form"][name="_action"]')].map((b) => b.getAttribute('value'))
    expect(actions).toEqual(expect.arrayContaining(['save', 'preview', 'publish']))
    expect(doc.querySelector(`a[href="${editorUrl(home.id)}/history"]`)).not.toBeNull()
    expect(res.body).not.toContain('action=unpublish')
    expect(doc.querySelector('script[src*="editor.js"]')).not.toBeNull()
    expect(form.querySelector('[required]')).toBeNull()
  })

  it('lays the editor out as a header and a workspace with a live preview', async () => {
    const res = await eddie.get(editorUrl(home.id))
    expect(res.statusCode).toBe(200)
    const doc = parseHtml(res.body)
    const h1s = doc.querySelectorAll('h1')
    expect(h1s).toHaveLength(1)
    expect(h1s[0]!.textContent).toBe('Home')
    expect(h1s[0]!.closest('#workspace')).toBeNull()
    expect(doc.querySelector('#workspace')!.getAttribute('data-view')).toBe('edit')
    expect(doc.querySelector('#workspace #form-pane #editor-form')).not.toBeNull()
    expect(doc.querySelector('button[form="editor-form"][name="_action"][value="save"]')!.closest('#editor-form')).toBeNull()
    expect(doc.querySelector('#save-state')!.getAttribute('data-text-unsaved')).toBe(t('admin.editor.unsavedShort'))
    expect(doc.querySelectorAll('[data-view-btn="edit"], [data-view-btn="preview"]')).toHaveLength(2)
    const views = doc.querySelector('[data-view-btn="edit"]')!.parentElement!
    expect(views.getAttribute('role')).toBe('group')
    expect(views.getAttribute('aria-label')).toBe(t('admin.preview.views'))
    expect(doc.querySelector('[role="tab"], [role="tablist"]')).toBeNull()
    expect(doc.querySelector('[data-view-btn="edit"]')!.getAttribute('aria-pressed')).toBe('true')
    expect(doc.querySelector('[data-view-btn="preview"]')!.getAttribute('aria-pressed')).toBe('false')

    const frame = doc.querySelector('#preview-pane #preview-stage #preview-device iframe#preview-frame')!
    expect(frame.getAttribute('src')).toBe(`/admin/documents/${home.id}/preview`)
    expect(frame.getAttribute('data-preview-url')).toBe(`/admin/documents/${home.id}/preview`)
    expect(frame.getAttribute('data-blank-url')).toBe(`/admin/documents/${home.id}/preview/blank`)
    expect(frame.getAttribute('data-page-path')).toBe('/')
    expect(frame.getAttribute('title')).not.toBe('')
    expect(frame.hasAttribute('title')).toBe(true)

    const status = doc.querySelector('#preview-status')!
    for (const name of ['updating', 'ready', 'signed-out', 'failed']) {
      expect(status.getAttribute(`data-text-${name}`), name).toBeTruthy()
    }
    expect(status.getAttribute('data-text-failed')).toBe(t('admin.preview.failed'))
    const devices = [...doc.querySelectorAll('#preview-pane button[data-device]')]
    expect(devices.map((b) => [b.getAttribute('data-device'), b.getAttribute('aria-pressed')])).toEqual([
      ['desktop', 'true'],
      ['tablet', 'false'],
      ['phone', 'false'],
    ])
    expect(doc.querySelector('#preview-announce')!.getAttribute('role')).toBe('status')
    expect(doc.querySelector('#preview-hide')).not.toBeNull()
    expect(doc.querySelector('#preview-show')!.hasAttribute('hidden')).toBe(true)
  })

  it('has no preview pane for a global', async () => {
    const nav = (await core.findSingleton('nav', 'en'))!
    const doc = parseHtml((await eddie.get(editorUrl(nav.id))).body)
    expect(doc.querySelector('#workspace #form-pane #editor-form')).not.toBeNull()
    expect(doc.querySelector('#preview-pane')).toBeNull()
    expect(doc.querySelector('[data-view-btn]')).toBeNull()
    expect(doc.querySelector('#preview-show')).toBeNull()
  })

  it('keeps Save and preview, History and Delete in the More menu', async () => {
    const post = await core.createEntry('posts', { fields: { title: 'Menu', date: '2026-01-02', body: rich('Hi') } }, owner)
    await core.publish([post.id], owner)
    const doc = parseHtml((await eddie.get(editorUrl(post.id))).body)
    const menu = doc.querySelector(`details:has(> summary[aria-label="${t('admin.editor.more')}"])`)!
    expect(menu.closest('#editor-form')).toBeNull()
    const preview = menu.querySelector('button[form="editor-form"][name="_action"][value="preview"]')!
    expect(preview.textContent).toBe(t('admin.editor.preview'))
    expect(menu.querySelector(`a[href="${editorUrl(post.id)}/history"]`)).not.toBeNull()
    expect(menu.querySelector(`a[href="${publishUrl(post.id, 'unpublish')}"][data-publish-dialog]`)).not.toBeNull()
    expect(menu.querySelector(`a[href="${editorUrl(post.id)}/delete"]`)!.textContent).toBe(t('admin.editor.delete'))

    const homeMenu = parseHtml((await eddie.get(editorUrl(home.id))).body).querySelector(
      `details:has(> summary[aria-label="${t('admin.editor.more')}"])`,
    )!
    expect(homeMenu.querySelector('button[value="preview"]')).not.toBeNull()
    expect(homeMenu.querySelector(`a[href="${editorUrl(home.id)}/history"]`)).not.toBeNull()
    expect(homeMenu.querySelector('a[href$="/delete"]')).toBeNull()
  })

  it('shows Overwrite in the header on a conflict', async () => {
    const page = await eddie.get(editorUrl(home.id))
    await core.patchDraft(
      home.id,
      { baseRevisionId: home.headRev, ops: [{ path: ['slots', 'hero', 'data', 'headline'], value: 'Theirs' }] },
      viaMcp(),
    )
    const res = await eddie.post(editorUrl(home.id), saveForm(page.body))
    expect(res.statusCode).toBe(409)
    const doc = parseHtml(res.body)
    const overwrite = doc.querySelector('button[form="editor-form"][name="overwrite"]')!
    expect(overwrite.closest('#editor-form')).toBeNull()
    expect(overwrite.closest('#workspace')).toBeNull()
    expect(overwrite.getAttribute('value')).toBe(String((await core.getDocument(home.id))!.headRev))
  })

  it('submitting any document untouched changes nothing', async () => {
    await core.createEntry('testimonials', { fields: { author: 'María', quote: 'Great' } }, owner)
    await core.createEntry(
      'posts',
      { fields: { title: 'Hello', date: '2026-01-02', body: rich('Some text.'), seo: { title: 'Hi' } } },
      owner,
    )
    await expectUnchangedSaves(core, eddie, await allDocuments(core))
  })

  it('saves an edit as a new draft by the signed-in user from the admin', async () => {
    const page = await eddie.get(editorUrl(home.id))
    const form = saveForm(page.body)
    form.set('slots.hero.data.headline', 'Hello there')
    const res = await eddie.post(editorUrl(home.id), form)
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe(`${editorUrl(home.id)}?notice=saved`)
    const after = (await core.getDocument(home.id))!
    expect(after.data.slots.hero!.data.headline).toBe('Hello there')
    expect(after.revision.source).toBe('admin')
    expect(after.revision.authorName).toBe('Eddie Editor')
    expect(after.publishedRev).toBe(home.publishedRev)

    const shown = await eddie.get(res.headers.location as string)
    expect(shown.body).toContain(t('admin.notice.saved'))
    expect(shown.body).toContain(t('admin.status.changed'))
  })

  it('refuses a stale save with the other author named, keeping what was typed, until it is saved over', async () => {
    const page = await eddie.get(editorUrl(home.id))
    await core.patchDraft(
      home.id,
      { baseRevisionId: home.headRev, ops: [{ path: ['slots', 'hero', 'data', 'headline'], value: 'Theirs' }] },
      viaMcp(),
    )
    const form = saveForm(page.body)
    form.set('slots.hero.data.headline', 'Mine')
    const res = await eddie.post(editorUrl(home.id), form)
    expect(res.statusCode).toBe(409)
    const doc = parseHtml(res.body)
    expect(doc.querySelector('#f-slots-hero-data-headline')!.getAttribute('value')).toBe('Mine')
    const alert = doc.querySelector('[role="alert"]')!.textContent!
    expect(alert).toContain('Eddie Editor')
    expect(alert).toContain(t('source.mcp'))
    const head = (await core.getDocument(home.id))!
    const overwrite = doc.querySelector('button[name="overwrite"]')!
    expect(overwrite.getAttribute('value')).toBe(String(head.headRev))
    expect(overwrite.textContent).toBe(t('admin.editor.overwrite'))

    const again = await eddie.post(editorUrl(home.id), saveForm(res.body))
    expect(again.statusCode).toBe(409)
    expect((await core.getDocument(home.id))!.data.slots.hero!.data.headline).toBe('Theirs')

    const over = await eddie.post(editorUrl(home.id), saveForm(again.body, { name: 'overwrite', value: String(head.headRev) }))
    expect(over.statusCode).toBe(303)
    expect(over.headers.location).toBe(`${editorUrl(home.id)}?notice=saved`)
    expect((await core.getDocument(home.id))!.data.slots.hero!.data.headline).toBe('Mine')
  })

  it('adds, removes and moves list items without saving', async () => {
    const nav = (await core.findSingleton('nav', 'en'))!
    const data = (await core.getDocument(nav.id))!.data
    const links = [...(data.fields.links as unknown[]), { link: { url: '/about', text: 'About' } }]
    await core.saveDraft(nav.id, { baseRevisionId: nav.headRev, data: { ...data, fields: { links } } }, owner)
    const before = (await core.listRevisions(nav.id)).length

    const page = await eddie.get(editorUrl(nav.id))
    const items = (html: string) => parseHtml(html).querySelectorAll(`${FORM} input[name$="._item"]`).length
    expect(items(page.body)).toBe(2)

    const form = submittedForm(page.body, { form: FORM })
    form.set('fields.links.0.link.text', 'Typed')
    form.set('_op', 'add:fields.links')
    const added = await eddie.post(editorUrl(nav.id), form)
    expect(added.statusCode).toBe(200)
    expect(items(added.body)).toBe(3)
    expect(added.body).toContain('Typed')
    expect(added.body).toContain(t('admin.editor.unsaved'))

    const htmx = await eddie.post(editorUrl(nav.id), form, { 'hx-request': 'true' })
    expect(htmx.statusCode).toBe(200)
    expect(parseHtml(htmx.body).querySelector(FORM)).not.toBeNull()

    for (const op of ['remove:fields.links.99', 'add:fields.title', 'nonsense', 'remove:__proto__.x']) {
      const odd = submittedForm(page.body, { form: FORM })
      odd.set('_op', op)
      const res = await eddie.post(editorUrl(nav.id), odd)
      expect(res.statusCode, op).toBe(200)
      expect(items(res.body), op).toBe(2)
    }
    expect((await core.listRevisions(nav.id)).length).toBe(before)
  })

  it('keeps open items open across a list operation', async () => {
    const nav = (await core.findSingleton('nav', 'en'))!
    const data = (await core.getDocument(nav.id))!.data
    const links = [...(data.fields.links as unknown[]), { link: { url: '/about', text: 'About' } }]
    await core.saveDraft(nav.id, { baseRevisionId: nav.headRev, data: { ...data, fields: { links } } }, owner)

    const page = await eddie.get(editorUrl(nav.id))
    const form = submittedForm(page.body, { form: FORM })
    form.set('_op', 'up:fields.links.1')
    form.set('_open', 'fields.links.1')
    form.set('_closed', 'fields')
    const res = await eddie.post(editorUrl(nav.id), form, { 'hx-request': 'true' })
    expect(res.statusCode).toBe(200)
    const doc = parseHtml(res.body)
    expect(doc.querySelector('details[data-item="fields.links.0"]')!.hasAttribute('open')).toBe(true)
    expect(doc.querySelector('details[data-item="fields.links.1"]')!.hasAttribute('open')).toBe(false)
    expect(doc.querySelector('details[data-card="fields"]')!.hasAttribute('open')).toBe(false)
  })

  it('saves, then opens a preview of the page', async () => {
    const about = (await core.findSingleton('about', 'en'))!
    const page = await eddie.get(editorUrl(about.id))
    const res = await eddie.post(editorUrl(about.id), saveForm(page.body, { name: '_action', value: 'preview' }))
    expect(res.statusCode).toBe(303)
    const location = res.headers.location as string
    expect(location.startsWith('https://example.com/_inlay/preview?')).toBe(true)
    expect(new URL(location).searchParams.get('path')).toBe('/about')

    const nav = (await core.findSingleton('nav', 'en'))!
    const navPage = await eddie.get(editorUrl(nav.id))
    const navRes = await eddie.post(editorUrl(nav.id), saveForm(navPage.body, { name: '_action', value: 'preview' }))
    expect(new URL(navRes.headers.location as string).searchParams.get('path')).toBe('/')
  })

  it('saves, then goes to the publish review page, which comes back to the editor', async () => {
    const page = await eddie.get(editorUrl(home.id))
    const form = saveForm(page.body, { name: '_action', value: 'publish' })
    form.set('fields.title', 'Home again')
    const res = await eddie.post(editorUrl(home.id), form)
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe(publishUrl(home.id, 'publish'))
    expect((await core.getDocument(home.id))!.data.fields.title).toBe('Home again')
  })

  it('with JS, saves, then comes back to the editor to open the publish dialog', async () => {
    const page = await eddie.get(editorUrl(home.id))
    const form = saveForm(page.body, { name: '_action', value: 'publish' })
    form.set('fields.title', 'Home in a dialog')
    form.set('_dialog', '1')
    const res = await eddie.post(editorUrl(home.id), form)
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe(`${editorUrl(home.id)}?review=publish`)
    expect((await core.getDocument(home.id))!.data.fields.title).toBe('Home in a dialog')

    const back = parseHtml((await eddie.get(res.headers.location as string)).body)
    expect(back.querySelector('[data-publish-open]')!.getAttribute('data-publish-open')).toBe(publishUrl(home.id, 'publish'))
    expect(parseHtml(page.body).querySelector('[data-publish-open]')).toBeNull()
  })

  it('opens Save and publish in the publish dialog', async () => {
    const doc = parseHtml((await eddie.get(editorUrl(home.id))).body)
    expect(doc.querySelector('button[form="editor-form"][name="_action"][value="publish"][data-publish-dialog]')).not.toBeNull()
    for (const id of ['editor-status', 'editor-more', 'topbar-publish']) expect(doc.querySelector(`#${id}[data-refresh]`)).not.toBeNull()
    expect(doc.querySelector('#editor-form')!.hasAttribute('data-save-errors')).toBe(false)
  })

  it('marks a page showing a failed save, so Save and publish submits it the ordinary way', async () => {
    const page = await eddie.get(editorUrl(home.id))
    const form = saveForm(page.body)
    form.set('base', 'nope')
    const res = await eddie.post(editorUrl(home.id), form)
    expect(res.statusCode).toBe(400)
    expect(parseHtml(res.body).querySelector('#editor-form')!.hasAttribute('data-save-errors')).toBe(true)
  })

  it('links published entries to unpublishing', async () => {
    const post = await core.createEntry('posts', { fields: { title: 'Out', date: '2026-01-02', body: rich('Hi') } }, owner)
    await core.publish([post.id], owner)
    const res = await eddie.get(editorUrl(post.id))
    expect(parseHtml(res.body).querySelector(`a[href="${publishUrl(post.id, 'unpublish')}"]`)).not.toBeNull()
    expect(parseHtml(res.body).querySelector('#f-slug')).not.toBeNull()
    expect(parseHtml(res.body).querySelector('#f-path')).not.toBeNull()
  })

  it('shows what is needed before publishing next to the field', async () => {
    const page = await eddie.get(editorUrl(home.id))
    const form = saveForm(page.body)
    form.set('fields.title', '')
    expect((await eddie.post(editorUrl(home.id), form)).statusCode).toBe(303)
    const res = await eddie.get(editorUrl(home.id))
    const doc = parseHtml(res.body)
    const title = doc.querySelector('#f-fields-title')!
    const describedBy = title.getAttribute('aria-describedby')!.split(' ')
    expect(describedBy).toContain('f-fields-title-hint')
    expect(doc.querySelector('#f-fields-title-hint')!.textContent).toContain('Needed before publishing')
    expect(title.hasAttribute('aria-invalid')).toBe(false)
  })

  it('refuses a form without a usable base', async () => {
    const page = await eddie.get(editorUrl(home.id))
    for (const base of [null, '', 'abc', '1.5']) {
      const form = saveForm(page.body)
      if (base === null) form.delete('base')
      else form.set('base', base)
      form.set('fields.title', 'Typed title')
      const res = await eddie.post(editorUrl(home.id), form)
      expect(res.statusCode, String(base)).toBe(400)
      const doc = parseHtml(res.body)
      expect(doc.querySelector('[role="alert"]')!.textContent).toContain(t('admin.editor.badBase'))
      expect(doc.querySelector('#f-fields-title')!.getAttribute('value')).toBe('Typed title')
    }
    expect((await core.getDocument(home.id))!.headRev).toBe(home.headRev)
  })

  it('answers 404 for unknown and deleted documents', async () => {
    expect((await eddie.get(editorUrl('nope'))).statusCode).toBe(404)
    expect((await eddie.post(editorUrl('nope'), { base: '1', _action: 'save' })).statusCode).toBe(404)

    const post = await core.createEntry('posts', { fields: { title: 'Gone', date: '2026-01-02', body: rich('Hi') } }, owner)
    await core.deleteEntry(post.groupId, owner)
    const res = await eddie.get(editorUrl(post.id))
    expect(res.statusCode).toBe(404)
    expect(parseHtml(res.body).querySelector('main a[href="/admin/collections/posts"]')).not.toBeNull()
    expect((await eddie.post(editorUrl(post.id), { base: String(post.headRev), _action: 'save' })).statusCode).toBe(404)
  })

  it('refuses a post from another site, and sends a visitor without a session to log in', async () => {
    const page = await eddie.get(editorUrl(home.id))
    const form = saveForm(page.body)
    form.set('fields.title', 'Evil')
    const cross = await app.inject({
      method: 'POST',
      url: editorUrl(home.id),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example', cookie: eddie.cookie },
      payload: form.toString(),
    })
    expect(cross.statusCode).toBe(403)
    expect((await core.getDocument(home.id))!.headRev).toBe(home.headRev)

    const anon = await app.inject({ method: 'GET', url: editorUrl(home.id) })
    expect(anon.statusCode).toBe(302)
    expect(anon.headers.location).toContain('/admin/login')
  })

  it('escapes content written by the assistant', async () => {
    await core.patchDraft(
      home.id,
      {
        baseRevisionId: home.headRev,
        ops: [
          { path: ['fields', 'title'], value: HOSTILE },
          { path: ['slots', 'hero', 'data', 'headline'], value: HOSTILE },
        ],
      },
      viaMcp(),
    )
    const res = await eddie.get(editorUrl(home.id))
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('<script>alert(1)')
    expect(res.headers['content-security-policy']).toContain("script-src 'self'")
    const doc = parseHtml(res.body)
    expect(doc.querySelector('#f-fields-title')!.getAttribute('value')).toBe(HOSTILE)
    expect(doc.querySelector('#f-slots-hero-data-headline')!.getAttribute('value')).toBe(HOSTILE)
    await expectUnchangedSaves(core, eddie, [(await core.findSingleton('home', 'en'))!])

    const post = await core.createEntry('posts', { fields: { title: HOSTILE, date: '2026-01-02', body: rich('</script>') } }, viaMcp())
    const postPage = await eddie.get(editorUrl(post.id))
    expect(postPage.body).not.toContain('<script>alert(1)')
    expect(postPage.body.match(/<\/script>/g)).toHaveLength(2)
    expect(parseHtml(postPage.body).querySelector('h1')!.textContent).toBe(HOSTILE)
  })

  it('never answers a very large rich text with a server error', async () => {
    const about = (await core.findSingleton('about', 'en'))!
    const page = await eddie.get(editorUrl(about.id))
    const form = saveForm(page.body)
    const text = 'a'.repeat(3 * 1024 * 1024)
    form.set('fields.body', JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }))
    const res = await eddie.post(editorUrl(about.id), form)
    expect([303, 400, 413]).toContain(res.statusCode)
  })
})

describe('admin editor (every field kind)', () => {
  let app: FastifyInstance
  let core: Core
  let owner: Ctx
  let eddie: AdminClient
  let kitchen: DocumentSummary

  beforeEach(async () => {
    ;({ app, core, owner } = await makeApp({ withOwner: true, site: kitchenSite }))
    await app.ready()
    eddie = await signIn(app, 'editor@example.com')
    kitchen = await core.createEntry('kitchens', { fields: { title: 'Kitchen', tone: 'calm' } }, owner)
  })
  afterEach(() => app.close())

  /** Every field of the kitchen filled, including media, references, links, rich text and a datetime with an offset. */
  async function fillKitchen(): Promise<void> {
    const image = (await core.addMedia({ data: await jpeg(40, 30), filename: 'photo.jpg' }, owner)).media
    const file = (await core.addMedia({ data: pdf(), filename: 'guide.pdf' }, owner)).media
    const maria = await core.createEntry('testimonials', { fields: { author: 'María', quote: 'Great' } }, owner)
    const juan = await core.createEntry('testimonials', { fields: { author: 'Juan', quote: 'Lovely' } }, owner)
    const post = await core.createEntry('posts', { fields: { title: 'A post', date: '2026-01-02', body: rich('Hi') } }, owner)
    const data: DocumentData = {
      fields: {
        title: 'Kitchen',
        intro: 'Line one\nLine two',
        count: 3.5,
        featured: true,
        tone: 'bold',
        day: '2026-03-01',
        at: '2026-03-01T11:30:00.000+02:00',
        contact: { email: 'a@example.com', phone: '555' },
        faq: [
          { question: 'Why?', answer: 'Because.' },
          { question: 'How?', answer: 'Like this.' },
        ],
        seo: { title: 'SEO title', description: 'SEO description', image: { media: image.id, alt: 'Alt' } },
        custom: { x: 1 },
        hero: { media: image.id, alt: 'Hero alt' },
        doc: { media: file.id },
        quote: maria.groupId,
        quotes: [maria.groupId, juan.groupId],
        cta: { document: post.groupId, text: 'Read the post' },
        more: { url: 'https://example.com/more', text: 'More' },
        body: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'See ' },
                { type: 'text', text: 'the post', marks: [{ type: 'link', attrs: { document: post.groupId } }] },
                { type: 'text', text: ' and ' },
                { type: 'text', text: 'this', marks: [{ type: 'link', attrs: { href: 'https://example.com/' } }, { type: 'bold' }] },
                { type: 'image', attrs: { media: image.id, alt: 'A picture' } },
              ],
            },
          ],
        },
      },
      slots: { extra: { enabled: false, data: { text: 'kept' } } },
    }
    const res = await core.saveDraft(kitchen.id, { baseRevisionId: kitchen.headRev, data }, owner)
    expect(res.changed).toBe(true)
  }

  it('submitting every field kind untouched changes nothing', async () => {
    await fillKitchen()
    await expectUnchangedSaves(core, eddie, await allDocuments(core))
  })

  it('saves a multi-line textarea untouched without a new revision, and an edit with LF newlines', async () => {
    const data: DocumentData = {
      fields: { title: 'Kitchen', featured: false, tone: 'calm', intro: 'Line one\nLine two\n\nLine four' },
      slots: { extra: { enabled: false, data: { text: 'kept' } } },
    }
    expect((await core.saveDraft(kitchen.id, { baseRevisionId: kitchen.headRev, data }, owner)).changed).toBe(true)
    const page = await eddie.get(editorUrl(kitchen.id))
    const form = saveForm(page.body)
    expect(form.get('fields.intro')).toBe('Line one\r\nLine two\r\n\r\nLine four')
    await expectUnchangedSaves(core, eddie, [(await core.findTranslation(kitchen.groupId, 'en'))!])

    const edited = saveForm((await eddie.get(editorUrl(kitchen.id))).body)
    edited.set('fields.intro', 'New one\r\nNew two')
    expect((await eddie.post(editorUrl(kitchen.id), edited)).statusCode).toBe(303)
    expect((await core.getDocument(kitchen.id))!.data.fields.intro).toBe('New one\nNew two')
  })

  it('reads a required group that was never filled in as empty and keeps a list absent when submitted untouched', async () => {
    const data: DocumentData = {
      fields: { title: 'Kitchen', featured: false, tone: 'calm' },
      slots: { extra: { enabled: false, data: { text: 'kept' } } },
    }
    expect((await core.saveDraft(kitchen.id, { baseRevisionId: kitchen.headRev, data }, owner)).changed).toBe(true)
    const stored = (await core.getDocument(kitchen.id))!.data
    expect(stored.fields.contact).toEqual({})
    expect(Object.hasOwn(stored.fields, 'faq')).toBe(false)
    await expectUnchangedSaves(core, eddie, [(await core.findTranslation(kitchen.groupId, 'en'))!])
  })

  it('shows a bad number next to its field and keeps everything typed', async () => {
    await fillKitchen()
    const head = (await core.getDocument(kitchen.id))!.headRev
    const page = await eddie.get(editorUrl(kitchen.id))
    const form = saveForm(page.body)
    form.set('fields.count', '12abc')
    form.set('fields.contact.email', 'typed@example.com')
    const res = await eddie.post(editorUrl(kitchen.id), form)
    expect(res.statusCode).toBe(400)
    const doc = parseHtml(res.body)
    const count = doc.querySelector('#f-fields-count')!
    expect(count.getAttribute('aria-invalid')).toBe('true')
    expect(count.getAttribute('value')).toBe('12abc')
    expect(doc.querySelector('#f-fields-count-problem')!.textContent).toContain('Count')
    expect(doc.querySelector('#f-fields-contact-email')!.getAttribute('value')).toBe('typed@example.com')
    expect((await core.getDocument(kitchen.id))!.headRev).toBe(head)
  })

  it('keeps an impossible date as typed and never touches Object.prototype', async () => {
    const page = await eddie.get(editorUrl(kitchen.id))
    const form = saveForm(page.body)
    form.set('fields.at', '2026-02-30T10:00:00')
    form.set('__proto__.x', 'polluted')
    form.set('constructor.prototype.y', 'polluted')
    const res = await eddie.post(editorUrl(kitchen.id), form)
    expect(res.statusCode).toBe(400)
    expect(parseHtml(res.body).querySelector('#f-fields-at')!.getAttribute('aria-invalid')).toBe('true')
    expect(({} as Record<string, unknown>).x).toBeUndefined()
    expect(({} as Record<string, unknown>).y).toBeUndefined()
  })
})

describe('admin editor preview pane (trailingSlash)', () => {
  let app: FastifyInstance | undefined
  afterEach(() => app?.close())

  async function pane(trailingSlash: 'always' | 'never', singleton: string) {
    const made = await makeApp({ site: defineSite({ ...webSite, trailingSlash }), withOwner: true })
    app = made.app
    await app.ready()
    const eddie = await signIn(app, 'editor@example.com')
    const summary = (await made.core.findSingleton(singleton, 'en'))!
    const doc = parseHtml((await eddie.get(editorUrl(summary.id))).body)
    return {
      address: doc.querySelector('#preview-pane .rounded-field span.truncate')!.textContent,
      pagePath: doc.querySelector('iframe#preview-frame')!.getAttribute('data-page-path'),
    }
  }

  it("shows and keeps the page's slashed path under 'always'", async () => {
    expect(await pane('always', 'about')).toEqual({ address: '/about/', pagePath: '/about/' })
  })

  it("leaves the home page at the root under 'always'", async () => {
    expect(await pane('always', 'home')).toEqual({ address: '/', pagePath: '/' })
  })

  it("keeps the slashless path under 'never'", async () => {
    expect(await pane('never', 'about')).toEqual({ address: '/about', pagePath: '/about' })
  })
})
