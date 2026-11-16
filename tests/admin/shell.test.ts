import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { noticeOf, type AdminContext } from '../../src/adapters/admin/context.js'
import { resolveTheme } from '../../src/adapters/admin/theme.js'
import { adminPage } from '../../src/adapters/admin/views/layout.js'
import { t } from '../../src/core/messages/index.js'
import { defineSite } from '../../src/core/registry/define.js'
import { raw } from '../../src/jsx/html.js'
import { parseHtml, signIn, submittedForm } from '../helpers/admin.js'
import { makeApp } from '../helpers/app.js'
import { webSite } from '../fixtures/web.js'

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

const open: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()))
})

const branded = defineSite({ ...webSite, admin: { name: 'Example Studio' } })

async function setup() {
  const made = await makeApp({ withOwner: true, site: branded })
  open.push(made.app)
  return made
}

async function noOwner() {
  const made = await makeApp({ site: branded })
  open.push(made.app)
  return made
}

const navLinks = (html: string) =>
  [...parseHtml(html).querySelectorAll('nav a[href]')].map((a) => ({ href: a.getAttribute('href'), text: a.textContent?.trim() }))

function expectStructure(res: LightMyRequestResponse) {
  const doc = parseHtml(res.body)
  expect(doc.querySelectorAll('h1').length, res.raw.req.url).toBe(1)
  expect(doc.querySelector('a[href="#main"]'), res.raw.req.url).not.toBeNull()
  expect(doc.querySelector('main#main'), res.raw.req.url).not.toBeNull()
}

