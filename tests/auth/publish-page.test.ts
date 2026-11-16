import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import type { Core } from '../../src/core/core.js'
import { t } from '../../src/core/messages/index.js'
import type { Ctx, DocumentData } from '../../src/core/types.js'
import { escapeHtml } from '../../src/jsx/html.js'
import { parseHtml } from '../helpers/admin.js'
import { makeApp, OWNER_PASSWORD } from '../helpers/app.js'

const ORIGIN = 'https://example.com'

const rt = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

const open: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()))
})

/** Keeps the cookies responses set, as a browser would. */
class Jar {
  readonly cookies = new Map<string, string>()

  store(res: LightMyRequestResponse): this {
    const header = res.headers['set-cookie']
    const lines = header === undefined ? [] : Array.isArray(header) ? header : [header]
    for (const line of lines) {
      const [pair = ''] = line.split(';')
      const eq = pair.indexOf('=')
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
    return this
  }

  header(): Record<string, string> {
    if (this.cookies.size === 0) return {}
    return { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
  }
}

async function setup() {
  const made = await makeApp({ withOwner: true })
  open.push(made.app)
  await editHome(made.core, made.owner, 'Fresh headline')
  return made
}

async function editHome(core: Core, ctx: Ctx, headline: string) {
  const home = (await core.findSingleton('home', 'en'))!
  const view = (await core.getDocument(home.id))!
  const data: DocumentData = structuredClone(view.data)
  data.slots.hero!.data.headline = headline
  await core.saveDraft(view.id, { baseRevisionId: view.headRev, data }, ctx)
}

async function login(app: FastifyInstance): Promise<Jar> {
  const jar = new Jar()
  const res = await app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
    payload: new URLSearchParams({ email: 'owner@example.com', password: OWNER_PASSWORD }).toString(),
  })
  expect(res.statusCode).toBe(302)
  return jar.store(res)
}

const unescape = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** The hidden fields of the page's form. */
function hiddenFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const m of body.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[m[1]!] = unescape(m[2]!)
  return fields
}

function post(app: FastifyInstance, fields: Record<string, string>, jar: Jar, origin: string | null = ORIGIN) {
  return app.inject({
    method: 'POST',
    url: '/admin/publish',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(origin !== null && { origin }),
      ...jar.header(),
    },
    payload: new URLSearchParams(fields).toString(),
  })
}

const homeLive = async (core: Core) => {
  const doc = (await core.getDocument((await core.findSingleton('home', 'en'))!.id))!
  return doc.publishedRev === doc.headRev
}

