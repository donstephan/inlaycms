import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createSiteIntegrations, injectIntegrations } from '../../src/adapters/site/integrations.js'
import { inlay } from '../../src/adapters/site/plugin.js'
import { renderPane, renderTemplateResult } from '../../src/adapters/site/render.js'
import { f } from '../../src/core/fields/builtins.js'
import { defineContent } from '../../src/core/registry/content.js'
import { defineSingleton, defineSite, defineTemplate } from '../../src/core/registry/define.js'
import { defineIntegration } from '../../src/core/registry/integration.js'
import { js } from '../../src/core/registry/js.js'
import { defineRoute } from '../../src/core/registry/route.js'
import type { Ctx } from '../../src/core/types.js'
import { raw } from '../../src/jsx/html.js'
import { appOptions } from '../helpers/app.js'

const baseUrl = 'https://example.com'
const owner: Ctx = { actor: { id: 'user-owner', name: 'Olivia Owner', role: 'owner' }, source: 'admin' }

const Page = defineTemplate({
  name: 'page',
  label: 'Page',
  fields: z.object({ title: f.text({ label: 'Title' }) }),
  render: ({ fields }) => (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
      </head>
      <body>
        <h1>{fields.title}</h1>
      </body>
    </html>
  ),
})

const Bare = defineTemplate({
  name: 'bare',
  label: 'Bare',
  fields: z.object({ title: f.text({ label: 'Title' }) }),
  render: () => raw('<div>x</div>'),
})

const first = defineIntegration({
  name: 'first',
  label: 'First',
  head: (_, p) => p.script(js`window.first=${1}`),
  bodyEnd: () => <i id="first-end" />,
})
const pixel = defineIntegration({
  name: 'pixel',
  label: 'Pixel',
  consent: 'marketing',
  fields: z.object({ id: f.text({ label: 'ID' }) }),
  head: ({ id }, p) => p.script(js`px(${id})`),
  bodyStart: ({ id }) => (
    <noscript>
      <img src={`/public/p.gif?id=${id}`} />
    </noscript>
  ),
})
const chat = defineIntegration({ name: 'chat', label: 'Chat', preview: true, bodyEnd: () => <i id="chat" /> })
const broken = defineIntegration({
  name: 'broken',
  label: 'Broken',
  head: async () => {
    throw new Error('boom')
  },
})
const texty = defineIntegration({ name: 'texty', label: 'Texty', bodyEnd: () => '<script>alert(1)</script>' })
const skipper = defineIntegration({
  name: 'skipper',
  label: 'Skipper',
  head: (_, p) => (p.path === '/about' ? null : <meta name="skipper" content={p.locale} data-path={p.path} />),
})

const site = defineSite({
  locales: ['en'],
  defaultLocale: 'en',
  singletons: [
    defineSingleton({ name: 'home', label: 'Home', template: Page, path: '/' }),
    defineSingleton({ name: 'about', label: 'About', template: Page, path: '/about' }),
    defineSingleton({ name: 'bare', label: 'Bare', template: Bare, path: '/bare' }),
    defineSingleton({ name: 'notFound', label: 'Not found', template: Page, path: null }),
  ],
  notFound: 'notFound',
  integrations: [first, pixel, chat, broken, texty, skipper],
  routes: [
    defineRoute({ method: 'GET', path: '/hello', handler: (_request, ctx) => ctx.render(Page, { fields: { title: 'Hello' } }) }),
  ],
  content: [
    defineContent('home', { edition: 1, content: { en: { fields: { title: 'Home' } } } }),
    defineContent('about', { edition: 1, content: { en: { fields: { title: 'About' } } } }),
    defineContent('bare', { edition: 1, content: { en: { fields: { title: 'Bare' } } } }),
    defineContent('notFound', { edition: 1, content: { en: { fields: { title: 'Not found' } } } }),
  ],
})

const open: FastifyInstance[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((a) => a.close()))
})

async function setup() {
  const logs: Array<Record<string, unknown>> = []
  const app = Fastify({ logger: { level: 'warn', stream: { write: (line: string) => logs.push(JSON.parse(line)) } } })
  open.push(app)
  await app.register(inlay, await appOptions({ site }))
  const core = app.inlay.core
  const on = async (...names: string[]) => {
    for (const name of names) {
      const values = name === 'pixel' ? { id: 'P-1' } : {}
      await core.saveIntegration(name, { enabled: true, values }, owner)
    }
  }
  return { app, core, logs, on }
}

const scripts = (html: string) => html.match(/<script\b/gi)?.length ?? 0
const hashOf = (code: string) => `'sha256-${createHash('sha256').update(code).digest('base64')}'`
const CONSENT = /<script src="\/_inlay\/consent\.js\?v=[0-9a-f]{12}" defer><\/script>/g

