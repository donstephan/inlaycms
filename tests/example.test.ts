import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createSiteApp } from '../src/host/app.js'
import { ensureDataDir, readHostConfig } from '../src/host/config.js'

describe('example site', () => {
  let dir: string
  let app: FastifyInstance

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inlay-example-'))
    // As `inlaycms dev` runs it: from source, with its shipped content applied.
    const { config, dir: siteDir } = await loadConfig(resolve(import.meta.dirname, '../example/inlay.config.ts'))
    const host = readHostConfig({
      INLAY_DATA_DIR: dir,
      INLAY_BASE_URL: 'http://localhost:3000',
      INLAY_SECRET: 's'.repeat(32),
      SLACK_WEBHOOK: '',
    })
    await ensureDataDir(host)
    ;({ app } = await createSiteApp(host, { site: config.site, publicDir: join(siteDir, 'public') }, { content: 'apply' }))
  })

  afterAll(async () => {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  })

  async function get(url: string) {
    return app.inject({ method: 'GET', url })
  }

  it('serves the pages', async () => {
    const urls = ['/', '/es', '/about', '/es/acerca', '/blog', '/services/web-design', '/public/site.css', '/public/logo.svg']
    const posts = await app.inlay.query('posts', { limit: 1 })
    const first = posts.items[0]
    expect(first).toBeDefined()
    urls.push(first!.url ?? '')
    for (const url of urls) expect([url, (await get(url)).statusCode]).toEqual([url, 200])
  })

  it('shows the hero image with a srcset', async () => {
    const body = (await get('/')).body
    expect(body).toMatch(/<img[^>]*srcset=/)
  })

  it('serves a post written in a .md file, with its table and image', async () => {
    const res = await get('/blog/tables-and-images')
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatch(/<table><thead><tr><th>/)
    expect(res.body).toMatch(/<img[^>]*srcset=/)
    expect(res.body).toContain('alt="A blue and orange gradient"')
  })

  it('sends the old /about-us to /about with a code redirect', async () => {
    const res = await get('/about-us')
    expect(res.statusCode).toBe(301)
    expect(res.headers.location).toBe('/about')
  })

  it('serves the contact page and lists it in the sitemap', async () => {
    const res = await get('/contact')
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatch(/<form[^>]*action="\/contact"/)
    expect((await get('/sitemap.xml')).body).toContain('/contact</loc>')
  })

  it('renders the example 404 page', async () => {
    const res = await get('/nope')
    expect(res.statusCode).toBe(404)
    expect(res.body).toContain('We could not find that page')
  })

  it('serves the colophon from a Markdown file, with its image and link', async () => {
    const res = await get('/colophon')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('href="#colophon-how-it-is-built"')
    expect(res.body).toContain('href="/blog/hello-inlay"')
    const src = /<img[^>]*src="([^"]+)"/.exec(res.body)?.[1] ?? ''
    expect(src).toMatch(/^\/media\/files\//)
    expect((await get(src)).statusCode).toBe(200)
    expect((await get('/sitemap.xml')).body).toContain('/colophon</loc>')
  })

  it('shows a contact form on the About page that posts to /contact', async () => {
    expect((await get('/about')).body).toMatch(/<form[^>]*action="\/contact"/)
    expect((await get('/blog')).body).not.toContain('action="/contact"')
  })

  it('thanks the sender and asks for a missing email', async () => {
    const post = (payload: string) =>
      app.inject({
        method: 'POST',
        url: '/contact',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload,
      })
    const ok = await post('email=ana%40example.com&message=Hello&locale=en')
    expect(ok.statusCode).toBe(200)
    expect(ok.body).toContain('Thank you')
    expect((await post('email=ana%40example.com&locale=es')).body).toContain('Gracias')
    const missing = await post('message=Hello')
    expect(missing.statusCode).toBe(400)
    expect(missing.body).toContain('Please add your email')
  })

  it('lists the Spanish home page in the sitemap', async () => {
    expect((await get('/sitemap.xml')).body).toContain('/es')
  })

  describe('integrations', () => {
    const owner = { actor: { id: 'user-owner', name: 'Olivia Owner', role: 'owner' as const }, source: 'admin' as const }

    it('defines a visit counter integration that waits for analytics consent', () => {
      const { integrations } = app.inlay.core.registry.site
      expect(integrations.map((i) => ({ name: i.name, consent: i.consent }))).toEqual([
        { name: 'visit-counter', consent: 'analytics' },
      ])
    })

    it('with it switched on, holds it in a template and loads the consent script and the banner', async () => {
      const off = (await get('/')).body
      expect(off).not.toContain('data-inlay-consent')
      expect(off).not.toContain('/_inlay/consent.js')
      await app.inlay.core.saveIntegration('visit-counter', { enabled: true, values: { label: 'Visits' } }, owner)
      const body = (await get('/')).body
      expect(body).toMatch(/<template data-inlay-consent="analytics">[^]*<script src="\/public\/visits\.js[^"]*" defer><\/script>[^]*<\/template>/)
      expect(body.match(/<script src="\/_inlay\/consent\.js\?v=[^"]+" defer><\/script>/g)).toHaveLength(1)
      expect(body.match(/<script[^>]*src="\/public\/consent-banner\.js[^"]*"/g)).toHaveLength(1)
      await app.inlay.core.saveIntegration('visit-counter', { enabled: false, values: {} }, owner)
    })

    it('has pages that pass their own policy', async () => {
      const posts = await app.inlay.query('posts', { limit: 1 })
      for (const url of ['/', posts.items[0]?.url ?? '', '/contact']) {
        const res = await get(url)
        const policy = String(res.headers['content-security-policy'])
        expect(policy).toContain("default-src 'self'")
        const scriptSrc = policy.split('; ').find((d) => d.startsWith('script-src ')) ?? ''
        for (const m of res.body.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([^]*?)<\/script>/g)) {
          if (/type="application\/ld\+json"/.test(m[1] ?? '')) continue
          const hash = `'sha256-${createHash('sha256').update(m[2] ?? '').digest('base64')}'`
          expect([url, scriptSrc.includes(hash)]).toEqual([url, true])
        }
      }
    })
  })
})
