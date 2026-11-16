import type { FastifyInstance } from 'fastify'
import { makeApp } from '../helpers/app.js'
import { parseHtml, signIn, type AdminClient } from '../helpers/admin.js'

const BANNER = 'Your site is private. Visitors need a password to see it.'

describe('admin security', () => {
  let app: FastifyInstance
  let olivia: AdminClient
  let eddie: AdminClient

  beforeEach(async () => {
    ;({ app } = await makeApp({ withOwner: true }))
    await app.ready()
    olivia = await signIn(app, 'owner@example.com')
    eddie = await signIn(app, 'editor@example.com')
  })
  afterEach(() => app.close())

  const setPassword = (password = 'letmein123') => olivia.post('/admin/security/password', { password, confirm: password })

  it('shows Security in the menu for owners only', async () => {
    const link = (client: AdminClient) =>
      client.get('/admin').then((res) => [...parseHtml(res.body).querySelectorAll('nav a[href="/admin/security"]')])
    const owner = await link(olivia)
    expect(owner).toHaveLength(1)
    expect(owner[0]!.textContent).toContain('Security')
    expect(await link(eddie)).toHaveLength(0)
  })

  it('refuses editors', async () => {
    expect((await eddie.get('/admin/security')).statusCode).toBe(403)
    expect((await eddie.post('/admin/security/lock', { enabled: 'on' })).statusCode).toBe(403)
    expect((await eddie.post('/admin/security/password', { password: 'letmein123', confirm: 'letmein123' })).statusCode).toBe(403)
  })

  it('sets a password and never shows it', async () => {
    const res = await setPassword()
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/security?notice=sitePasswordSaved')
    const page = await olivia.get(res.headers.location as string)
    expect(page.body).toContain('A password is set.')
    expect(page.body).not.toContain('letmein123')
    const inputs = parseHtml(page.body).querySelectorAll('input[type=password]')
    expect(inputs).toHaveLength(2)
    for (const input of inputs) expect(input.hasAttribute('value')).toBe(false)
  })

  it('explains a mismatch or a short password', async () => {
    const mismatch = await olivia.post('/admin/security/password', { password: 'letmein123', confirm: 'different1' })
    expect(mismatch.statusCode).toBe(400)
    expect(parseHtml(mismatch.body).querySelector('#site-password-confirm-error')!.textContent).toContain("The two passwords don't match.")
    const short = await olivia.post('/admin/security/password', { password: 'short', confirm: 'short' })
    expect(short.statusCode).toBe(400)
    expect(short.body).toContain('is too short')
    for (const res of [mismatch, short]) {
      for (const input of parseHtml(res.body).querySelectorAll('input[type=password]')) expect(input.hasAttribute('value')).toBe(false)
    }
    expect(mismatch.body).not.toContain('letmein123')
  })

  it('refuses to make the site private without a password', async () => {
    const res = await olivia.post('/admin/security/lock', { enabled: 'on' })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('Set a site password before making the site private.')
  })

  it('makes the site private and public again', async () => {
    await setPassword()
    const on = await olivia.post('/admin/security/lock', { enabled: 'on' })
    expect(on.statusCode).toBe(303)
    expect(on.headers.location).toBe('/admin/security?notice=siteLocked')
    const toggle = async () => parseHtml((await olivia.get('/admin/security')).body).querySelector('input[name=enabled]')!
    expect((await toggle()).hasAttribute('checked')).toBe(true)
    const off = await olivia.post('/admin/security/lock', {})
    expect(off.statusCode).toBe(303)
    expect(off.headers.location).toBe('/admin/security?notice=siteUnlocked')
    expect((await toggle()).hasAttribute('checked')).toBe(false)
  })

  it('shows a private-site badge in the top bar on every admin page', async () => {
    await setPassword()
    for (const url of ['/admin', '/admin/media']) expect(parseHtml((await olivia.get(url)).body).querySelector('[data-private-badge]')).toBeNull()
    await olivia.post('/admin/security/lock', { enabled: 'on' })
    for (const url of ['/admin', '/admin/media']) {
      const owner = parseHtml((await olivia.get(url)).body).querySelector('[data-private-badge]')
      const editor = parseHtml((await eddie.get(url)).body).querySelector('[data-private-badge]')
      expect(owner?.textContent).toContain(BANNER)
      expect(editor?.textContent).toContain(BANNER)
      expect(owner?.tagName).toBe('A')
      expect(owner?.getAttribute('href')).toBe('/admin/security')
      expect(editor?.tagName).not.toBe('A')
    }
    await olivia.post('/admin/security/lock', {})
    expect(parseHtml((await olivia.get('/admin')).body).querySelector('[data-private-badge]')).toBeNull()
  })

  it('posts from another origin are refused', async () => {
    for (const url of ['/admin/security/lock', '/admin/security/password']) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: olivia.cookie },
        payload: 'enabled=on',
      })
      expect(res.statusCode).toBe(403)
    }
  })
})
