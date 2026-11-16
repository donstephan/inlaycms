import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { HostApi } from '../../src/adapters/site/plugin.js'
import { previewLink } from '../../src/adapters/site/preview.js'
import { openDatabase } from '../../src/core/db/connection.js'
import { migrateSystem } from '../../src/core/db/migrate.js'
import { InlayError } from '../../src/core/errors.js'
import { generateKeyPair } from '../../src/core/release/keys.js'
import { packRelease } from '../../src/core/release/pack.js'
import { loadRelease, type LoadedRelease } from '../../src/core/release/read.js'
import type { Ctx } from '../../src/core/types.js'
import { activateRelease } from '../../src/host/activate.js'
import { createSiteApp } from '../../src/host/app.js'
import { ensureDataDir, readHostConfig, type HostConfig } from '../../src/host/config.js'
import { startPreviewApp, type PreviewApp } from '../../src/host/preview-worker.js'
import type { ContentDiff } from '../../src/host/push.js'
import { releaseDir, storeRelease } from '../../src/host/store.js'
import { png } from '../fixtures/media.js'

const fixtures = resolve(import.meta.dirname, '../fixtures')

const currentSite = `import { defineGlobal, defineRoute, defineSingleton, defineSite, defineTemplate, f, z } from 'inlaycms/site'
import { content } from './content.js'

const Home = defineTemplate({
  name: 'home',
  fields: z.object({ title: f.text({ label: 'Title' }), picture: f.image({ label: 'Picture' }) }),
  render: ({ fields }) => fields.title,
})
const Footer = defineTemplate({ name: 'footer', fields: z.object({ text: f.text({ label: 'Text' }) }) })

export const site = defineSite({
  locales: ['en'],
  defaultLocale: 'en',
  singletons: [defineSingleton({ name: 'home', label: 'Home', template: Home, path: '/' })],
  globals: [defineGlobal({ name: 'footer', label: 'Footer', template: Footer })],
  secrets: ['HOOK'],
  routes: [defineRoute({ method: 'GET', path: '/ping', handler: () => ({ json: { ok: true } }) })],
  content,
})
`

const currentContent = `import { defineContent } from 'inlaycms/site'

export const content = [
  defineContent('home', {
    edition: 1,
    content: { en: { fields: { title: 'Hello', picture: { file: new URL('./assets/pic.png', import.meta.url), alt: 'A picture' } } } },
  }),
  defineContent('footer', { edition: 1, content: { en: { fields: { text: 'Footer' } } } }),
]
`

/** The staged release: a new headline at edition 2, a new picture, a footer field every footer must have, a POST route. */
const stagedSite = `import { defineGlobal, defineRoute, defineSingleton, defineSite, defineTemplate, f, z } from 'inlaycms/site'
import { content } from './content.js'

const Home = defineTemplate({
  name: 'home',
  fields: z.object({ title: f.text({ label: 'Title' }), picture: f.image({ label: 'Picture' }) }),
  render: ({ fields }) => fields.title,
})
const Footer = defineTemplate({
  name: 'footer',
  fields: z.object({ text: f.text({ label: 'Text' }), note: f.text({ label: 'Note' }) }),
})

export const site = defineSite({
  locales: ['en'],
  defaultLocale: 'en',
  singletons: [defineSingleton({ name: 'home', label: 'Home', template: Home, path: '/' })],
  globals: [defineGlobal({ name: 'footer', label: 'Footer', template: Footer })],
  secrets: ['HOOK'],
  routes: [
    defineRoute({ method: 'GET', path: '/ping', handler: () => ({ json: { ok: true } }) }),
    defineRoute({ method: 'POST', path: '/hook', handler: () => ({ json: { staged: true } }) }),
  ],
  content,
})
`

const stagedContent = `import { defineContent } from 'inlaycms/site'

export const content = [
  defineContent('home', {
    edition: 2,
    content: { en: { fields: { title: 'Staged headline', picture: { file: new URL('./assets/pic.png', import.meta.url), alt: 'A new picture' } } } },
  }),
]
`

