import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, vi } from 'vitest'
import { inlay, type InlayOptions } from '../../src/adapters/site/plugin.js'
import { t } from '../../src/core/messages/index.js'
import type { Ctx } from '../../src/core/types.js'
import { escapeHtml } from '../../src/jsx/html.js'
import { routesSite } from '../fixtures/routes-site.js'
import { appOptions } from '../helpers/app.js'

const FORM = 'application/x-www-form-urlencoded'
const owner: Ctx = { actor: { id: 'user-owner', name: 'Olivia Owner', role: 'owner' }, source: 'admin' }
const rt = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

const open: FastifyInstance[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(open.splice(0).map((a) => a.close()))
})

/** The routes site behind the plugin, with Fastify's log lines kept in `logs`. */
async function setup(opts: Partial<InlayOptions> = {}) {
  const logs: Array<Record<string, unknown>> = []
  const app = Fastify({ logger: { level: 'warn', stream: { write: (line: string) => logs.push(JSON.parse(line)) } } })
  open.push(app)
  await app.register(inlay, await appOptions({ site: routesSite, ...opts }))
  return { app, core: app.inlay.core, logs }
}

function stubFetch() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
}

describe('release routes', () => {
  it('a form POST gets parsed fields and renders a template', async () => {
    const fetch = stubFetch()
    const { app } = await setup({ secrets: { HOOK_TOKEN: 'tok' } })
    const res = await app.inject({ method: 'POST', url: '/contact', headers: { 'content-type': FORM }, payload: 'email=a%40b.c' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.body).toMatch(/^<!doctype html>/)
    expect(res.body).toContain('<h1>Thanks a@b.c</h1>')
    expect(res.body).toContain('<title>Thanks a@b.c</title>')
    expect(res.body).toContain('<nav>/blog</nav>')
    expect(res.body).toContain('<p class="note">[]</p>')
    expect(res.body).toContain('<p class="path">/contact</p>')
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://example.com/__hook')
    expect(init).toMatchObject({ method: 'POST', body: 'a@b.c', headers: { authorization: 'Bearer tok' } })

    const missing = await app.inject({ method: 'POST', url: '/contact', headers: { 'content-type': FORM }, payload: 'name=x' })
    expect(missing.statusCode).toBe(400)
    expect(missing.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(missing.body).toBe('email required')
  })

  it('renders at the request locale, with a status', async () => {
    stubFetch()
    const { app } = await setup()
    const res = await app.inject({ method: 'POST', url: '/contact?locale=es', headers: { 'content-type': FORM }, payload: 'email=x' })
    expect(res.body).toContain('<html lang="es">')
    const gone = await app.inject('/gone')
    expect(gone.statusCode).toBe(410)
    expect(gone.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(gone.body).toContain('<h1>Gone</h1>')
  })

  it('a JSON POST gets the parsed body', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'POST', url: '/echo?a=1', payload: { name: 'Ana', tags: ['x'] } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(res.json().request).toMatchObject({
      method: 'POST',
      path: '/echo',
      query: { a: '1' },
      body: { name: 'Ana', tags: ['x'] },
      locale: 'en',
    })
    expect(res.json().baseUrl).toBe('https://example.com')
  })

  it('answers 415 to a multipart body', async () => {
    const { app } = await setup()
    const boundary = '----inlay'
    const payload =
      `--${boundary}\r\nContent-Disposition: form-data; name="email"\r\n\r\na@b.c\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n` +
      `--${boundary}--\r\n`
    for (const type of [`multipart/form-data; boundary=${boundary}`, 'text/plain']) {
      const res = await app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': type }, payload })
      expect(res.statusCode, type).toBe(415)
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(res.body).toContain(escapeHtml(t('site.unsupported.title')))
      expect(res.body).not.toContain('a@b.c')
    }
  })

  it('answers 413 to a form over the limit and 400 to broken JSON', async () => {
    const { app } = await setup()
    const big = await app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': FORM }, payload: `a=${'x'.repeat(1024 * 1024)}` })
    expect(big.statusCode).toBe(413)
    expect(big.body).toContain(escapeHtml(t('site.tooLarge.title')))
    const broken = await app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/json' }, payload: '{' })
    expect(broken.statusCode).toBe(400)
    expect(broken.body).toContain(escapeHtml(t('site.badRequest.title')))
  })

  it('a GET route returns JSON', async () => {
    const { app, core } = await setup()
    const view = await core.createEntry('posts', { slug: 'hello', fields: { title: 'Hello', date: '2026-02-01', body: rt('x') } }, owner)
    await core.publish([view.id], owner)
    await core.createEntry('posts', { slug: 'draft', fields: { title: 'Draft', date: '2026-03-01', body: rt('x') } }, owner)
    const res = await app.inject('/api/latest')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(res.json()).toEqual(['hello'])
  })

  it('redirect helper sets location and 303', async () => {
    const { app } = await setup()
    const res = await app.inject('/go')
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/')
  })

  it('answers plain responses as the handler gave them', async () => {
    const { app } = await setup()
    const empty = await app.inject('/empty')
    expect(empty.statusCode).toBe(204)
    expect(empty.body).toBe('')
    const text = await app.inject('/text')
    expect(text.statusCode).toBe(202)
    expect(text.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(text.headers['x-route']).toBe('yes')
    expect(text.body).toBe('plain <b>text</b>')
  })

  it('a handler throw is a 500 page and is logged', async () => {
    const { app, logs } = await setup()
    const res = await app.inject('/boom')
    expect(res.statusCode).toBe(500)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.body).toContain(escapeHtml(t('site.error.title')))
    expect(res.body).not.toContain('route exploded')
    const line = logs.find((l) => l.msg === t('log.routeFailed', { method: 'GET', path: '/boom' }))
    expect(line).toBeDefined()
    expect(JSON.stringify(line)).toContain('route exploded')
  })

  it('secrets are only the declared ones', async () => {
    const { app } = await setup({ secrets: { HOOK_TOKEN: 'x', OTHER: 'y' } })
    const res = await app.inject({ method: 'POST', url: '/echo', payload: {} })
    expect(res.json().secrets).toEqual({ HOOK_TOKEN: 'x' })
    const { app: bare } = await setup()
    expect((await bare.inject({ method: 'POST', url: '/echo', payload: {} })).json().secrets).toEqual({})
  })

  it('locale comes from the locale field, else the default', async () => {
    const { app } = await setup()
    const post = async (url: string, payload: string) =>
      (await app.inject({ method: 'POST', url, headers: { 'content-type': FORM }, payload })).json()
    expect(await post('/echo', 'locale=es&x=1')).toMatchObject({ locale: 'es', request: { locale: 'es', body: { locale: 'es', x: '1' } } })
    expect(await post('/echo?locale=es', 'x=1')).toMatchObject({ locale: 'es' })
    expect(await post('/echo', 'locale=fr')).toMatchObject({ locale: 'en' })
    expect((await app.inject('/echo?locale=es')).json()).toMatchObject({ locale: 'es', request: { body: null } })
    expect((await app.inject('/echo?locale=de')).json()).toMatchObject({ locale: 'en' })
    expect((await app.inject({ method: 'POST', url: '/echo', payload: { locale: 'es' } })).json()).toMatchObject({ locale: 'en' })
  })

  it('cookie, authorization and API key headers are not passed to the handler', async () => {
    const { app } = await setup()
    const res = await app.inject({
      url: '/echo',
      headers: { cookie: 'session=abc', authorization: 'Bearer k', 'proxy-authorization': 'Basic x', 'X-Api-Key': 'key', 'X-Custom': 'yes' },
    })
    const { headers } = res.json().request
    expect(headers['x-custom']).toBe('yes')
    expect(headers).not.toHaveProperty('cookie')
    expect(headers).not.toHaveProperty('authorization')
    expect(headers).not.toHaveProperty('proxy-authorization')
    expect(headers).not.toHaveProperty('x-api-key')
  })

  it('routes are locked with the site', async () => {
    const fetch = stubFetch()
    const { app, core } = await setup()
    await core.setSitePassword('letmein123', owner)
    await core.setSiteLock(true, owner)
    const res = await app.inject({ method: 'POST', url: '/contact', headers: { 'content-type': FORM }, payload: 'email=a%40b.c' })
    expect(res.statusCode).toBe(401)
    expect(res.body).toContain(escapeHtml(t('site.lock.intro')))
    expect(fetch).not.toHaveBeenCalled()
    expect((await app.inject('/api/latest')).statusCode).toBe(401)
  })

  it('leaves content pages alone', async () => {
    const { app } = await setup()
    const res = await app.inject('/about')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('About us')
  })
})