describe('navigation', () => {
  it('shows an editor every section but Users and Backups', async () => {
    const { app } = await setup()
    const editor = await signIn(app, 'editor@example.com')
    const res = await editor.get('/admin')
    expect(res.statusCode).toBe(200)
    const links = navLinks(res.body)
    const hrefs = links.map((l) => l.href)
    for (const href of ['/admin', '/admin/pages', '/admin/globals', '/admin/collections/posts', '/admin/media', '/admin/redirects', '/admin/account']) {
      expect(hrefs).toContain(href)
    }
    const posts = parseHtml(res.body).querySelector('nav a[href="/admin/collections/posts"] > span:not(.badge)')
    expect(posts?.textContent?.trim()).toBe('Posts')
    expect(hrefs).not.toContain('/admin/users')
    expect(hrefs).not.toContain('/admin/backups')
    expect(parseHtml(res.body).querySelector('nav form[action="/admin/logout"] button')).not.toBeNull()
  })

  it('shows the owner Users and Backups', async () => {
    const { app } = await setup()
    const owner = await signIn(app, 'owner@example.com')
    const hrefs = navLinks((await owner.get('/admin')).body).map((l) => l.href)
    expect(hrefs).toContain('/admin/users')
    expect(hrefs).toContain('/admin/backups')
  })

  it('shows the owner Releases only when the site has a releases folder', async () => {
    const { app } = await setup()
    const owner = await signIn(app, 'owner@example.com')
    expect(navLinks((await owner.get('/admin')).body).map((l) => l.href)).not.toContain('/admin/releases')

    const made = await makeApp({ withOwner: true, site: branded, releasesDir: '/nonexistent/releases' })
    open.push(made.app)
    const olivia = await signIn(made.app, 'owner@example.com')
    const links = navLinks((await olivia.get('/admin')).body)
    expect(links.find((l) => l.href === '/admin/releases')?.text).toBe(t('admin.nav.releases'))
    const eddie = await signIn(made.app, 'editor@example.com')
    expect(navLinks((await eddie.get('/admin')).body).map((l) => l.href)).not.toContain('/admin/releases')
  })

  it('marks the current section', async () => {
    const { app } = await setup()
    const owner = await signIn(app, 'owner@example.com')
    const current = parseHtml((await owner.get('/admin')).body).querySelectorAll('nav [aria-current="page"]')
    expect([...current].map((a) => a.getAttribute('href'))).toEqual(['/admin'])
  })

  it('groups the menu and counts entries', async () => {
    const { app, core, editor } = await setup()
    await core.createEntry('posts', { fields: { title: 'Counted', date: '2026-02-01' } }, editor)
    const total = (await core.countEntries()).posts?.total
    expect(total).toBeGreaterThan(0)
    const owner = await signIn(app, 'owner@example.com')
    const doc = parseHtml((await owner.get('/admin')).body)
    const titles = [...doc.querySelectorAll('nav[aria-label="Main menu"] .menu-title')].map((li) => li.textContent?.trim())
    expect(titles).toEqual(['Content', 'Site'])
    const badge = doc.querySelector('nav a[href="/admin/collections/posts"] .badge')
    expect(badge?.textContent?.trim()).toBe(String(total))
    expect(doc.querySelector('nav a[href="/admin/media"] .badge')).toBeNull()
  })

  it('puts the search, View site and Publish in the top bar', async () => {
    const { app } = await setup()
    const owner = await signIn(app, 'owner@example.com')
    const doc = parseHtml((await owner.get('/admin')).body)
    const toggle = doc.querySelector('input#admin-nav-toggle')
    expect(toggle?.getAttribute('aria-label')).toBe(t('admin.nav.open'))
    expect(toggle?.className).toContain('lg:hidden')
    const search = doc.querySelector('form[role="search"][action="/admin/search"][method="get"]')
    expect(search).not.toBeNull()
    expect(search!.querySelector('input#global-search[name="q"][type="search"]')).not.toBeNull()
    const input = search!.querySelector('input#global-search')!
    expect(input.getAttribute('role')).toBe('combobox')
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.getAttribute('aria-controls')).toBe('global-search-results')
    expect(input.getAttribute('hx-get')).toBe('/admin/search')
    expect(search!.querySelector('div#global-search-results')?.innerHTML).toBe('')
    expect(doc.querySelector(`label[for="global-search"]`)?.textContent).toContain(t('admin.search.label'))
    expect(doc.querySelector('a[href="/"]')?.textContent).toContain(t('admin.topbar.viewSite'))
    expect(doc.querySelector('a[href="/admin/publish"]')?.textContent).toContain(t('admin.topbar.publish'))
  })

  it('opens Publish in the publish dialog, which every page carries', async () => {
    const { app } = await setup()
    const owner = await signIn(app, 'owner@example.com')
    const doc = parseHtml((await owner.get('/admin')).body)
    expect(doc.querySelector('a[href="/admin/publish"][data-publish-dialog]')).not.toBeNull()
    const dialog = doc.querySelector('dialog#publish-dialog')!
    expect(dialog.getAttribute('aria-labelledby')).toBe('publish-dialog-title')
    expect(dialog.querySelector('#publish-dialog-body')!.innerHTML).toBe('')
    const icons = [...dialog.querySelectorAll('[data-state-icon]')].map((icon) => icon.getAttribute('data-state-icon'))
    expect(icons).toEqual(['review', 'unpublish', 'done', 'problems', 'changed'])
  })

  it('shows how many changes wait to be published', async () => {
    const { app, core, editor } = await setup()
    const owner = await signIn(app, 'owner@example.com')
    expect(await core.listPendingChanges()).toHaveLength(0)
    const before = parseHtml((await owner.get('/admin')).body).querySelector('a[href="/admin/publish"]')!
    expect(before.querySelector('.badge')).toBeNull()
    expect(before.textContent).not.toContain(t('admin.topbar.pending', { count: 0 }))

    await core.createEntry('posts', { fields: { title: 'Waiting', date: '2026-02-01' } }, editor)
    const after = parseHtml((await owner.get('/admin')).body).querySelector('a[href="/admin/publish"]')!
    expect(after.querySelector('.badge')?.textContent?.trim()).toBe('1')
    expect(after.querySelector('.sr-only')?.textContent).toBe(t('admin.topbar.pending', { count: 1 }))
  })

  it('keeps the brand in the first header and log out inside the main nav', async () => {
    const { app } = await setup()
    const owner = await signIn(app, 'owner@example.com')
    const doc = parseHtml((await owner.get('/admin')).body)
    expect(doc.querySelector('header')!.textContent).toContain('Example Studio')
    const nav = doc.querySelector('nav[aria-label="Main menu"]')!
    expect(nav.querySelector('form[action="/admin/logout"][method="post"] button')).not.toBeNull()
    expect(nav.querySelector('details summary')?.textContent).toContain('Olivia Owner')
    expect(nav.querySelector('details a[href="/admin/account"]')).not.toBeNull()
  })

  it('marks Your account as current on the account page', async () => {
    const { app } = await setup()
    const owner = await signIn(app, 'owner@example.com')
    const current = parseHtml((await owner.get('/admin/account')).body).querySelectorAll('nav [aria-current="page"]')
    expect([...current].map((a) => a.getAttribute('href'))).toEqual(['/admin/account'])
  })
})

