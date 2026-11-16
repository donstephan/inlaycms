import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import type { Core } from '../../src/core/core.js'
import { t } from '../../src/core/messages/index.js'
import type { DocumentSummary } from '../../src/core/types.js'
import { makeApp } from '../helpers/app.js'
import { parseHtml, signIn, submittedForm, type AdminClient } from '../helpers/admin.js'

function expectAdminHtml(res: LightMyRequestResponse, status: number, title: string): void {
  expect(res.statusCode).toBe(status)
  expect(res.headers['content-type']).toContain('text/html')
  expect(res.headers['content-security-policy']).toContain("default-src 'self'")
  expect(res.headers['x-content-type-options']).toBe('nosniff')
  expect(res.headers['cache-control']).toBe('no-store')
  expect(res.headers['x-robots-tag']).toBe('noindex')
  expect(parseHtml(res.body).querySelector('h1')!.textContent).toBe(title)
}

describe('admin errors', () => {
  let app: FastifyInstance
  let core: Core
  let eddie: AdminClient
  let home: DocumentSummary

  beforeEach(async () => {
    ;({ app, core } = await makeApp({ withOwner: true }))
    await app.ready()
    eddie = await signIn(app, 'editor@example.com')
    home = (await core.findSingleton('home', 'en'))!
  })
  afterEach(() => {
    vi.restoreAllMocks()
    return app.close()
  })

  it('answers a form over the size limit with a plain 413 page', async () => {
    const url = `/admin/documents/${home.id}`
    const form = submittedForm((await eddie.get(url)).body, { form: '#editor-form', submitter: { name: '_action', value: 'save' } })
    form.set('fields.padding', 'a'.repeat(5 * 1024 * 1024))
    const before = (await core.listRevisions(home.id)).length
    const res = await eddie.post(url, form)
    expectAdminHtml(res, 413, t('admin.error.tooLarge.title'))
    expect(res.body).toContain(t('admin.error.tooLarge'))
    expect((await core.listRevisions(home.id)).length).toBe(before)
  })

  it('answers a request the server can not read with a plain 400 page', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      payload: '{not json',
    })
    expectAdminHtml(res, 400, t('admin.error.badRequest.title'))
  })

  it('logs an unexpected failure and answers with a plain 500 page', async () => {
    vi.spyOn(core, 'recentActivity').mockRejectedValue(new Error('boom'))
    const res = await eddie.get('/admin')
    expectAdminHtml(res, 500, t('admin.error.title'))
    expect(res.body).not.toContain('boom')
  })

  it('answers a POST to an unknown admin address with the admin 404 page', async () => {
    const res = await eddie.post('/admin/nothing-here', { x: '1' })
    expectAdminHtml(res, 404, t('admin.notFound.title'))
  })

  it('still checks the origin and session of a POST to an unknown admin address', async () => {
    const foreign = await eddie.post('/admin/nothing-here', { x: '1' }, { origin: 'https://evil.example' })
    expect(foreign.statusCode).toBe(403)
    const anonymous = await app.inject({
      method: 'POST',
      url: '/admin/nothing-here',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://example.com' },
      payload: 'x=1',
    })
    expect(anonymous.statusCode).toBe(302)
  })
})
