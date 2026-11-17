import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach } from 'vitest'
import { publicAssets } from '../../src/adapters/site/assets.js'
import { defineSingleton, defineSite, defineTemplate } from '../../src/core/registry/define.js'
import { raw } from '../../src/jsx/html.js'
import { Page, webSite } from '../fixtures/web.js'
import { makeApp } from '../helpers/app.js'

const hash = (content: string) => createHash('sha256').update(content).digest('hex').slice(0, 12)

let root: string
let dir: string
const open: FastifyInstance[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inlay-assets-'))
  dir = join(root, 'public')
  await mkdir(join(dir, 'sub'), { recursive: true })
  await writeFile(join(dir, 'site.css'), 'body{color:red}')
  await writeFile(join(dir, 'sub', 'a.js'), 'export {}')
  await writeFile(join(root, 'outside.css'), 'outside')
  await symlink(join(dir, 'site.css'), join(dir, 'link.css'))
})

afterEach(async () => {
  await Promise.all(open.splice(0).map((a) => a.close()))
  await rm(root, { recursive: true, force: true })
})

describe('publicAssets', () => {
  it('versions a file with the first 12 hex characters of its sha256', () => {
    const v = hash('body{color:red}')
    const assets = publicAssets(dir)
    expect(assets.url('site.css')).toBe(`/public/site.css?v=${v}`)
    expect(assets.url('/site.css')).toBe(`/public/site.css?v=${v}`)
    expect(assets.url('/public/site.css')).toBe(`/public/site.css?v=${v}`)
    expect(assets.url('sub/a.js')).toMatch(/^\/public\/sub\/a\.js\?v=[0-9a-f]{12}$/)
  })

  it('gives a missing, escaping or symlinked path an unversioned URL without throwing', () => {
    const assets = publicAssets(dir)
    expect(assets.url('nope.css')).toBe('/public/nope.css')
    expect(assets.url('../outside.css')).not.toContain('?v=')
    expect(assets.url(join(root, 'outside.css'))).not.toContain('?v=')
    expect(assets.url('link.css')).not.toContain('?v=')
    expect(publicAssets(null).url('site.css')).not.toContain('?v=')
  })

  it('never throws on a lone surrogate', () => {
    const url = publicAssets(dir).url('\uD800.css')
    expect(url.startsWith('/public/')).toBe(true)
    expect(url).not.toContain('?v=')
  })

  it('gives a path through a symlinked folder no version', async () => {
    await mkdir(join(root, 'elsewhere'))
    await writeFile(join(root, 'elsewhere', 'x.css'), 'x')
    await symlink(join(root, 'elsewhere'), join(dir, 'dir'))
    expect(publicAssets(dir).url('dir/x.css')).toBe('/public/dir/x.css')
  })

  it('gives a symlink an unversioned URL that /public/* answers with a 404', async () => {
    const { app } = await makeApp({ publicDir: dir })
    open.push(app)
    const url = publicAssets(dir).url('link.css')
    expect(url).toBe('/public/link.css')
    expect((await app.inject(url)).statusCode).toBe(404)
  })

  it('re-hashes an edited file', async () => {
    const assets = publicAssets(dir)
    const first = assets.url('site.css')
    expect(assets.url('site.css')).toBe(first)
    await writeFile(join(dir, 'site.css'), 'body{color:blue;margin:0}')
    const second = assets.url('site.css')
    expect(second).not.toBe(first)
    expect(second).toBe(`/public/site.css?v=${hash('body{color:blue;margin:0}')}`)
    expect(assets.url('site.css')).toBe(second)
  })

  it('renders ctx.asset in a template, and the URL it gives is served immutable', async () => {
    const WithCss = defineTemplate({
      ...Page,
      render: (_props, ctx) => raw(`<html><head><link rel="stylesheet" href="${ctx.asset('site.css')}"></head><body></body></html>`),
    })
    const site = defineSite({
      ...webSite,
      singletons: webSite.singletons.map((s) => (s.name === 'about' ? defineSingleton({ ...s, template: WithCss }) : s)),
    })
    const { app } = await makeApp({ site, publicDir: dir })
    open.push(app)
    const url = `/public/site.css?v=${hash('body{color:red}')}`
    const page = await app.inject('/about')
    expect(page.body).toContain(url)
    expect((await app.inject(url)).headers['cache-control']).toBe('public, max-age=31536000, immutable')
  })
})
