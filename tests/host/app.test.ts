import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { FastifyInstance } from 'fastify'
import { previewLink } from '../../src/adapters/site/preview.js'
import { AUTH, type HostApi } from '../../src/adapters/site/plugin.js'
import { openDatabase } from '../../src/core/db/connection.js'
import { migrateSystem } from '../../src/core/db/migrate.js'
import { generateKeyPair } from '../../src/core/release/keys.js'
import { packRelease } from '../../src/core/release/pack.js'
import { loadRelease, type LoadedRelease } from '../../src/core/release/read.js'
import { t } from '../../src/core/messages/index.js'
import { activateRelease } from '../../src/host/activate.js'
import { createSiteApp, EMPTY_SITE } from '../../src/host/app.js'
import { ensureDataDir, readHostConfig, type HostConfig } from '../../src/host/config.js'
import type { ActivationSummary } from '../../src/host/ipc.js'
import { startPreviewApp, type PreviewApp } from '../../src/host/preview-worker.js'
import { readCurrentPointer, releaseDir, storeRelease } from '../../src/host/store.js'
import { png } from '../fixtures/media.js'
import { parseHtml, signIn } from '../helpers/admin.js'
import { OWNER_PASSWORD } from '../helpers/app.js'

const fixtures = resolve(import.meta.dirname, '../fixtures')

/** The fixture release's site with a render function on its home template, so `/` has a page to show. */
const siteSource = (redirects = '[]') => `import { defineRoute, defineSingleton, defineSite, defineTemplate, f, z } from 'inlaycms/site'
import { content } from './content.js'

const Home = defineTemplate({
  name: 'home',
  fields: z.object({ title: f.text({ label: 'Title' }), picture: f.image({ label: 'Picture' }) }),
  render: ({ fields }) => fields.title,
})

export const site = defineSite({
  locales: ['en'],
  defaultLocale: 'en',
  singletons: [defineSingleton({ name: 'home', label: 'Home', template: Home, path: '/' })],
  secrets: ['HOOK'],
  routes: [defineRoute({ method: 'GET', path: '/ping', handler: () => ({ json: { ok: true } }) })],
  content,
  redirects: ${redirects},
})
`

let packDir: string
let file: string
let keys: { privateKey: string; publicKey: string }

beforeAll(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'inlay-app-pack-'))
  const siteDir = join(packDir, 'site')
  await cp(join(fixtures, 'release'), siteDir, { recursive: true })
  await mkdir(join(siteDir, 'assets'))
  await writeFile(join(siteDir, 'assets/pic.png'), await png(20, 10))
  await writeFile(join(siteDir, 'site.ts'), siteSource())
  keys = generateKeyPair()
  file = join(packDir, 'site.tgz')
  await packRelease({ configFile: join(siteDir, 'inlay.config.ts'), privateKey: keys.privateKey, out: file, name: 'test-1' })
})
afterAll(() => rm(packDir, { recursive: true, force: true }))

let dataDir: string
let config: HostConfig
let app: FastifyInstance | undefined
let clock: number
const now = () => new Date(Date.UTC(2026, 10, 4, 12, 0, clock++))

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'inlay-app-'))
  config = readHostConfig({
    INLAY_DATA_DIR: dataDir,
    INLAY_BASE_URL: 'https://example.com',
    INLAY_SECRET: 's'.repeat(32),
    INLAY_RATE_LIMIT: 'off',
    INLAY_TRUSTED_KEYS: keys.publicKey,
    HOOK: 'hook-value',
  })
  await ensureDataDir(config)
  clock = 0
  app = undefined
})
afterEach(async () => {
  await app?.close()
  await rm(dataDir, { recursive: true, force: true })
})

/** Stores the packed release in the data directory and activates it, as `inlaycms activate` would. */
async function activated(): Promise<LoadedRelease> {
  const db = openDatabase(config.paths.db)
  try {
    await migrateSystem(db)
    const row = await storeRelease({ db, releasesDir: config.paths.releases, trustedKeys: [keys.publicKey], now }, file, {
      pushedBy: null,
    })
    const loaded = await loadRelease(releaseDir(config.paths.releases, row.id))
    await activateRelease(
      {
        db,
        loaded,
        releasesDir: config.paths.releases,
        backupsDir: config.paths.backups,
        mediaDir: config.paths.media,
        secretsEnv: config.secrets,
        now,
      },
      row.id,
    )
    return loaded
  } finally {
    await db.destroy()
  }
}