async function previewCookie(app: FastifyInstance): Promise<string> {
  const url = new URL(app.inlay.previewUrl('/'))
  const res = await app.inject(`${url.pathname}${url.search}`)
  const header = res.headers['set-cookie']
  const raw = Array.isArray(header) ? header[0]! : (header as string)
  return raw.split(';')[0]!
}

describe('integrations in pages', () => {
  it('nothing is rendered while everything is off', async () => {
    const { app } = await setup()
    const res = await app.inject('/')
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('window.first')
    expect(res.body).not.toContain('data-inlay-consent')
    expect(res.body).not.toContain('/_inlay/consent.js')
    expect(scripts(res.body)).toBe(0)
  })

  it('output lands in each slot in site order', async () => {
    const { app, on } = await setup()
    await on('first', 'chat')
    const body = (await app.inject('/')).body
    expect(body).toMatch(/<script>window\.first=1<\/script><\/head>/)
    expect(body).toMatch(/<i id="first-end"><\/i><i id="chat"><\/i><\/body>/)
  })

  it('a gated integration is wrapped per slot and brings the consent script', async () => {
    const { app, on } = await setup()
    await on('pixel')
    const body = (await app.inject('/')).body
    expect(body).toContain('<template data-inlay-consent="marketing"><script>px("P-1")</script></template>')
    expect(body.match(CONSENT)?.length).toBe(1)
    expect(body).toMatch(
      /<template data-inlay-consent="marketing"><script>px\("P-1"\)<\/script><\/template><script src="\/_inlay\/consent\.js\?v=[0-9a-f]{12}" defer><\/script><\/head>/,
    )
    expect(body).toMatch(/<body>\s*<template data-inlay-consent="marketing"><noscript><img src="\/public\/p\.gif\?id=P-1"/)
  })

  it('no consent script without a gated integration', async () => {
    const { app, on } = await setup()
    await on('first', 'chat')
    expect((await app.inject('/')).body).not.toContain('/_inlay/consent.js')
  })

  it('gated inline scripts are in the page policy', async () => {
    const { app, on } = await setup()
    await on('pixel')
    const res = await app.inject('/')
    expect(res.headers['content-security-policy']).toContain(hashOf('px("P-1")'))
  })

  it('an owner value cannot leave its string', async () => {
    const { app, core, on } = await setup()
    await on('pixel')
    const before = scripts((await app.inject('/')).body)
    const id = '"</script><script>alert(1)</script>'
    const saved = await core.saveIntegration('pixel', { enabled: true, values: { id } }, owner).then(
      () => true,
      () => false,
    )
    const body = (await app.inject('/')).body
    if (saved) expect(body).toContain('px("\\"\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e")')
    expect(body).not.toContain('<script>alert(1)')
    expect(scripts(body)).toBe(before)
  })

  it('a render function that throws is left out and logged, the rest renders', async () => {
    const { app, logs, on } = await setup()
    await on('broken', 'first')
    const res = await app.inject('/')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<script>window.first=1</script>')
    const lines = logs.filter((l) => String(l.msg).includes('broken'))
    expect(lines).toHaveLength(1)
    expect(lines[0]!.err).toMatchObject({ message: 'boom' })
  })

  it('a string a render function returns is escaped', async () => {
    const { app, on } = await setup()
    await on('texty')
    const body = (await app.inject('/')).body
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;</body>')
    expect(scripts(body)).toBe(0)
  })

  it('a render function can skip a page', async () => {
    const { app, on } = await setup()
    await on('skipper')
    expect((await app.inject('/')).body).toContain('<meta name="skipper" content="en" data-path="/"')
    const about = await app.inject('/about')
    expect(about.statusCode).toBe(200)
    expect(about.body).not.toContain('skipper')
  })

  it('preview renders only integrations with preview: true', async () => {
    const { app, on } = await setup()
    await on('first', 'pixel', 'chat')
    const cookie = await previewCookie(app)
    const res = await app.inject({ url: '/', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('class="inlay-preview"')
    expect(res.body).toContain('<i id="chat"></i>')
    expect(res.body).not.toContain('window.first')
    expect(res.body).not.toContain('data-inlay-consent')
    expect(res.body).not.toContain('/_inlay/consent.js')
  })

  it("Inlay's own pages get nothing", async () => {
    const { app, core, on } = await setup()
    await on('first', 'pixel', 'chat', 'texty', 'skipper')
    await core.setSitePassword('letmein123', owner)
    await core.setSiteLock(true, owner)
    const res = await app.inject('/')
    expect(res.body).toContain('<form')
    for (const text of ['window.first', 'id="chat"', 'data-inlay-consent', '/_inlay/consent.js', 'alert(1)', 'skipper']) {
      expect([text, res.body.includes(text)]).toEqual([text, false])
    }
  })

  it('the 404 page gets integrations', async () => {
    const { app, on } = await setup()
    await on('first')
    const res = await app.inject('/nope')
    expect(res.statusCode).toBe(404)
    expect(res.body).toContain('<script>window.first=1</script></head>')
    expect(res.headers['content-security-policy']).toContain(hashOf('window.first=1'))
  })

  it("a code route's ctx.render gets integrations, with the route path as page.path", async () => {
    const { app, on } = await setup()
    await on('first', 'skipper')
    const res = await app.inject('/hello')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<script>window.first=1</script>')
    expect(res.body).toContain('<meta name="skipper" content="en" data-path="/hello"')
    expect(res.headers['content-security-policy']).toContain(hashOf('window.first=1'))
  })

  it("a route render in a staged release's preview skips them", async () => {
    const { core, on } = await setup()
    await on('first', 'pixel', 'chat')
    const integrations = createSiteIntegrations({
      core,
      site,
      generation: () => 0,
      consentUrl: '/_inlay/consent.js?v=000000000000',
      log: () => {},
    })
    const data = { fields: { title: 'Staged' }, slots: {} }
    const preview = await renderTemplateResult(core, Page, data, { locale: 'en', path: '/x', baseUrl, preview: true, integrations })
    expect(preview.html).toContain('<i id="chat"></i>')
    expect(preview.html).not.toContain('window.first')
    expect(preview.html).not.toContain('data-inlay-consent')
    expect(preview.html).not.toContain('/_inlay/consent.js')
    const live = await renderTemplateResult(core, Page, data, { locale: 'en', path: '/x', baseUrl, integrations })
    expect(live.html).toContain('<script>window.first=1</script>')
    expect(live.html).toContain('<script src="/_inlay/consent.js?v=000000000000" defer></script></head>')
    expect(live.scriptHashes).toEqual(expect.arrayContaining([hashOf('window.first=1'), hashOf('px("P-1")')]))
  })

  it('a template without </head>, <body> or </body> skips those slots', async () => {
    const { app, logs, on } = await setup()
    const before = await app.inject('/bare')
    await on('first', 'pixel', 'chat')
    const res = await app.inject('/bare')
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(before.body)
    expect(res.body).not.toContain('/_inlay/consent.js')
    expect(logs.filter((l) => (l.level as number) >= 50)).toEqual([])
  })

  it('switching one off takes it out of cached pages', async () => {
    const { app, core, on } = await setup()
    await on('first')
    expect((await app.inject('/')).headers['x-inlay-cache']).toBe('miss')
    const hit = await app.inject('/')
    expect(hit.headers['x-inlay-cache']).toBe('hit')
    expect(hit.body).toContain('window.first')
    await core.saveIntegration('first', { enabled: false, values: {} }, owner)
    const after = await app.inject('/')
    expect(after.headers['x-inlay-cache']).toBe('miss')
    expect(after.body).not.toContain('window.first')
  })

  it('the editor pane renders none', async () => {
    const { core, on } = await setup()
    await on('first', 'chat', 'pixel')
    const home = await core.findSingleton('home', 'en')
    const doc = (await core.liveDocuments([home!.groupId], 'en', { state: 'preview' })).get(home!.groupId)!
    const result = await renderPane(core, doc, { page: 1, baseUrl })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.html).not.toContain('id="chat"')
    expect(result.html).not.toContain('window.first')
    expect(result.html).not.toContain('data-inlay-consent')
  })
})

describe('injectIntegrations', () => {
  const rendered = { head: '<h-head>', bodyStart: '<h-start>', bodyEnd: '<h-end>' }

  it('puts each part at its marker', () => {
    expect(injectIntegrations('<html><head><x></head><body class="a"><p></p></body></html>', rendered)).toBe(
      '<html><head><x><h-head></head><body class="a"><h-start><p></p><h-end></body></html>',
    )
  })

  it('uses the first </head> and the last </body>', () => {
    expect(injectIntegrations('<head></head><body>a</body>b</body>', rendered)).toBe(
      '<head><h-head></head><body><h-start>a</body>b<h-end></body>',
    )
  })

  it('skips a slot whose marker is missing', () => {
    expect(injectIntegrations('<div>x</div>', rendered)).toBe('<div>x</div>')
    expect(injectIntegrations('<body></body>', rendered)).toBe('<body><h-start><h-end></body>')
  })
})