describe('the publish page', () => {
  it('sends a visitor without a session to the login page', async () => {
    const { app } = await setup()
    const res = await app.inject('/admin/publish')
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(`/admin/login?next=${encodeURIComponent('/admin/publish')}`)
  })

  it('lists the pending changes with a Publish button', async () => {
    const { app } = await setup()
    const jar = await login(app)
    const res = await app.inject({ url: '/admin/publish', headers: jar.header() })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-robots-tag']).toBe('noindex')
    expect(res.body).toContain('Home')
    expect(res.body).toContain(escapeHtml('Hero → Headline'))
    expect(res.body).toMatch(new RegExp(`<button type="submit">${escapeHtml(t('admin.publish.submit'))}</button>`))
    expect(hiddenFields(res.body).action).toBe('publish')
  })

  it('lists only the documents asked for, by id', async () => {
    const { app, core } = await setup()
    const jar = await login(app)
    const home = (await core.findSingleton('home', 'en'))!
    const res = await app.inject({ url: `/admin/publish?ids=${home.id}&action=publish`, headers: jar.header() })
    expect(res.statusCode).toBe(200)
    expect(hiddenFields(res.body).ids).toBe(home.id)
    expect(JSON.parse(hiddenFields(res.body).expect!)).toEqual({ [home.id]: home.headRev })
  })

  it('says when there is nothing to publish', async () => {
    const { app, core, owner } = await setup()
    await core.publish((await core.listPendingChanges()).map((d) => d.id), owner)
    const jar = await login(app)
    const res = await app.inject({ url: '/admin/publish', headers: jar.header() })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(escapeHtml(t('admin.publish.nothing')))
    expect(res.body).not.toContain('<form method="post" action="/admin/publish"')
  })

  it('lists the problems of an incomplete draft, with no button', async () => {
    const { app, core, owner } = await setup()
    const post = await core.createEntry('posts', { slug: 'no-date', fields: { title: 'No date', body: rt('x') } }, owner)
    const jar = await login(app)
    const res = await app.inject({ url: `/admin/publish?ids=${post.id}`, headers: jar.header() })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('No date')
    expect(res.body).toContain(escapeHtml(t('issue.required', { field: 'Date' })))
    expect(res.body).not.toContain('<form method="post" action="/admin/publish"')
  })

  it('refuses a POST without the site origin', async () => {
    const { app, core } = await setup()
    const jar = await login(app)
    const page = await app.inject({ url: '/admin/publish', headers: jar.header() })
    const res = await post(app, hiddenFields(page.body), jar, null)
    expect(res.statusCode).toBe(403)
    expect(await homeLive(core)).toBe(false)
  })

  it('publishes what was shown and lists it with links', async () => {
    const { app, core } = await setup()
    const jar = await login(app)
    const page = await app.inject({ url: '/admin/publish', headers: jar.header() })
    const res = await post(app, hiddenFields(page.body), jar)
    expect(res.statusCode).toBe(200)
    expect(await homeLive(core)).toBe(true)
    expect(res.body).toContain(escapeHtml(t('admin.publish.done.title')))
    expect(res.body).toContain('href="/"')
    expect(res.body).toContain('Home')
  })

  it('publishes nothing when the content changed after the page was shown', async () => {
    const { app, core, owner } = await setup()
    const jar = await login(app)
    const page = await app.inject({ url: '/admin/publish', headers: jar.header() })
    await editHome(core, owner, 'Changed again')
    const res = await post(app, hiddenFields(page.body), jar)
    expect(res.statusCode).toBe(409)
    expect(res.body).toContain(escapeHtml(t('admin.publish.changed')))
    expect(res.body).toContain('href="/admin/publish')
    expect(await homeLive(core)).toBe(false)
  })

  it('refuses a POST that leaves out what was confirmed', async () => {
    const { app, core } = await setup()
    const jar = await login(app)
    const page = await app.inject({ url: '/admin/publish', headers: jar.header() })
    const { expect: _, ...rest } = hiddenFields(page.body)
    const res = await post(app, rest, jar)
    expect(res.statusCode).toBe(409)
    expect(await homeLive(core)).toBe(false)
  })
})

/** The publish dialog's view of a publish page: its `#publish-panel`. */
const panelOf = (html: string) => parseHtml(html).querySelector<HTMLElement>('#publish-panel')!

