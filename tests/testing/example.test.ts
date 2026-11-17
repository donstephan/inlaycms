import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createTestSite, type TestSite } from 'inlaycms/testing'

const config = resolve(import.meta.dirname, '../../example/inlay.config.ts')
let site: TestSite

beforeAll(async () => {
  site = await createTestSite({ config })
})

afterAll(async () => {
  await site?.close()
})

it('serves every sitemap path with 200 and one <h1>', async () => {
  const paths = await site.paths()
  expect(paths).toEqual(expect.arrayContaining(['/', '/about', '/es', '/contact']))
  for (const path of paths) {
    const res = await site.fetch(path)
    expect([path, res.status]).toEqual([path, 200])
    expect([path, (await res.text()).match(/<h1[\s>]/g)?.length]).toEqual([path, 1])
  }
})

it('lists the same paths as /sitemap.xml, in order', async () => {
  const xml = await (await site.fetch('/sitemap.xml')).text()
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]!).pathname)
  expect(await site.paths()).toEqual(locs)
})

it('answers an unknown path with 404', async () => {
  expect((await site.fetch('/no-such-page')).status).toBe(404)
})

it('answers a code redirect with 301 and Location, without following it', async () => {
  const res = await site.fetch('/about-us')
  expect(res.status).toBe(301)
  expect(res.headers.get('location')).toBe('/about')
  expect(res.redirected).toBe(false)
})

it('renders a .md import with its image', async () => {
  const html = await (await site.fetch('/blog/tables-and-images')).text()
  expect(html).toMatch(/<img[^>]*src="\/media\//)
  expect(html).toContain('alt="A blue and orange gradient"')
})

it('serves /public files', async () => {
  const res = await site.fetch('/public/site.css')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toMatch(/^text\/css/)
})

it('passes a query, method, headers and a form body through', async () => {
  const res = await site.fetch('/contact?locale=es', {
    method: 'POST',
    body: new URLSearchParams({ email: 'ana@example.com', message: 'Hola' }),
  })
  expect(res.status).toBe(200)
  expect(await res.text()).toContain('Gracias')
})

it('takes a file: URL string', async () => {
  const other = await createTestSite({ config: pathToFileURL(config).href })
  try {
    expect((await other.fetch('/')).status).toBe(200)
  } finally {
    await other.close()
  }
})

it('takes a file: URL and a baseUrl', async () => {
  const other = await createTestSite({ config: pathToFileURL(config), baseUrl: 'https://studio.example' })
  try {
    expect(await (await other.fetch('/sitemap.xml')).text()).toContain('<loc>https://studio.example/about</loc>')
  } finally {
    await other.close()
  }
})

it('takes a path relative to the working directory', async () => {
  const other = await createTestSite({ config: relative(process.cwd(), config) })
  try {
    expect((await other.fetch('/')).status).toBe(200)
  } finally {
    await other.close()
  }
})