/** A release that drops the footer and adds notes, with a migration function that writes one. */
const migratedSite = `import { defineCollection, defineMigration, defineSingleton, defineSite, defineTemplate, f, z } from 'inlaycms/site'
import { content } from './content.js'

const Home = defineTemplate({
  name: 'home',
  fields: z.object({ title: f.text({ label: 'Title' }), picture: f.image({ label: 'Picture' }) }),
  render: ({ fields }) => fields.title,
})
const Note = defineTemplate({ name: 'note', fields: z.object({ title: f.text({ label: 'Title' }) }), render: ({ fields }) => fields.title })

export const site = defineSite({
  locales: ['en'],
  defaultLocale: 'en',
  singletons: [defineSingleton({ name: 'home', label: 'Home', template: Home, path: '/' })],
  collections: [defineCollection({ name: 'notes', label: 'Notes', template: Note, route: '/notes/:slug' })],
  secrets: ['HOOK'],
  content,
  migrations: [
    defineMigration({
      name: 'add-note',
      run: async (ctx) => {
        const { id } = await ctx.create('notes', { slug: 'hello', fields: { title: 'Written by a migration' } })
        await ctx.publish([id])
      },
    }),
  ],
})
`

const owner: Ctx = { actor: { id: 'user-owner', name: 'Olivia Owner', role: 'owner' }, source: 'admin' }

let packDir: string
let currentFile: string
let stagedFile: string
let migratedFile: string
let keys: { privateKey: string; publicKey: string }

async function packSite(name: string, siteTs: string, contentTs: string, picture: Buffer): Promise<string> {
  const siteDir = join(packDir, name)
  await cp(join(fixtures, 'release'), siteDir, { recursive: true })
  await mkdir(join(siteDir, 'assets'))
  await writeFile(join(siteDir, 'assets/pic.png'), picture)
  await writeFile(join(siteDir, 'site.ts'), siteTs)
  await writeFile(join(siteDir, 'content.ts'), contentTs)
  const out = join(packDir, `${name}.tgz`)
  await packRelease({ configFile: join(siteDir, 'inlay.config.ts'), privateKey: keys.privateKey, out, name })
  return out
}

beforeAll(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'inlay-preview-pack-'))
  keys = generateKeyPair()
  currentFile = await packSite('current', currentSite, currentContent, await png(20, 10))
  stagedFile = await packSite('staged', stagedSite, stagedContent, await png(30, 10))
  migratedFile = await packSite('migrated', migratedSite, stagedContent, await png(30, 10))
})
afterAll(() => rm(packDir, { recursive: true, force: true }))

let dataDir: string
let config: HostConfig
let clock: number
const now = () => new Date(Date.UTC(2026, 10, 5, 12, 0, clock++))
let currentId: string
let stagedId: string
let current: FastifyInstance | undefined
let preview: PreviewApp | undefined
let host: {
  requestActivation: ReturnType<typeof vi.fn<HostApi['requestActivation']>>
  startPreview: ReturnType<typeof vi.fn<NonNullable<HostApi['startPreview']>>>
  stopPreview: ReturnType<typeof vi.fn<NonNullable<HostApi['stopPreview']>>>
  touchPreview: ReturnType<typeof vi.fn<NonNullable<HostApi['touchPreview']>>>
}

/** Stores both releases and activates the current one, as `inlaycms activate` would. */
async function storeBoth(): Promise<LoadedRelease> {
  const db = openDatabase(config.paths.db)
  try {
    await migrateSystem(db)
    const deps = { db, releasesDir: config.paths.releases, trustedKeys: [keys.publicKey], now }
    const row = await storeRelease(deps, currentFile, { pushedBy: null })
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
    currentId = row.id
    stagedId = (await storeRelease(deps, stagedFile, { pushedBy: null, name: 'Spring refresh' })).id
    return loaded
  } finally {
    await db.destroy()
  }
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'inlay-preview-'))
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
  preview = undefined
  const loaded = await storeBoth()
  host = {
    requestActivation: vi.fn<HostApi['requestActivation']>(),
    startPreview: vi.fn<NonNullable<HostApi['startPreview']>>(async (id) => {
      if (id !== stagedId || preview === undefined) throw new InlayError('invalid_operation', 'error.previewUnavailable')
      return preview.socket
    }),
    stopPreview: vi.fn<NonNullable<HostApi['stopPreview']>>(async () => {}),
    touchPreview: vi.fn<NonNullable<HostApi['touchPreview']>>(),
  }
  current = (await createSiteApp(config, loaded, { content: 'none', now, host })).app
})
afterEach(async () => {
  await current?.close()
  await preview?.close()
  await rm(dataDir, { recursive: true, force: true })
})

const start = async () => (preview = await startPreviewApp(config, stagedId, { now }))

/** Stores `file` as another staged release, as a push would. */
async function stage(file: string, name: string): Promise<string> {
  const db = openDatabase(config.paths.db)
  try {
    return (await storeRelease({ db, releasesDir: config.paths.releases, trustedKeys: [keys.publicKey], now }, file, { pushedBy: null, name })).id
  } finally {
    await db.destroy()
  }
}

