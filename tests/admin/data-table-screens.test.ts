import type { FastifyInstance } from 'fastify'
import type { Core } from '../../src/core/core.js'
import { makeApp } from '../helpers/app.js'
import { parseHtml, signIn, type AdminClient } from '../helpers/admin.js'

describe('admin screens on the shared table', () => {
  let app: FastifyInstance
  let core: Core
  let olivia: AdminClient
  let eddie: AdminClient

  beforeEach(async () => {
    ;({ app, core } = await makeApp({ withOwner: true }))
    await app.ready()
    olivia = await signIn(app, 'owner@example.com')
    eddie = await signIn(app, 'editor@example.com')
  })
  afterEach(() => app.close())

  const shared = (html: string, id: string) => {
    const page = parseHtml(html)
    expect(page.querySelector(`div#${id} table.table-sm caption.sr-only`), id).not.toBeNull()
    return page
  }

  it('history', async () => {
    const home = (await core.findSingleton('home', 'en'))!
    const page = shared((await eddie.get(`/admin/documents/${home.id}/history`)).body, 'history')
    expect(page.querySelector('div#history tbody a[href*="/history/"]')).not.toBeNull()
  })

  it('users', async () => {
    const page = shared((await olivia.get('/admin/users')).body, 'users')
    expect(page.querySelector('div#users tbody a[href^="/admin/users/"]')).not.toBeNull()
  })

  it('api keys', async () => {
    const page = shared((await eddie.get('/admin/account')).body, 'api-keys')
    expect(page.querySelector('div#api-keys form[action$="/delete"] button')).not.toBeNull()
  })

  it('backups', async () => {
    await olivia.post('/admin/backups', {})
    const page = shared((await olivia.get('/admin/backups')).body, 'backups')
    expect(page.querySelector('div#backups tbody a.btn-ghost.btn-xs')).not.toBeNull()
    expect(page.querySelector('header form[action="/admin/backups"], form[action="/admin/backups"]')).not.toBeNull()
  })

  it('import report', async () => {
    const archive = (await olivia.get('/admin/backups/export')).rawPayload
    const res = await olivia.upload('/admin/backups/import', [
      { name: 'archive', filename: 'export.tar.gz', data: archive, type: 'application/gzip' },
    ])
    const page = shared(res.body, 'import-report')
    expect(page.querySelectorAll('div#import-report tbody tr').length).toBeGreaterThan(0)
  })

  it('redirects', async () => {
    await eddie.post('/admin/redirects', { to_mode: 'path', status: '301', from: '/old', to_path: '/about' })
    await eddie.post('/admin/redirects', { to_mode: 'path', status: '301', from: '/zebra', to_path: '/about' })
    const all = shared((await eddie.get('/admin/redirects')).body, 'redirects')
    expect(all.querySelector('div#redirects summary[aria-label*="/old"]')).not.toBeNull()
    expect(all.querySelectorAll('#q').length).toBe(0)
    const found = parseHtml((await eddie.get('/admin/redirects?q=old')).body)
    expect(found.querySelector('input#redirects-q')?.getAttribute('value')).toBe('old')
    expect(found.body.textContent).not.toContain('/zebra')
  })
})
