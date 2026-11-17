import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach } from 'vitest'
import { inlay } from '../../src/adapters/site/plugin.js'
import { appOptions, makeApp } from '../helpers/app.js'

let dir: string
const open: FastifyInstance[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inlay-public-'))
  await mkdir(join(dir, 'sub'))
  await mkdir(join(dir, 'd'))
  await writeFile(join(dir, 'site.css'), 'body{color:red}')
  await writeFile(join(dir, 'sub', 'a.js'), 'export {}')
  await writeFile(join(dir, '.env'), 'SECRET=1')
  await writeFile(join(dir, '..', `${dir.split('/').pop()}-outside.txt`), 'outside')
})

afterEach(async () => {
  await Promise.all(open.splice(0).map((a) => a.close()))
  await rm(dir, { recursive: true, force: true })
  await rm(`${dir}-outside.txt`, { force: true })
})

async function setup(withDir = true) {
  const made = await makeApp({ withOwner: true, ...(withDir && { publicDir: dir }) })
  open.push(made.app)
  return made
}

describe('/public/*', () => {
  it('serves a file with its content type, cache header and etag', async () => {
    const { app } = await setup()
    const res = await app.inject('/public/site.css')
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('body{color:red}')
    expect(res.headers['content-type']).toBe('text/css; charset=utf-8')
    expect(res.headers['cache-control']).toBe('public, max-age=3600')
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{32}"$/)
    expect((await app.inject('/public/sub/a.js')).headers['content-type']).toContain('text/javascript')
  })

  it('answers a matching ?v immutable for a year, and a stale or missing one with the normal max-age', async () => {
    const { app } = await setup()
    const v = createHash('sha256').update('body{color:red}').digest('hex').slice(0, 12)
    const right = await app.inject(`/public/site.css?v=${v}`)
    expect(right.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    const stale = await app.inject('/public/site.css?v=000000000000')
    const none = await app.inject('/public/site.css')
    expect(stale.headers['cache-control']).toBe('public, max-age=3600')
    expect(none.headers['cache-control']).toBe('public, max-age=3600')
    expect(stale.headers.etag).toBe(right.headers.etag)
    expect(none.headers.etag).toBe(right.headers.etag)
  })

  it("in a forced preview (a staged release's), is never stored or revalidated", async () => {
    const app = Fastify()
    open.push(app)
    await app.register(inlay, { ...(await appOptions({ publicDir: dir })), preview: 'forced' })
    const res = await app.inject('/public/site.css')
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers.etag).toBeUndefined()
    // Nor does an earlier ETag make it answer 304.
    const again = await app.inject({ url: '/public/site.css', headers: { 'if-none-match': '"anything"' } })
    expect(again.statusCode).toBe(200)
  })

  it('tells browsers not to sniff, and serves SVG under a policy that runs no script', async () => {
    await writeFile(join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    const { app } = await setup()
    expect((await app.inject('/public/site.css')).headers['x-content-type-options']).toBe('nosniff')
    expect((await app.inject('/public/site.css')).headers['content-security-policy']).toBe("frame-ancestors 'self'")
    const res = await app.inject('/public/logo.svg')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('image/svg+xml')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'")
  })

  it('does not follow symlinks', async () => {
    const outside = join(dir, '..', `${dir.split('/').pop()}-outside.txt`)
    await symlink(outside, join(dir, 'link.txt'))
    await symlink(join(dir, '..'), join(dir, 'up'))
    await symlink(join(dir, 'site.css'), join(dir, 'inside.css'))
    const { app } = await setup()
    for (const url of ['/public/link.txt', `/public/up/${outside.split('/').pop()}`, '/public/inside.css']) {
      const res = await app.inject(url)
      expect([url, res.statusCode]).toEqual([url, 404])
      expect(res.body).not.toContain('outside')
    }
  })

  it('answers 304 to a matching if-none-match', async () => {
    const { app } = await setup()
    const etag = (await app.inject('/public/site.css')).headers.etag as string
    const res = await app.inject({ url: '/public/site.css', headers: { 'if-none-match': etag } })
    expect(res.statusCode).toBe(304)
    expect(res.body).toBe('')
  })

  it('serves HEAD without a body', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'HEAD', url: '/public/site.css' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('')
    expect(res.headers['content-length']).toBe('15')
  })

  it('never serves outside the public directory', async () => {
    const { app } = await setup()
    const outside = `${dir.split('/').pop()}-outside.txt`
    const urls = [
      '/public/..%2fsite.css',
      '/public/..%2F..%2Fpackage.json',
      '/public/../package.json',
      '/public/.env',
      '/public/%2eenv',
      '/public/d',
      '/public/d/',
      '/public/sub%2f..%2f..%2fx',
      '/public/sub%5c..%5csite.css',
      `/public/../${outside}`,
      '/public//site.css',
      '/public/missing.css',
      '/public/',
    ]
    for (const url of urls) {
      const res = await app.inject(url)
      expect([url, res.statusCode]).toEqual([url, 404])
      expect(res.body).not.toContain('SECRET')
      expect(res.body).not.toContain('outside')
      expect(res.body).not.toContain('Welcome to Inlay')
    }
  })

  it('is reachable while the site is locked', async () => {
    const { app, core, owner } = await setup()
    await core.setSitePassword('open sesame', owner)
    await core.setSiteLock(true, owner)
    expect((await app.inject('/about')).statusCode).toBe(401)
    const res = await app.inject('/public/site.css')
    expect(res.statusCode).toBe(200)
  })

  it('is not registered without publicDir', async () => {
    const { app } = await setup(false)
    const res = await app.inject('/public/site.css')
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('body{color:red}')
  })
})