async function releaseIds(): Promise<string[]> {
  const db = openDatabase(config.paths.db)
  try {
    return (await db.selectFrom('releases').select('id').execute()).map((r) => r.id).sort()
  } finally {
    await db.destroy()
  }
}

/** The cookie a preview link (of `release`, or of the live site's drafts) sets, as a `Cookie` header value. */
async function cookieFor(release?: string): Promise<string> {
  const url = new URL(previewLink({ baseUrl: config.baseUrl, secret: config.secret, now }, '/', release === undefined ? {} : { release }))
  const res = await current!.inject(`${url.pathname}${url.search}`)
  expect(res.statusCode).toBe(302)
  return setCookie(res).split(';')[0]!
}

function setCookie(res: { headers: Record<string, unknown> }): string {
  const header = res.headers['set-cookie']
  return String(Array.isArray(header) ? header[0] : header)
}

async function liveState(): Promise<{ db: number; wal: number | null; media: string[] }> {
  const wal = await stat(`${config.paths.db}-wal`).catch(() => null)
  return {
    db: (await stat(config.paths.db)).mtimeMs,
    wal: wal?.mtimeMs ?? null,
    media: (await readdir(config.paths.media, { recursive: true })).sort(),
  }
}

describe('preview routing', () => {
  it('a signed link with a release sets a cookie naming it, and requests with it reach the preview', async () => {
    await start()
    const cookie = await cookieFor(stagedId)
    expect(cookie).toMatch(new RegExp(`^inlay_preview=v2\\.[0-9a-z]+\\.${stagedId}\\.[A-Za-z0-9_-]+$`))

    const res = await current!.inject({ url: '/', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Staged headline')
    expect(res.body).toContain('Previewing release Spring refresh')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers.vary).toBe('Cookie')
    expect(res.headers.etag).toBeUndefined()
    expect(res.headers['x-robots-tag']).toBe('noindex')
    expect(host.startPreview).toHaveBeenCalledWith(stagedId)

    // The staged release's routes run.
    const ping = await current!.inject({ url: '/ping', headers: { cookie } })
    expect(ping.json()).toEqual({ ok: true })

    // Without the cookie, or with a preview of the live site's drafts, the live site answers.
    const live = await current!.inject('/')
    expect(live.body).toContain('Hello')
    expect(live.body).not.toContain('inlay-preview')
    const drafts = await current!.inject({ url: '/', headers: { cookie: await cookieFor() } })
    expect(drafts.body).toContain('Hello')
    expect(drafts.body).toContain('You are previewing unpublished changes')
    expect(host.startPreview).toHaveBeenCalledTimes(1)
  })

  it('reports the preview in use at most once a minute, and asks for it again after five idle minutes', async () => {
    await start()
    const cookie = await cookieFor(stagedId)
    const get = () => current!.inject({ url: '/', headers: { cookie } })
    await get()
    await get()
    expect(host.startPreview).toHaveBeenCalledTimes(1)
    expect(host.touchPreview).not.toHaveBeenCalled()
    clock += 70
    await get()
    await get()
    expect(host.touchPreview).toHaveBeenCalledTimes(1)
    expect(host.touchPreview).toHaveBeenCalledWith(stagedId)
    clock += 400
    expect((await get()).body).toContain('Staged headline')
    expect(host.startPreview).toHaveBeenCalledTimes(2)
  })

  it("the staged release's files, media and route answers are never cached under the live URLs", async () => {
    const live = await current!.inject('/public/site.css')
    expect(live.headers['cache-control']).toMatch(/^public, max-age=/)
    expect(live.headers.etag).toBeDefined()

    await start()
    const cookie = await cookieFor(stagedId)
    for (const url of ['/public/site.css', '/ping']) {
      const proxied = await current!.inject({ url, headers: { cookie } })
      expect(proxied.statusCode).toBe(200)
      expect(proxied.headers['cache-control']).toBe('no-store')
      expect(proxied.headers.vary).toBe('Cookie')
      expect(proxied.headers.etag).toBeUndefined()
      expect(proxied.headers['last-modified']).toBeUndefined()

      // The preview itself sends nothing a cache could keep either.
      const direct = await preview!.app.inject(url)
      expect(direct.headers['cache-control']).toBe('no-store')
      expect(direct.headers.etag).toBeUndefined()
    }
    const home = await preview!.core.findSingleton('home', 'en')
    const picture = ((await preview!.core.getDocument(home!.id))!.data.fields as { picture: { media: string } }).picture.media
    const media = await current!.inject({ url: `/media/${picture}`, headers: { cookie } })
    expect(media.statusCode).toBe(200)
    expect(media.headers['cache-control']).toBe('no-store')
    expect(media.headers.etag).toBeUndefined()
  })

  it('never forwards the admin, logging in, MCP, .well-known or /_inlay: the current site answers them', async () => {
    await start()
    const cookie = await cookieFor(stagedId)
    for (const url of ['/admin', '/admin/login', '/api/auth/get-session', '/mcp', '/.well-known/oauth-protected-resource', '/_inlay/unlock']) {
      const res = await current!.inject({ url, headers: { cookie } })
      expect(res.body).not.toContain('Previewing release')
    }
    // Percent-encoded, Fastify still answers them with the admin's and /api/auth's routes: not forwarded either.
    for (const url of ['/%61dmin/redirects', '/%61pi/auth/update-user']) {
      const res = await current!.inject({ method: 'POST', url, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'a=b' })
      expect(res.body).not.toContain('Previewing release')
    }
    expect(host.startPreview).not.toHaveBeenCalled()
  })

  it("the preview refuses the admin's and /api/auth's writes but logging in and out, and says how to leave it", async () => {
    await start()
    const form = { 'content-type': 'application/x-www-form-urlencoded' }
    for (const url of ['/admin/redirects', '/api/auth/update-user', '/api/auth/change-password', '/api/auth/x/../update-user', '/%61dmin/redirects', '/%61pi/auth/update-user', '/%61dmin/login']) {
      const res = await preview!.app.inject({ method: 'POST', url, headers: form, payload: 'a=b' })
      expect(res.statusCode).toBe(403)
      expect(res.body).toContain('/_inlay/preview/exit')
    }
    for (const url of ['/api/auth/sign-in/email', '/api/auth/sign-out', '/admin/login']) {
      const res = await preview!.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: '{}' })
      expect(res.body).not.toContain('Nothing can be changed in a preview')
    }
  })

  it('the exit path clears the cookie on the current site', async () => {
    await start()
    const cookie = await cookieFor(stagedId)
    const res = await current!.inject({ url: '/_inlay/preview/exit', headers: { cookie } })
    expect(res.statusCode).toBe(302)
    expect(setCookie(res)).toMatch(/^inlay_preview=; .*Max-Age=0/)
    expect(host.startPreview).not.toHaveBeenCalled()
  })

  it('a stale preview cookie is cleared', async () => {
    // Since activated: not staged any more.
    const activated = await cookieFor(currentId)
    const res = await current!.inject({ url: '/', headers: { cookie: activated } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Hello')
    expect(res.body).not.toContain('inlay-preview')
    expect(setCookie(res)).toMatch(/^inlay_preview=; .*Max-Age=0/)
    expect(host.startPreview).not.toHaveBeenCalled()

    // Staged, but the host can't start its preview.
    const staged = await cookieFor(stagedId)
    const refused = await current!.inject({ url: '/', headers: { cookie: staged } })
    expect(refused.statusCode).toBe(200)
    expect(refused.body).toContain('Hello')
    expect(setCookie(refused)).toMatch(/^inlay_preview=; .*Max-Age=0/)

    // Deleted after the link was made.
    const db = openDatabase(config.paths.db)
    await db.updateTable('releases').set({ state: 'deleted' }).where('id', '=', stagedId).execute()
    await db.destroy()
    const deleted = await current!.inject({ url: '/', headers: { cookie: staged } })
    expect(deleted.body).toContain('Hello')
    expect(setCookie(deleted)).toMatch(/^inlay_preview=; .*Max-Age=0/)
  })

  it('answers 502 with a plain page when the preview does not answer', async () => {
    host.startPreview.mockResolvedValue(join(dataDir, 'run', 'missing.sock'))
    const res = await current!.inject({ url: '/', headers: { cookie: await cookieFor(stagedId) } })
    expect(res.statusCode).toBe(502)
    expect(res.headers['content-type']).toMatch(/^text\/html/)
    expect(res.body).toContain('<meta name="robots" content="noindex">')
  })

  it('preview writes nothing', async () => {
    const before = await liveState()
    await start()
    const cookie = await cookieFor(stagedId)

    // A POST route runs; the admin's writes are refused.
    const hook = await current!.inject({ method: 'POST', url: '/hook', headers: { cookie, 'content-type': 'application/json' }, payload: '{}' })
    expect(hook.statusCode).toBe(200)
    expect(hook.json()).toEqual({ staged: true })
    const admin = await preview!.app.inject({
      method: 'POST',
      url: '/admin/redirects',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'from=/a&to=/b',
    })
    expect(admin.statusCode).toBe(403)

    const home = await preview!.core.findSingleton('home', 'en')
    const view = await preview!.core.getDocument(home!.id)
    await expect(
      preview!.core.saveDraft(view!.id, { baseRevisionId: view!.headRev, data: view!.data }, owner),
    ).rejects.toMatchObject({ code: 'read_only', messageId: 'error.previewReadOnly' })
    await expect(preview!.core.addMedia({ data: await png(5, 5), filename: 'x.png' }, owner)).rejects.toMatchObject({
      messageId: 'error.previewReadOnly',
    })
    await expect(preview!.core.publish([view!.id], owner)).rejects.toMatchObject({ messageId: 'error.previewReadOnly' })

    // The new picture the staged release ships is shown, from the preview's own folder.
    const picture = (view!.data.fields as { picture: { media: string } }).picture.media
    expect((await current!.inject({ url: `/media/${picture}`, headers: { cookie } })).statusCode).toBe(200)

    await preview!.close()
    preview = undefined
    expect(await liveState()).toEqual(before)
  })

  it('serves the content diff on the preview socket only', async () => {
    await start()
    const res = await preview!.app.inject('/_inlay/internal/diff')
    expect(res.statusCode).toBe(200)
    const diff = res.json<ContentDiff>()
    expect(diff.gaps).toEqual([{ type: 'footer', label: 'Footer', documents: 1 }])
    expect(diff.shipped.replaced.map((i) => [i.type, i.edition])).toEqual([['home', 2]])
    expect(diff.hidden).toEqual({ types: [], locales: [] })

    // Not through the proxy, and not for a request the proxy forwarded.
    const cookie = await cookieFor(stagedId)
    expect((await current!.inject({ url: '/_inlay/internal/diff', headers: { cookie } })).statusCode).toBe(404)
    expect(
      (await preview!.app.inject({ url: '/_inlay/internal/diff', headers: { 'x-inlay-preview-release': stagedId } })).statusCode,
    ).toBe(404)
  })

  it('counts the documents a release that drops a type would hide, and runs its migration functions on the copy', async () => {
    const id = await stage(migratedFile, 'Notes')
    preview = await startPreviewApp(config, id, { now })
    const diff = (await preview.app.inject('/_inlay/internal/diff')).json<ContentDiff>()
    expect(diff.hidden).toEqual({ types: [{ type: 'footer', documents: 1 }], locales: [] })

    const note = await preview.app.inject('/notes/hello')
    expect(note.statusCode).toBe(200)
    expect(note.body).toContain('Written by a migration')
    // Only on the copy: the live site never ran it.
    const db = openDatabase(config.paths.db)
    try {
      expect(await db.selectFrom('release_migrations').selectAll().where('release_id', '=', id).execute()).toEqual([])
    } finally {
      await db.destroy()
    }
  })

  it('previews a release from a push scratch folder without a row in the live table', async () => {
    const before = await releaseIds()
    const work = await mkdtemp(join(config.paths.releases, '.push-'))
    const scratch = openDatabase(':memory:')
    let id: string
    try {
      await migrateSystem(scratch)
      id = (await storeRelease({ db: scratch, releasesDir: work, trustedKeys: [keys.publicKey], now }, stagedFile, { pushedBy: null })).id
    } finally {
      await scratch.destroy()
    }
    preview = await startPreviewApp(config, id, { now, dir: work })
    const res = await preview.app.inject('/')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Staged headline')
    expect((await preview.app.inject('/_inlay/internal/diff')).json<ContentDiff>().gaps).toEqual([{ type: 'footer', label: 'Footer', documents: 1 }])
    expect(await releaseIds()).toEqual(before)

    // Only a scratch folder right inside the releases folder.
    await expect(startPreviewApp(config, id, { now, dir: join(dataDir, 'elsewhere') })).rejects.toMatchObject({ messageId: 'error.releaseUnknown' })
    await rm(work, { recursive: true, force: true })
  })

  it('the preview refuses a request forwarded for another release', async () => {
    await start()
    const res = await preview!.app.inject({ url: '/', headers: { 'x-inlay-preview-release': currentId } })
    expect(res.statusCode).toBe(421)
    expect((await preview!.app.inject({ url: '/', headers: { 'x-inlay-preview-release': stagedId } })).statusCode).toBe(200)
  })

  it('a preview of a release that is not staged does not start', async () => {
    await expect(startPreviewApp(config, currentId, { now })).rejects.toMatchObject({ messageId: 'error.previewNotStaged' })
    await expect(startPreviewApp(config, 'no-such-release', { now })).rejects.toMatchObject({ messageId: 'error.releaseUnknown' })
    expect(await readdir(join(dataDir, 'run')).catch(() => [])).toEqual([])
  })
})