describe('createSiteApp with a release', () => {
  it('serves the release: its pages, public files, routes and the admin', async () => {
    const loaded = await activated()
    const made = await createSiteApp(config, loaded, { content: 'none', now })
    app = made.app

    const home = await app.inject({ method: 'GET', url: '/' })
    expect(home.statusCode).toBe(200)
    expect(home.body).toContain('Hello')
    expect(home.headers['x-robots-tag']).toBeUndefined()

    const css = await app.inject({ method: 'GET', url: '/public/site.css' })
    expect(css.statusCode).toBe(200)
    expect(css.body).toContain('color: #333')

    const ping = await app.inject({ method: 'GET', url: '/ping' })
    expect(ping.statusCode).toBe(200)
    expect(ping.json()).toEqual({ ok: true })

    expect((await app.inject({ method: 'GET', url: '/admin' })).headers.location).toBe('/admin/setup')
    expect((await app.inject({ method: 'GET', url: '/admin/setup' })).statusCode).toBe(200)
  })

  it('serves public files at the root only for releases packed with 0.7.0 or later', async () => {
    const loaded = await activated()
    const packedWith = (version: string): LoadedRelease => ({
      ...loaded,
      manifest: { ...loaded.manifest, inlay: { ...loaded.manifest.inlay, version } },
    })
    const newer = await createSiteApp(config, packedWith('0.7.0'), { content: 'none', now })
    app = newer.app
    expect((await app.inject({ method: 'GET', url: '/site.css' })).statusCode).toBe(200)
    await app.close()

    const older = await createSiteApp(config, packedWith('0.6.0'), { content: 'none', now })
    app = older.app
    expect((await app.inject({ method: 'GET', url: '/site.css' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/public/site.css' })).statusCode).toBe(200)
  })

  it('serves public files at the root for a source with no manifest, as inlaycms dev does', async () => {
    const loaded = await activated()
    const { manifest: _manifest, ...source } = loaded
    const made = await createSiteApp(config, source, { content: 'none', now })
    app = made.app
    expect((await app.inject({ method: 'GET', url: '/site.css' })).statusCode).toBe(200)
  })

  it('gives boot no time limit, so a large shipped-content set can be applied', async () => {
    const made = await createSiteApp(config, null, { content: 'none', now })
    app = made.app
    expect(app.initialConfig.pluginTimeout).toBe(0)
  })

  it('uses the data directory for the database', async () => {
    const loaded = await activated()
    const made = await createSiteApp(config, loaded, { content: 'none', now })
    app = made.app
    expect(await made.core.liveSingleton('home', 'en')).not.toBeNull()
  })
})

describe('createSiteApp applying shipped content', () => {
  it('serves a stored release that was never activated when told to apply its content', async () => {
    const db = openDatabase(config.paths.db)
    let loaded: LoadedRelease
    try {
      await migrateSystem(db)
      const row = await storeRelease({ db, releasesDir: config.paths.releases, trustedKeys: [keys.publicKey], now }, file, {
        pushedBy: null,
      })
      loaded = await loadRelease(releaseDir(config.paths.releases, row.id))
    } finally {
      await db.destroy()
    }
    const made = await createSiteApp(config, loaded, { content: 'apply', now })
    app = made.app
    const home = await app.inject({ method: 'GET', url: '/' })
    expect(home.statusCode).toBe(200)
    expect(home.body).toContain('Hello')
  })
})

describe('createSiteApp with no release', () => {
  it('answers every content route with the "no site yet" page, marked noindex', async () => {
    const made = await createSiteApp(config, null, { content: 'none', now })
    app = made.app
    for (const url of ['/', '/anything', '/de/somewhere?page=2']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      expect(res.headers['x-robots-tag']).toBe('noindex')
      expect(res.headers['content-type']).toContain('text/html')
      expect(res.body).toContain('This site has no release yet.')
    }
  })

  it('keeps the admin working', async () => {
    const made = await createSiteApp(config, null, { content: 'none', now })
    app = made.app
    expect((await app.inject({ method: 'GET', url: '/admin' })).headers.location).toBe('/admin/setup')
    expect((await app.inject({ method: 'GET', url: '/admin/setup' })).statusCode).toBe(200)
  })

  it('serves an empty but valid sitemap and robots.txt', async () => {
    const made = await createSiteApp(config, null, { content: 'none', now })
    app = made.app
    const sitemap = await app.inject({ method: 'GET', url: '/sitemap.xml' })
    expect(sitemap.statusCode).toBe(200)
    expect(sitemap.headers['content-type']).toContain('application/xml')
    expect(sitemap.body).toContain('<urlset')
    expect(sitemap.body).not.toContain('<url>')
    const robots = await app.inject({ method: 'GET', url: '/robots.txt' })
    expect(robots.statusCode).toBe(200)
    expect(robots.body).toContain('Sitemap: https://example.com/sitemap.xml')
  })

  it('does not serve /public/ without a release', async () => {
    const made = await createSiteApp(config, null, { content: 'none', now })
    app = made.app
    const res = await app.inject({ method: 'GET', url: '/public/site.css' })
    expect(res.body).toContain('This site has no release yet.')
  })
})

describe('createSiteApp for a site that is down', () => {
  it('answers 503 with Retry-After, not cached and not marked noindex', async () => {
    const made = await createSiteApp(config, null, { content: 'none', now, noSite: 'unavailable' })
    app = made.app
    for (const url of ['/', '/anything', '/public/site.css', '/sitemap.xml']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(503)
      expect(res.headers['retry-after']).toBe('60')
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.headers['x-robots-tag']).toBeUndefined()
      expect(res.body).toContain('This site is temporarily unavailable.')
    }
    expect((await app.inject({ method: 'GET', url: '/admin/setup' })).statusCode).toBe(200)
  })
})

describe('the host API', () => {
  it('is on app.inlay when inlaycms serve gives it, and null otherwise', async () => {
    const requestActivation = vi.fn(async () => ({
      shipped: { created: 0, replaced: 0, skipped: 0 },
      migrations: [],
      backup: null,
      noop: true,
      warnings: 0,
    }))
    const made = await createSiteApp(config, null, { content: 'none', now, host: { requestActivation } })
    app = made.app
    expect((await app.inlay.host?.requestActivation('rel-1'))?.noop).toBe(true)
    expect(requestActivation).toHaveBeenCalledWith('rel-1')
    await app.close()
    app = (await createSiteApp(config, null, { content: 'none', now })).app
    expect(app.inlay.host).toBeNull()
  })

  it('serves the push API only under the host', async () => {
    const requestActivation = vi.fn()
    app = (await createSiteApp(config, null, { content: 'none', now, host: { requestActivation } })).app
    const res = await app.inject({ method: 'GET', url: '/_inlay/releases' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: { code: 'unauthorized' } })
    await app.close()

    const loaded = await activated()
    app = (await createSiteApp(config, loaded, { content: 'none', now })).app
    expect((await app.inject({ method: 'GET', url: '/_inlay/releases' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/_inlay/releases', payload: 'x' })).statusCode).toBe(404)
  })
})

describe('the admin and MCP under the host', () => {
  const summary: ActivationSummary = { shipped: { created: 0, replaced: 0, skipped: 0 }, migrations: [], backup: null, noop: false, warnings: 0 }
  let preview: PreviewApp | undefined
  let mcp: Client | undefined
  afterEach(async () => {
    await mcp?.close()
    await preview?.close()
    mcp = undefined
    preview = undefined
  })

  /** The packed release activated as `test-1`, the same file staged again as "Spring refresh", and an owner. */
  async function hostApp(host?: HostApi) {
    const loaded = await activated()
    const pointer = await readCurrentPointer(config.paths.releases)
    const db = openDatabase(config.paths.db)
    let stagedId: string
    try {
      const deps = { db, releasesDir: config.paths.releases, trustedKeys: [keys.publicKey], now }
      stagedId = (await storeRelease(deps, file, { pushedBy: null, name: 'Spring refresh' })).id
    } finally {
      await db.destroy()
    }
    const release = { id: pointer!.id, name: pointer!.name }
    app = (await createSiteApp(config, loaded, { content: 'none', now, ...(host && { host, release }) })).app
    const service = app.inlay[AUTH]
    const owner = await service.createUser({ email: 'owner@example.com', name: 'Olivia Owner', password: OWNER_PASSWORD, role: 'owner' })
    return { app, stagedId, ownerKey: await service.createApiKey(owner.id!, 'owner key') }
  }

  it('lists the stored releases on /admin/releases and activates one through the host', async () => {
    const requestActivation = vi.fn<HostApi['requestActivation']>(async () => summary)
    const startPreview = vi.fn<NonNullable<HostApi['startPreview']>>(async () => preview!.socket)
    const { app, stagedId } = await hostApp({ requestActivation, startPreview, stopPreview: async () => {} })
    preview = await startPreviewApp(config, stagedId, { now })
    const olivia = await signIn(app, 'owner@example.com')

    const list = await olivia.get('/admin/releases')
    expect(list.statusCode).toBe(200)
    const rows = [...parseHtml(list.body).querySelectorAll('#releases tbody tr')].map((r) => r.textContent?.replace(/\s+/g, ' ') ?? '')
    expect(rows.find((r) => r.includes('test-1'))).toContain(t('admin.releases.state.current'))
    expect(rows.find((r) => r.includes('Spring refresh'))).toContain(t('admin.releases.state.staged'))

    const page = await olivia.get(`/admin/releases/${stagedId}`)
    expect(page.statusCode).toBe(200)
    const doc = parseHtml(page.body)
    expect(doc.querySelector(`form[action="/admin/releases/${stagedId}/activate"]`)).not.toBeNull()
    expect(doc.querySelector('#no-host')).toBeNull()
    // The content half of the diff came from the release's preview.
    expect(startPreview).toHaveBeenCalledWith(stagedId)
    expect(page.body).not.toContain(t('admin.releases.contentUnavailable'))
    expect(page.body).not.toContain(t('admin.releases.contentNeedsHost'))

    const activate = await olivia.post(`/admin/releases/${stagedId}/activate`, {})
    expect(activate.statusCode).toBe(303)
    expect(requestActivation).toHaveBeenCalledWith(stagedId)
  })

  it('without the host (inlaycms dev), lists releases but says activation needs it', async () => {
    const { app, stagedId } = await hostApp()
    const olivia = await signIn(app, 'owner@example.com')
    const list = await olivia.get('/admin/releases')
    expect(list.statusCode).toBe(200)
    expect(list.body).toContain('Spring refresh')
    const doc = parseHtml((await olivia.get(`/admin/releases/${stagedId}`)).body)
    expect(doc.querySelector('#no-host')?.textContent).toContain(t('admin.releases.noHost'))
    expect(doc.querySelector(`form[action="/admin/releases/${stagedId}/activate"]`)).toBeNull()
  })

  it("a staged release's preview has a read-only admin whose banner names the release", async () => {
    const { stagedId } = await hostApp({ requestActivation: async () => summary })
    preview = await startPreviewApp(config, stagedId, { now })
    const olivia = await signIn(preview.app, 'owner@example.com')
    const res = await olivia.get('/admin')
    expect(res.statusCode).toBe(200)
    expect(parseHtml(res.body).querySelector('main [role="status"]')?.textContent).toContain(
      t('admin.readOnly', { name: 'Spring refresh' }),
    )
    expect((await olivia.post('/admin/redirects', { from: '/a', to: '/b' })).statusCode).toBe(403)
  })

  it("the live site's preview of drafts keeps its own banner, not a release's", async () => {
    const { app } = await hostApp({ requestActivation: async () => summary })
    const link = new URL(previewLink({ baseUrl: config.baseUrl, secret: config.secret, now }, '/'))
    const set = await app.inject(`${link.pathname}${link.search}`)
    expect(set.statusCode).toBe(302)
    const cookie = String([set.headers['set-cookie']].flat()[0]).split(';')[0]!
    const page = await app.inject({ url: '/', headers: { cookie } })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain(t('preview.banner'))
    expect(page.body).toContain('href="/admin/publish"')
    expect(page.body).not.toContain('test-1')
  })

  it("describe_site over the host app's MCP names the current release", async () => {
    const { app, ownerKey } = await hostApp({ requestActivation: async () => summary })
    const transport = new StreamableHTTPClientTransport(new URL('https://example.com/mcp'), {
      fetch: async (url, init) => {
        const res = await app.inject({
          method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'DELETE',
          url: new URL(url).pathname,
          headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), 'x-api-key': ownerKey },
          ...(typeof init?.body === 'string' && { payload: init.body }),
        })
        const headers = new Headers()
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : String(value))
        }
        const empty = res.statusCode === 202 || res.statusCode === 204 || res.rawPayload.length === 0
        return new Response(empty ? null : new Uint8Array(res.rawPayload), { status: res.statusCode, headers })
      },
    })
    mcp = new Client({ name: 'inlay-host-test', version: '1.0.0' })
    await mcp.connect(transport)
    const result = await mcp.callTool({ name: 'describe_site', arguments: {} })
    expect(result.isError).not.toBe(true)
    const block = result.content[0]
    expect(JSON.parse(block?.type === 'text' ? block.text : '').release).toEqual({ name: 'test-1' })
  })
})

describe('code redirects follow the live release', () => {
  let fileA: string
  let fileB: string

  /** Packs the fixture site with `redirects` in its `defineSite`. */
  async function packWith(name: string, redirects: string): Promise<string> {
    const siteDir = join(packDir, `site-${name}`)
    await cp(join(fixtures, 'release'), siteDir, { recursive: true })
    await mkdir(join(siteDir, 'assets'))
    await writeFile(join(siteDir, 'assets/pic.png'), await png(20, 10))
    await writeFile(join(siteDir, 'site.ts'), siteSource(redirects))
    const out = join(packDir, `${name}.tgz`)
    await packRelease({ configFile: join(siteDir, 'inlay.config.ts'), privateKey: keys.privateKey, out, name })
    return out
  }

  beforeAll(async () => {
    fileA = await packWith('redirects-a', "[{ from: '/old', to: '/a' }]")
    fileB = await packWith('redirects-b', "[{ from: '/old', to: 'https://example.org/b' }]")
  })

  /** Stores `source` and activates it, or activates the stored release `again` that `source` made before. */
  async function activate(source: string, again?: string): Promise<{ id: string; loaded: LoadedRelease }> {
    const db = openDatabase(config.paths.db)
    try {
      await migrateSystem(db)
      const id =
        again ?? (await storeRelease({ db, releasesDir: config.paths.releases, trustedKeys: [keys.publicKey], now }, source, { pushedBy: null })).id
      const loaded = await loadRelease(releaseDir(config.paths.releases, id))
      await activateRelease(
        {
          db,
          loaded,
          releasesDir: config.paths.releases,
          backupsDir: config.paths.backups,
          mediaDir: config.paths.media,
          secretsEnv: config.secrets,
          now,
        },
        id,
      )
      return { id, loaded }
    } finally {
      await db.destroy()
    }
  }

  async function locationOf(loaded: LoadedRelease): Promise<unknown> {
    const made = await createSiteApp(config, loaded, { content: 'none', now })
    try {
      return (await made.app.inject({ method: 'GET', url: '/old' })).headers.location
    } finally {
      await made.app.close()
    }
  }

  it('activating a release with other code rules changes what is served, and rolling back restores it', async () => {
    const a = await activate(fileA)
    expect(await locationOf(a.loaded)).toBe('/a')
    const b = await activate(fileB)
    expect(await locationOf(b.loaded)).toBe('https://example.org/b')
    const back = await activate(fileA, a.id)
    expect(await locationOf(back.loaded)).toBe('/a')
  })

  it("a staged release's preview serves its own code rules", async () => {
    const a = await activate(fileA)
    const db = openDatabase(config.paths.db)
    let stagedId: string
    try {
      stagedId = (await storeRelease({ db, releasesDir: config.paths.releases, trustedKeys: [keys.publicKey], now }, fileB, { pushedBy: null })).id
    } finally {
      await db.destroy()
    }
    const live = await createSiteApp(config, a.loaded, { content: 'none', now })
    app = live.app
    const preview = await startPreviewApp(config, stagedId, { now })
    try {
      expect((await preview.app.inject({ method: 'GET', url: '/old' })).headers.location).toBe('https://example.org/b')
      expect((await app.inject({ method: 'GET', url: '/old' })).headers.location).toBe('/a')
    } finally {
      await preview.close()
    }
  })
})

describe('EMPTY_SITE', () => {
  it('has one locale, no types and the default admin name', () => {
    expect(EMPTY_SITE.locales).toEqual(['en'])
    expect(EMPTY_SITE.singletons).toEqual([])
    expect(EMPTY_SITE.collections).toEqual([])
    expect(EMPTY_SITE.globals).toEqual([])
    expect(EMPTY_SITE.admin.name).toBe('Inlay')
  })
})