describe('page header', () => {
  it('shows a page description and actions when given', async () => {
    const { app, core, service, owner } = await setup()
    const ctx: AdminContext = {
      service,
      core,
      baseUrl: 'https://example.com',
      secret: 'x'.repeat(32),
      now: () => new Date(),
      uploads: { maxBytes: 1024, types: [] },
      branding: { name: 'Example Studio', theme: resolveTheme() },
      assets: { url: (name) => `/admin/assets/${name}`, read: async () => null },
    }
    await app.ready()
    const plain = parseHtml(await adminPage(ctx, { title: 'Plain', actor: owner.actor }, 'Body'))
    expect(plain.querySelector('main#main h1 + p')).toBeNull()

    const html = await adminPage(
      ctx,
      { title: 'Things', actor: owner.actor, description: 'All the things', actions: raw('<a href="/admin/things/new">Add thing</a>') },
      'Body',
    )
    const doc = parseHtml(html)
    const h1 = doc.querySelector('main#main h1')!
    expect(h1.textContent).toBe('Things')
    expect(doc.querySelector('main#main h1 + p')?.textContent).toBe('All the things')
    expect(doc.querySelector('main#main a[href="/admin/things/new"]')?.textContent).toBe('Add thing')
  })

  it('renders a workspace page as a compact header over a full-height body', async () => {
    const { app, core, service, owner } = await setup()
    const ctx: AdminContext = {
      service,
      core,
      baseUrl: 'https://example.com',
      secret: 'x'.repeat(32),
      now: () => new Date(),
      uploads: { maxBytes: 1024, types: [] },
      branding: { name: 'Example Studio', theme: resolveTheme() },
      assets: { url: (name) => `/admin/assets/${name}`, read: async () => null },
    }
    await app.ready()
    const html = await adminPage(
      ctx,
      {
        title: 'Work',
        actor: owner.actor,
        layout: 'workspace',
        breadcrumbs: [{ label: 'Pages', href: '/admin/pages' }],
        actions: raw('<button type="button" id="do-it">Do it</button>'),
      },
      raw('<div id="work-body">Body</div>'),
    )
    const doc = parseHtml(html)
    const h1s = doc.querySelectorAll('h1')
    expect(h1s).toHaveLength(1)
    expect(h1s[0]!.textContent).toBe('Work')
    expect(doc.querySelector('main#main #do-it')?.textContent).toBe('Do it')
    expect(doc.querySelector('main#main nav a[href="/admin/pages"]')).not.toBeNull()
    expect(doc.querySelector('main#main #work-body')).not.toBeNull()
    const main = doc.querySelector('main#main')!
    for (const padding of ['px-4', 'py-4', 'lg:px-6', 'lg:py-5']) expect(main.classList.contains(padding), padding).toBe(false)
    expect(main.closest('.drawer-content')!.classList.contains('h-screen')).toBe(true)

    const plain = parseHtml(await adminPage(ctx, { title: 'Plain', actor: owner.actor }, 'Body'))
    expect(plain.querySelector('main#main')!.classList.contains('px-4')).toBe(true)
    expect(plain.querySelector('.drawer-content')!.classList.contains('min-h-screen')).toBe(true)
  })
})

describe('branding', () => {
  it('shows the brand name in the header and on the login page, with the theme', async () => {
    const { app } = await setup()
    const owner = await signIn(app, 'owner@example.com')
    const home = parseHtml((await owner.get('/admin')).body)
    expect(home.querySelector('header')?.textContent).toContain('Example Studio')
    expect(home.documentElement.getAttribute('data-theme')).toBe('inlay')
    expect(home.querySelector('style')?.textContent).toContain('--color-primary:')
    const login = await app.inject({ method: 'GET', url: '/admin/login' })
    expect(login.body).toContain('Example Studio')
    expect(parseHtml(login.body).documentElement.getAttribute('data-theme')).toBe('inlay')
  })

  it('shows the logo from the site as an image named after the brand', async () => {
    const made = await makeApp({ site: defineSite({ ...webSite, admin: { name: 'Example Studio', logo: '/public/logo.svg' } }) })
    open.push(made.app)
    const login = parseHtml((await made.app.inject({ method: 'GET', url: '/admin/login' })).body)
    const img = login.querySelector('img[src="/public/logo.svg"]')
    expect(img?.getAttribute('alt')).toBe('Example Studio')
    expect((await made.app.inject({ method: 'GET', url: '/admin/assets/logo' })).statusCode).toBe(404)
  })

  it('shows the brand name alone without a logo', async () => {
    const { app } = await noOwner()
    const login = parseHtml((await app.inject({ method: 'GET', url: '/admin/login' })).body)
    expect(login.querySelector('img')).toBeNull()
    expect(login.body.textContent).toContain('Example Studio')
  })

  it('links the built CSS and JavaScript and configures htmx safely', async () => {
    const { app } = await setup()
    const owner = await signIn(app, 'owner@example.com')
    const doc = parseHtml((await owner.get('/admin')).body)
    expect(doc.querySelector('link[rel="stylesheet"]')?.getAttribute('href')).toMatch(/^\/admin\/assets\/admin\.css\?v=[0-9a-f]{10}$/)
    expect(doc.querySelector('script[type="module"]')?.getAttribute('src')).toMatch(/^\/admin\/assets\/admin\.js\?v=[0-9a-f]{10}$/)
    const config = JSON.parse(doc.querySelector('meta[name="htmx-config"]')?.getAttribute('content') ?? '{}')
    expect(config).toMatchObject({ allowEval: false, allowScriptTags: false, includeIndicatorStyles: false, selfRequestsOnly: true })
    expect(doc.querySelectorAll('script:not([src])').length).toBe(0)
  })
})

