import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach } from 'vitest'
import { z } from 'zod'
import { f } from '../../src/core/fields/builtins.js'
import { defineSingleton, defineSite, defineTemplate, type SiteDefinition } from '../../src/core/registry/define.js'
import { defineIntegration } from '../../src/core/registry/integration.js'
import { defineRoute } from '../../src/core/registry/route.js'
import { escapeHtml, raw } from '../../src/jsx/html.js'
import { Hero, Quotes, webSite } from '../fixtures/web.js'
import { makeApp, type MakeAppOptions } from '../helpers/app.js'

const DEFAULT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; media-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"

const open: FastifyInstance[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((a) => a.close()))
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function setup(opts: MakeAppOptions = {}) {
  const made = await makeApp(opts)
  open.push(made.app)
  return made.app
}

describe('security headers', () => {
  it('sends the defaults with a page, and HSTS on an https site', async () => {
    const res = await (await setup()).inject('/')
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(res.headers['content-security-policy']).toBe(DEFAULT_CSP)
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000')
  })

  it('sends no HSTS on an http site', async () => {
    const res = await (await setup({ baseUrl: 'http://localhost:3000' })).inject('/')
    expect(res.headers['strict-transport-security']).toBeUndefined()
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('sends them with a 404 and the unlock route too', async () => {
    const app = await setup()
    const missing = await app.inject('/nope')
    expect(missing.statusCode).toBe(404)
    expect(missing.headers['content-security-policy']).toBe(DEFAULT_CSP)
    const unlock = await app.inject({ method: 'POST', url: '/_inlay/unlock', payload: '' })
    expect(unlock.headers['content-security-policy']).toBe(DEFAULT_CSP)
  })

  it("keeps the admin's own stricter headers, and adds HSTS", async () => {
    const res = await (await setup()).inject('/admin/login')
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(res.headers['referrer-policy']).toBe('same-origin')
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000')
  })

  it("lays the site's headers over the defaults, and false leaves one out", async () => {
    const site = defineSite({
      ...webSite,
      headers: {
        'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
        'strict-transport-security': false,
        'permissions-policy': 'camera=()',
      },
    })
    const res = await (await setup({ site })).inject('/')
    expect(res.headers['content-security-policy']).toBe("default-src 'self'; frame-ancestors 'none'")
    expect(res.headers['strict-transport-security']).toBeUndefined()
    expect(res.headers['permissions-policy']).toBe('camera=()')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })
})

const hashOf = (code: string) => `'sha256-${createHash('sha256').update(code).digest('base64')}'`
const withHashes = (policy: string, ...hashes: string[]) =>
  policy.replace("script-src 'self'", ["script-src 'self'", ...hashes].join(' '))

/** A head with `window.x=1` written through `ctx.script`, and the title in the body. */
const scriptPage = (title: string, ctx: { script: (code: string) => { value: string } }) =>
  raw(
    `<html><head><meta charset="utf-8">${ctx.script('window.x=1').value}</head>` +
      `<body><h1>${escapeHtml(title)}</h1></body></html>`,
  )

const ScriptHome = defineTemplate({
  name: 'home',
  label: 'Home page',
  fields: z.object({ title: f.text({ label: 'Title' }), seo: f.seo().optional() }),
  slots: { hero: { block: Hero }, quotes: { block: Quotes, optional: true } },
  render: ({ fields }, ctx) => scriptPage(fields.title, ctx),
})

const RouteTemplate = defineTemplate({
  name: 'routed',
  fields: z.object({ title: f.text({ label: 'Title' }) }),
  render: ({ fields }, ctx) =>
    raw(`<html><head>${ctx.script('window.routed=1').value}</head><body>${escapeHtml(fields.title)}</body></html>`),
})

const gtm = defineIntegration({
  name: 'gtm',
  label: 'Tag manager',
  csp: { 'script-src': ['https://tags.example'] },
  head: (_values, page) => page.script({ src: 'https://tags.example/tag.js', async: true }),
})

function cspSite(extra: Partial<SiteDefinition> = {}): SiteDefinition {
  return defineSite({
    ...webSite,
    singletons: [
      defineSingleton({ name: 'home', label: 'Home', template: ScriptHome, path: '/' }),
      ...webSite.singletons.filter((s) => s.name !== 'home'),
    ],
    integrations: [gtm],
    routes: [
      defineRoute({ method: 'GET', path: '/data', handler: () => ({ json: { ok: true } }) }),
      defineRoute({
        method: 'GET',
        path: '/rendered',
        handler: (_request, ctx) => ctx.render(RouteTemplate, { fields: { title: 'Routed' } }),
      }),
    ],
    ...extra,
  })
}

async function cspApp(extra: Partial<SiteDefinition> = {}) {
  const publicDir = await mkdtemp(join(tmpdir(), 'inlay-csp-'))
  dirs.push(publicDir)
  await writeFile(join(publicDir, 'site.css'), 'body{color:red}')
  await writeFile(join(publicDir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  const made = await makeApp({ site: cspSite(extra), publicDir })
  open.push(made.app)
  return made
}

const csp = async (app: FastifyInstance, url: string) => (await app.inject(url)).headers['content-security-policy']

describe('content-security-policy', () => {
  it('a page carries the default policy plus its own script hash', async () => {
    const { app } = await cspApp()
    const res = await app.inject('/')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<script>window.x=1</script>')
    expect(res.headers['content-security-policy']).toBe(withHashes(DEFAULT_CSP, hashOf('window.x=1')))
  })

  it('a public file, /robots.txt and a code route that returns JSON carry the policy without hashes', async () => {
    const { app } = await cspApp()
    for (const url of ['/public/site.css', '/robots.txt', '/data', '/nope']) {
      expect([url, await csp(app, url)]).toEqual([url, DEFAULT_CSP])
    }
  })

  it("an integration's sources appear only once it is switched on, on pages and on other responses", async () => {
    const { app, core, owner } = await cspApp()
    expect(await csp(app, '/')).not.toContain('https://tags.example')
    expect(await csp(app, '/robots.txt')).not.toContain('https://tags.example')
    await core.saveIntegration('gtm', { enabled: true, values: {} }, owner)
    expect(await csp(app, '/')).toContain(`script-src 'self' ${hashOf('window.x=1')} https://tags.example;`)
    expect(await csp(app, '/robots.txt')).toContain("script-src 'self' https://tags.example;")
    expect(await csp(app, '/data')).toContain("script-src 'self' https://tags.example;")
    await core.saveIntegration('gtm', { enabled: false, values: {} }, owner)
    expect(await csp(app, '/')).not.toContain('https://tags.example')
    expect(await csp(app, '/robots.txt')).not.toContain('https://tags.example')
  })

  it('a cached page replays the same header, and so does its 304', async () => {
    const { app } = await cspApp()
    const first = await app.inject('/')
    const second = await app.inject('/')
    expect(first.headers['x-inlay-cache']).toBe('miss')
    expect(second.headers['x-inlay-cache']).toBe('hit')
    const policy = withHashes(DEFAULT_CSP, hashOf('window.x=1'))
    expect(first.headers['content-security-policy']).toBe(policy)
    expect(second.headers['content-security-policy']).toBe(policy)
    const revalidated = await app.inject({ url: '/', headers: { 'if-none-match': second.headers.etag as string } })
    expect(revalidated.statusCode).toBe(304)
    expect(revalidated.headers['content-security-policy']).toBe(policy)
  })

  it("a code route that renders a template carries that render's hashes", async () => {
    const { app } = await cspApp()
    expect(await csp(app, '/rendered')).toBe(withHashes(DEFAULT_CSP, hashOf('window.routed=1')))
  })

  it('a site that sets content-security-policy gets exactly its own string everywhere', async () => {
    const own = "default-src 'self'; frame-ancestors 'none'"
    const { app, core, owner } = await cspApp({ headers: { 'Content-Security-Policy': own } })
    await core.saveIntegration('gtm', { enabled: true, values: {} }, owner)
    for (const url of ['/', '/robots.txt', '/data', '/rendered', '/nope', '/public/site.css']) {
      expect([url, await csp(app, url)]).toEqual([url, own])
    }
  })

  it('a site that sets it to false gets no content-security-policy header at all', async () => {
    const { app } = await cspApp({ headers: { 'content-security-policy': false } })
    for (const url of ['/', '/robots.txt', '/data', '/rendered', '/nope', '/public/site.css']) {
      expect([url, await csp(app, url)]).toEqual([url, undefined])
    }
  })

  it('the admin keeps its own policy', async () => {
    const { app, core, owner } = await cspApp()
    await core.saveIntegration('gtm', { enabled: true, values: {} }, owner)
    const res = await app.inject('/admin/login')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-security-policy']).toContain("script-src 'self';")
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(res.headers['content-security-policy']).not.toContain('https://tags.example')
  })

  it('a public SVG keeps its own policy', async () => {
    const { app } = await cspApp()
    expect(await csp(app, '/public/logo.svg')).toBe("default-src 'none'; style-src 'unsafe-inline'")
  })
})
