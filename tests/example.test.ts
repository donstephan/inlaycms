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
})