describe('page structure', () => {
  it('gives every page one h1, a skip link and a main landmark', async () => {
    const { app } = await setup()
    const owner = await signIn(app, 'owner@example.com')
    expectStructure(await owner.get('/admin'))
    expectStructure(await owner.get('/admin/publish'))
    expectStructure(await app.inject({ method: 'GET', url: '/admin/login' }))
    const fresh = await noOwner()
    expectStructure(await fresh.app.inject({ method: 'GET', url: '/admin/setup' }))
  })

  it('shows a 404 page inside the admin for an unknown admin address', async () => {
    const { app } = await setup()
    const owner = await signIn(app, 'owner@example.com')
    const res = await owner.get('/admin/nowhere')
    expect(res.statusCode).toBe(404)
    expect(res.body).toContain(t('admin.notFound.title'))
    expectStructure(res)
  })
})

describe('security headers', () => {
  it('sends the CSP, nosniff and no-store on admin pages', async () => {
    const { app } = await setup()
    const owner = await signIn(app, 'owner@example.com')
    const fresh = await noOwner()
    const responses = [
      await owner.get('/admin'),
      await app.inject({ method: 'GET', url: '/admin/login' }),
      await fresh.app.inject({ method: 'GET', url: '/admin/setup' }),
    ]
    for (const res of responses) {
      expect(res.headers['content-security-policy'], res.raw.req.url).toBe(CSP)
      expect(res.headers['x-content-type-options'], res.raw.req.url).toBe('nosniff')
      expect(res.headers['referrer-policy'], res.raw.req.url).toBe('same-origin')
      expect(res.headers['cache-control'], res.raw.req.url).toBe('no-store')
    }
  })

})

describe('sessions', () => {
  it('sends a visitor without a session to the login page', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'GET', url: '/admin/pages' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/admin/login?next=%2Fadmin%2Fpages')
  })

  it('answers an htmx request without a session with 401 and HX-Redirect', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'GET', url: '/admin/pages', headers: { 'hx-request': 'true' } })
    expect(res.statusCode).toBe(401)
    expect(res.headers['hx-redirect']).toBe('/admin/login')
  })

  it('refuses a POST from another origin', async () => {
    const { app } = await setup()
    const owner = await signIn(app, 'owner@example.com')
    const res = await owner.post('/admin/logout', {}, { origin: 'https://evil.example' })
    expect(res.statusCode).toBe(403)
    expect((await owner.get('/admin')).statusCode).toBe(200)
  })
})

describe('submittedForm', () => {
  const page = `<form id="f" method="post">
    <input type="hidden" name="base" value="3">
    <input type="checkbox" name="on" value="yes">
    <input type="checkbox" name="checked" value="yes" checked>
    <input name="tag" value="a"><input name="tag" value="b">
    <input name="off" value="x" disabled>
    <input type="file" name="upload">
    <select name="pick"><option value="1">One</option><option value="2" selected>Two</option></select>
    <select name="many" multiple><option value="a" selected>A</option><option value="b">B</option><option value="c" selected>C</option></select>
    <textarea name="note">hello</textarea>
    <button type="submit" name="_op" value="add">Add</button>
  </form>`

  it('follows the browser rules', () => {
    const form = submittedForm(page, { submitter: { name: '_op', value: 'add' } })
    expect([...form]).toEqual([
      ['base', '3'],
      ['checked', 'yes'],
      ['tag', 'a'],
      ['tag', 'b'],
      ['pick', '2'],
      ['many', 'a'],
      ['many', 'c'],
      ['note', 'hello'],
      ['_op', 'add'],
    ])
  })

  it('leaves out buttons unless one is the submitter', () => {
    expect(submittedForm(page, { form: '#f' }).has('_op')).toBe(false)
  })
})

describe('noticeOf', () => {
  it('renders only allowlisted notices, with counts that are non-negative integers', () => {
    expect(noticeOf({ notice: 'saved' })).toBe(t('admin.notice.saved'))
    expect(noticeOf({ notice: 'imported', created: '2', updated: '0' })).toBe(t('admin.notice.imported', { created: 2, updated: 0 }))
    expect(noticeOf({ notice: 'imported', created: '-1', updated: '0' })).toBeUndefined()
    expect(noticeOf({ notice: 'imported', created: '2' })).toBeUndefined()
    expect(noticeOf({ notice: 'toString' })).toBeUndefined()
    expect(noticeOf({ notice: '<script>' })).toBeUndefined()
    expect(noticeOf(undefined)).toBeUndefined()
  })
})