describe('the publish panel, which the publish dialog loads', () => {
  it('is a review with Publish and a Cancel that closes the dialog', async () => {
    const { app } = await setup()
    const jar = await login(app)
    const panel = panelOf((await app.inject({ url: '/admin/publish', headers: jar.header() })).body)
    expect(panel.dataset.state).toBe('review')
    expect(panel.dataset.title).toBe(t('admin.publish.title'))
    expect(panel.querySelector('form')!.dataset.busyLabel).toBe(t('admin.publish.busy'))
    expect(panel.querySelector('a[data-dialog-cancel]')!.textContent).toBe(t('admin.publish.cancel'))
  })

  it('is an unpublish review for unpublishing', async () => {
    const { app, core, owner } = await setup()
    const home = (await core.findSingleton('home', 'en'))!
    const post = await core.createEntry('posts', { slug: 'out', fields: { title: 'Out', date: '2026-01-02', body: rt('x') } }, owner)
    await core.publish([home.id, post.id], owner)
    const jar = await login(app)
    const panel = panelOf((await app.inject({ url: `/admin/publish?ids=${post.id}&action=unpublish`, headers: jar.header() })).body)
    expect(panel.dataset.state).toBe('unpublish')
    expect(panel.dataset.title).toBe(t('admin.unpublish.title'))
  })

  it("says what's in the way when the content isn't ready", async () => {
    const { app, core, owner } = await setup()
    const post = await core.createEntry('posts', { slug: 'no-date', fields: { title: 'No date', body: rt('x') } }, owner)
    const jar = await login(app)
    const panel = panelOf((await app.inject({ url: `/admin/publish?ids=${post.id}`, headers: jar.header() })).body)
    expect(panel.dataset.state).toBe('problems')
    expect(panel.dataset.title).toBe(t('admin.publish.blocked.title'))
  })

  it('says when there is nothing to publish, with a way out', async () => {
    const { app, core, owner } = await setup()
    await core.publish((await core.listPendingChanges()).map((d) => d.id), owner)
    const jar = await login(app)
    const panel = panelOf((await app.inject({ url: '/admin/publish', headers: jar.header() })).body)
    expect(panel.dataset.state).toBe('nothing')
    expect(panel.querySelector('a[data-dialog-cancel]')!.getAttribute('data-dialog-label')).toBe(t('admin.publish.close'))
  })

  it('without the dialog, goes back to where it came from and says it was published', async () => {
    const { app, core } = await setup()
    const home = (await core.findSingleton('home', 'en'))!
    const back = `/admin/documents/${home.id}`
    const jar = await login(app)
    const page = await app.inject({ url: `/admin/publish?ids=${home.id}&action=publish&back=${encodeURIComponent(back)}`, headers: jar.header() })
    const res = await post(app, hiddenFields(page.body), jar)
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe(`${back}?notice=published`)
    expect(await homeLive(core)).toBe(true)
  })

  it('in the dialog, says it was published, with a Close that falls back to the editor it came from', async () => {
    const { app, core } = await setup()
    const home = (await core.findSingleton('home', 'en'))!
    const back = `/admin/documents/${home.id}`
    const jar = await login(app)
    const page = await app.inject({ url: `/admin/publish?ids=${home.id}&action=publish&back=${encodeURIComponent(back)}`, headers: jar.header() })
    const res = await post(app, { ...hiddenFields(page.body), _dialog: '1' }, jar)
    expect(res.statusCode).toBe(200)
    const panel = panelOf(res.body)
    expect(panel.dataset.state).toBe('done')
    expect(panel.dataset.title).toBe(t('admin.publish.done.title'))
    const link = panel.querySelector('a[data-dialog-cancel]')!
    expect(link.getAttribute('href')).toBe(back)
    expect(link.textContent).toBe(t('admin.publish.backToEditor'))
  })

  it('says nothing was published when the content changed', async () => {
    const { app, core, owner } = await setup()
    const jar = await login(app)
    const page = await app.inject({ url: '/admin/publish', headers: jar.header() })
    await editHome(core, owner, 'Changed again')
    const panel = panelOf((await post(app, hiddenFields(page.body), jar)).body)
    expect(panel.dataset.state).toBe('changed')
    expect(panel.querySelector('a[href^="/admin/publish?"]')!.textContent).toBe(t('admin.publish.reload'))
  })
})

describe('the preview banner', () => {
  it('links to the publish page', async () => {
    const { app } = await setup()
    const link = new URL(app.inlay.previewUrl('/'))
    const opened = await app.inject(`${link.pathname}${link.search}`)
    const cookie = String([opened.headers['set-cookie']].flat()[0]).split(';')[0]!
    const res = await app.inject({ url: '/', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatch(/<div class="inlay-preview"[^>]*>.*<a href="\/admin\/publish"[^>]*>/)
    expect(res.body).toContain(escapeHtml(t('preview.publish')))
  })
})
