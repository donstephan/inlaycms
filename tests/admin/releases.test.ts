import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { openDatabase } from '../../src/core/db/connection.js'
import type { Database } from '../../src/core/db/schema.js'
import { t } from '../../src/core/messages/index.js'
import { generateKeyPair } from '../../src/core/release/keys.js'
import { packRelease } from '../../src/core/release/pack.js'
import { adminHostHooks, type AdminHostHooks } from '../../src/host/hooks.js'
import type { ActivationSummary } from '../../src/host/ipc.js'
import type { HostApi } from '../../src/adapters/site/plugin.js'
import type { ContentDiff, PushOptions } from '../../src/host/push.js'
import { deleteRelease, getRelease, listReleases, releaseDir, storeRelease, type ReleaseRow } from '../../src/host/store.js'
import { png } from '../fixtures/media.js'
import { makeApp, type MakeAppOptions } from '../helpers/app.js'
import { parseHtml, signIn, type AdminClient } from '../helpers/admin.js'

const fixtures = resolve(import.meta.dirname, '../fixtures')

const siteTs = (fields: string, migrations = '') => `import { defineMigration, defineSingleton, defineSite, defineTemplate, f, z } from 'inlaycms/site'
import { content } from './content.js'

const Home = defineTemplate({ name: 'home', fields: z.object({ ${fields} }) })

export const site = defineSite({
  locales: ['en'],
  defaultLocale: 'en',
  singletons: [defineSingleton({ name: 'home', label: 'Home', template: Home, path: '/' })],
  secrets: ['HOOK'],
  migrations: [${migrations}],
  content,
})
`

const summary: ActivationSummary = { shipped: { created: 0, replaced: 0, skipped: 0 }, migrations: [], backup: null, noop: false, warnings: 0 }

const contentDiff: ContentDiff = {
  gaps: [{ type: 'home', label: 'Home', documents: 1 }],
  shipped: { created: [], replaced: [], skipped: [], deletedRefs: [], warnings: [] },
  hidden: { types: [], locales: [] },
}

let packDir: string
let keys: { privateKey: string; publicKey: string }
let first: string
let second: string

async function packSite(name: string, fields: string, migrations?: string): Promise<string> {
  const siteDir = join(packDir, name)
  await cp(join(fixtures, 'release'), siteDir, { recursive: true })
  await mkdir(join(siteDir, 'assets'))
  await writeFile(join(siteDir, 'assets/pic.png'), await png(20, 10))
  await writeFile(join(siteDir, 'site.ts'), siteTs(fields, migrations))
  const out = join(packDir, `${name}.tgz`)
  await packRelease({ configFile: join(siteDir, 'inlay.config.ts'), privateKey: keys.privateKey, out, name })
  return out
}

beforeAll(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'inlay-admin-releases-'))
  keys = generateKeyPair()
  const title = "title: f.text({ label: 'Title' }), picture: f.image({ label: 'Picture' })"
  first = await packSite('first', title)
  second = await packSite(
    'second',
    `${title}, subtitle: f.text({ label: 'Subtitle' }).optional()`,
    "defineMigration({ name: 'fill-subtitles', run: async () => {} })",
  )
})
afterAll(() => rm(packDir, { recursive: true, force: true }))

let dataDir: string
let releasesDir: string
let db: Kysely<Database>
let pushDb: Kysely<Database>
const closers: Array<() => Promise<unknown>> = []
let app: FastifyInstance
let olivia: AdminClient
let eddie: AdminClient
let live: ReleaseRow
let staged: ReleaseRow
let hooks: AdminHostHooks & {
  requestActivation: ReturnType<typeof vi.fn<AdminHostHooks['requestActivation']>>
  contentDiff: ReturnType<typeof vi.fn<AdminHostHooks['contentDiff']>>
  stopPreview: ReturnType<typeof vi.fn<NonNullable<AdminHostHooks['stopPreview']>>>
}
const now = () => new Date('2026-11-05T12:00:00.000Z')

async function start(opts: Partial<MakeAppOptions> = {}): Promise<void> {
  ;({ app } = await makeApp({ withOwner: true, db: join(dataDir, 'inlay.db'), ...opts }))
  await app.ready()
  db = openDatabase(join(dataDir, 'inlay.db'))
  closers.push(() => db.destroy(), () => app.close())
  const store = { db, releasesDir, trustedKeys: [keys.publicKey], now }
  live = await storeRelease(store, first, { pushedBy: null })
  await db.updateTable('releases').set({ state: 'current', activated_at: now().toISOString() }).where('id', '=', live.id).execute()
  staged = await storeRelease(store, second, { pushedBy: null })
  olivia = await signIn(app, 'owner@example.com')
  eddie = await signIn(app, 'editor@example.com')
}

/** The hooks `inlaycms serve` gives the admin, on this test's data folder and `host`. */
function realHooks(
  host: Partial<HostApi> = {},
  over: Partial<Omit<PushOptions, 'config'>> & { config?: Partial<PushOptions['config']> } = {},
): AdminHostHooks {
  const { config, ...rest } = over
  return adminHostHooks({
    db: pushDb,
    config: {
      paths: { db: join(dataDir, 'inlay.db'), media: join(dataDir, 'media'), backups: join(dataDir, 'backups'), releases: releasesDir },
      trustedKeys: [keys.publicKey],
      secrets: (names) => Object.fromEntries(names.map((n) => [n, 'value'])),
      baseUrl: 'https://example.com',
      secret: 's'.repeat(32),
      ...config,
    },
    registry: null,
    now,
    ...rest,
    host: { requestActivation: async () => summary, ...host },
  })
}

/** A preview socket in the data folder answering the content diff, as a staged release's preview does. */
async function diffSocket(): Promise<string> {
  const socket = join(dataDir, 'diff.sock')
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(contentDiff))
  })
  await new Promise<void>((done) => server.listen(socket, done))
  closers.push(() => new Promise((done) => server.close(done)))
  return socket
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'inlay-admin-releases-data-'))
  releasesDir = join(dataDir, 'releases')
  pushDb = openDatabase(join(dataDir, 'inlay.db'))
  hooks = {
    ...realHooks(),
    requestActivation: vi.fn<AdminHostHooks['requestActivation']>(async () => summary),
    contentDiff: vi.fn<AdminHostHooks['contentDiff']>(async () => ({ content: contentDiff, warnings: [] })),
    stopPreview: vi.fn<NonNullable<AdminHostHooks['stopPreview']>>(async () => {}),
  }
})
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  await pushDb.destroy()
  await rm(dataDir, { recursive: true, force: true })
})

const textOf = (html: string) => parseHtml(html).querySelector('main')?.textContent?.replace(/\s+/g, ' ') ?? ''

describe('the Releases screen', () => {
  it('lists every release with its state, for owners only', async () => {
    await start({ releasesDir, adminHost: hooks })
    const res = await olivia.get('/admin/releases')
    expect(res.statusCode).toBe(200)
    const doc = parseHtml(res.body)
    const rows = [...doc.querySelectorAll('#releases tbody tr')].map((r) => r.textContent?.replace(/\s+/g, ' ') ?? '')
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.includes('first'))).toContain(t('admin.releases.state.current'))
    expect(rows.find((r) => r.includes('second'))).toContain(t('admin.releases.state.staged'))
    expect(doc.querySelector('nav a[href="/admin/releases"]')?.getAttribute('aria-current')).toBe('page')
    expect(doc.querySelector('dialog#upload-release form[action="/admin/releases/upload"][enctype="multipart/form-data"]')).not.toBeNull()

    expect((await eddie.get('/admin/releases')).statusCode).toBe(403)
    expect((await eddie.get(`/admin/releases/${staged.id}`)).statusCode).toBe(403)
    expect(parseHtml((await eddie.get('/admin')).body).querySelector('nav a[href="/admin/releases"]')).toBeNull()
  })

  it("shows a staged release's changes, secrets, migrations, preview and Activate", async () => {
    await start({ releasesDir, adminHost: hooks })
    const res = await olivia.get(`/admin/releases/${staged.id}`)
    expect(res.statusCode).toBe(200)
    const doc = parseHtml(res.body)
    const text = textOf(res.body)
    expect(text).toContain(t('diff.release.fieldAdded', { type: 'home', field: 'subtitle' }).replace(/`/g, ''))
    expect(text).toContain(t('diff.release.gaps', { label: 'Home', count: 1 }))
    expect(text).toContain('HOOK')
    expect(doc.querySelector('#migrations-heading + ul')?.textContent).toContain('fill-subtitles')
    expect(text).toContain(staged.signed_by)
    expect(hooks.contentDiff).toHaveBeenCalledWith(staged.id)
    const preview = doc.querySelector('a[data-release-preview]')
    expect(preview?.getAttribute('href')).toMatch(/^https:\/\/example\.com\/.*token=/)
    expect(preview?.getAttribute('target')).toBe('_blank')
    expect(doc.querySelector(`form[action="/admin/releases/${staged.id}/activate"] button`)).not.toBeNull()
    expect(doc.querySelector(`form[action="/admin/releases/${staged.id}/delete"] button`)).not.toBeNull()
  })

  it('shows the live release with its hidden content, and neither Activate nor Delete', async () => {
    await start({ releasesDir, adminHost: hooks })
    const res = await olivia.get(`/admin/releases/${live.id}`)
    expect(res.statusCode).toBe(200)
    const doc = parseHtml(res.body)
    expect(doc.querySelector('#hidden-heading')).not.toBeNull()
    expect(textOf(res.body)).toContain(t('admin.releases.hiddenNone'))
    expect(doc.querySelector('form[action$="/activate"]')).toBeNull()
    expect(doc.querySelector('form[action$="/delete"]')).toBeNull()
    expect(hooks.contentDiff).not.toHaveBeenCalled()
  })

  it('activate is owner-only and state-checked', async () => {
    await start({ releasesDir, adminHost: hooks })
    expect((await eddie.post(`/admin/releases/${staged.id}/activate`, {})).statusCode).toBe(403)

    const current = await olivia.post(`/admin/releases/${live.id}/activate`, {})
    expect(current.statusCode).toBe(409)
    expect(parseHtml(current.body).querySelector('#release-error')?.textContent).toContain(t('admin.releases.alreadyCurrent', { name: 'first' }))

    await deleteRelease({ db, releasesDir }, staged.id)
    const deleted = await olivia.post(`/admin/releases/${staged.id}/activate`, {})
    expect(deleted.statusCode).toBe(409)
    expect(parseHtml(deleted.body).querySelector('#release-error')?.textContent).toContain(t('error.releaseDeleted', { name: 'second' }))

    expect((await olivia.post('/admin/releases/no-such-release/activate', {})).statusCode).toBe(404)
    expect(hooks.requestActivation).not.toHaveBeenCalled()
  })

  it('activates a staged release through the host', async () => {
    await start({ releasesDir, adminHost: hooks })
    const res = await olivia.post(`/admin/releases/${staged.id}/activate`, {})
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe(`/admin/releases/${staged.id}?notice=releaseActivated`)
    expect(hooks.requestActivation).toHaveBeenCalledWith(staged.id)
    const page = parseHtml((await olivia.get(res.headers.location as string)).body)
    expect(page.querySelector('div[role="status"].alert-success')?.textContent).toContain(t('admin.notice.releaseActivated'))
  })

  it('shows why an activation failed', async () => {
    hooks.requestActivation.mockRejectedValueOnce(new Error('the worker exited'))
    await start({ releasesDir, adminHost: hooks })
    const res = await olivia.post(`/admin/releases/${staged.id}/activate`, {})
    expect(res.statusCode).toBe(500)
    expect(parseHtml(res.body).querySelector('#release-error')?.textContent).toContain('the worker exited')
  })

  it('deletes a staged release, stopping its preview, but not the live one', async () => {
    await start({ releasesDir, adminHost: hooks })
    expect((await eddie.post(`/admin/releases/${staged.id}/delete`, {})).statusCode).toBe(403)
    const res = await olivia.post(`/admin/releases/${staged.id}/delete`, {})
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/releases?notice=releaseDeleted')
    expect((await getRelease(db, staged.id))?.state).toBe('deleted')
    expect(existsSync(releaseDir(releasesDir, staged.id))).toBe(false)
    expect(hooks.stopPreview.mock.calls).toEqual([[staged.id]])
    const after = await olivia.get(`/admin/releases/${staged.id}`)
    expect(textOf(after.body)).toContain(t('admin.releases.deletedNote'))

    const refused = await olivia.post(`/admin/releases/${live.id}/delete`, {})
    expect(refused.statusCode).toBe(409)
    expect(parseHtml(refused.body).querySelector('#release-error')).not.toBeNull()
    expect((await getRelease(db, live.id))?.state).toBe('current')
    expect(hooks.stopPreview).toHaveBeenCalledTimes(1)
  })

  it('uploads a release file through the host, and refuses a bad one', async () => {
    await start({ releasesDir, adminHost: hooks })
    const data = await readFile(second)
    const res = await olivia.upload('/admin/releases/upload', [{ name: 'release', filename: 'second.tgz', data, type: 'application/gzip' }], {
      name: 'From the admin',
    })
    expect(res.statusCode).toBe(303)
    const stored = (await listReleases(db)).find((r) => r.name === 'From the admin')
    expect(stored?.state).toBe('staged')
    expect(stored?.pushed_by).not.toBeNull()
    expect(res.headers.location).toBe(`/admin/releases/${stored!.id}?notice=releaseUploaded`)
    expect(textOf((await olivia.get('/admin/releases')).body)).toContain('Olivia Owner')

    const bad = await olivia.upload('/admin/releases/upload', [
      { name: 'release', filename: 'bad.tgz', data: Buffer.from('not a release'), type: 'application/gzip' },
    ])
    expect(bad.statusCode).toBe(400)
    const doc = parseHtml(bad.body)
    expect(doc.querySelector('#upload-error')?.textContent).toContain(t('error.releaseInvalid'))
    expect(doc.querySelector('dialog#upload-release')?.hasAttribute('data-sheet-autoopen')).toBe(true)
    expect(await listReleases(db)).toHaveLength(3)

    const none = await olivia.upload('/admin/releases/upload', [])
    expect(none.statusCode).toBe(400)
    expect((await eddie.upload('/admin/releases/upload', [{ name: 'release', filename: 's.tgz', data, type: 'application/gzip' }])).statusCode).toBe(403)
  })

  it('without the host, explains that preview and activation need it, and still uploads', async () => {
    await start({ releasesDir, trustedKeys: [keys.publicKey] })
    const res = await olivia.get(`/admin/releases/${staged.id}`)
    expect(res.statusCode).toBe(200)
    const doc = parseHtml(res.body)
    expect(doc.querySelector('#no-host')?.textContent).toContain(t('admin.releases.noHost'))
    expect(doc.querySelector('form[action$="/activate"]')).toBeNull()
    expect(doc.querySelector('a[data-release-preview]')).toBeNull()
    expect(textOf(res.body)).toContain(t('admin.releases.contentNeedsHost'))
    expect(textOf(res.body)).toContain(t('diff.release.migration', { name: 'fill-subtitles' }).replace(/`/g, ''))
    expect((await olivia.post(`/admin/releases/${staged.id}/activate`, {})).statusCode).toBe(409)

    const upload = await olivia.upload('/admin/releases/upload', [
      { name: 'release', filename: 'first.tgz', data: await readFile(first), type: 'application/gzip' },
    ])
    expect(upload.statusCode).toBe(303)
    expect(await listReleases(db)).toHaveLength(3)
  })

  it('asks the preview for the content diff once across an upload and the page it leads to', async () => {
    const socket = await diffSocket()
    const startPreview = vi.fn(async () => socket)
    await start({ releasesDir, adminHost: realHooks({ startPreview }) })
    const res = await olivia.upload('/admin/releases/upload', [
      { name: 'release', filename: 'second.tgz', data: await readFile(second), type: 'application/gzip' },
    ])
    expect(res.statusCode).toBe(303)
    const page = await olivia.get(res.headers.location as string)
    expect(textOf(page.body)).toContain(t('diff.release.gaps', { label: 'Home', count: 1 }))
    await olivia.get(res.headers.location as string)
    expect(startPreview).toHaveBeenCalledTimes(1)
  })

  it('shows the page without the content diff, and why, when the preview is too slow', async () => {
    const socket = await diffSocket()
    const startPreview = vi.fn(() => new Promise<string>((done) => setTimeout(() => done(socket), 500)))
    await start({ releasesDir, adminHost: realHooks({ startPreview }, { activateDiffTimeoutMs: 50 }) })
    const res = await olivia.get(`/admin/releases/${staged.id}`)
    expect(res.statusCode).toBe(200)
    const note = parseHtml(res.body).querySelector('#content-unavailable')?.textContent ?? ''
    expect(note).toContain(t('admin.releases.contentUnavailable'))
    expect(note).toContain(t('error.pushDiffTimeout', { seconds: 1 }))
    expect(textOf(res.body)).not.toContain(t('diff.release.gaps', { label: 'Home', count: 1 }))
  })

  it("doesn't ask the host again to show why an activation failed", async () => {
    hooks.requestActivation.mockRejectedValueOnce(new Error('the worker exited'))
    await start({ releasesDir, adminHost: hooks })
    expect((await olivia.post(`/admin/releases/${staged.id}/activate`, {})).statusCode).toBe(500)
    expect(hooks.contentDiff).not.toHaveBeenCalled()
  })

  it('compares with nothing when the host serves no site yet, as a push does', async () => {
    await start({ releasesDir, adminHost: hooks })
    await db.updateTable('releases').set({ state: 'previous' }).where('id', '=', live.id).execute()
    const text = textOf((await olivia.get(`/admin/releases/${staged.id}`)).body)
    expect(text).toContain(t('diff.release.typeAdded', { type: 'home' }).replace(/`/g, ''))
  })

  it('refuses an upload signed by a key the host doesn\'t trust', async () => {
    await start({ releasesDir, trustedKeys: [generateKeyPair().publicKey] })
    const res = await olivia.upload('/admin/releases/upload', [
      { name: 'release', filename: 'first.tgz', data: await readFile(first), type: 'application/gzip' },
    ])
    expect(res.statusCode).toBe(400)
    expect(parseHtml(res.body).querySelector('#upload-error')?.textContent).toContain(t('error.releaseSignature'))
    expect(await listReleases(db)).toHaveLength(2)
  })

  it('says when there are no trusted keys to check an upload with', async () => {
    for (const adminHost of [undefined, realHooks({}, { config: { trustedKeys: [] } })]) {
      await start({ releasesDir, trustedKeys: [], ...(adminHost && { adminHost }) })
      const res = await olivia.upload('/admin/releases/upload', [
        { name: 'release', filename: 'first.tgz', data: await readFile(first), type: 'application/gzip' },
      ])
      expect(res.statusCode).toBe(400)
      expect(parseHtml(res.body).querySelector('#upload-error')?.textContent).toContain(t('admin.releases.noKeys'))
      for (const close of closers.splice(0)) await close()
      await rm(dataDir, { recursive: true, force: true })
      await mkdir(dataDir)
    }
  })

  it('refuses an upload through the host when a secret it needs is missing', async () => {
    await start({ releasesDir, adminHost: realHooks({}, { config: { secrets: () => ({}) } }) })
    const res = await olivia.upload('/admin/releases/upload', [
      { name: 'release', filename: 'first.tgz', data: await readFile(first), type: 'application/gzip' },
    ])
    expect(res.statusCode).toBe(400)
    expect(parseHtml(res.body).querySelector('#upload-error')?.textContent).toContain(t('error.releaseSecretsMissing', { names: 'HOOK' }))
    expect(await listReleases(db)).toHaveLength(2)
  })

  it('answers 409 to deleting a deleted release, and offers no Activate when its files are missing', async () => {
    await start({ releasesDir, adminHost: hooks })
    expect((await olivia.post(`/admin/releases/${staged.id}/delete`, {})).statusCode).toBe(303)
    const again = await olivia.post(`/admin/releases/${staged.id}/delete`, {})
    expect(again.statusCode).toBe(409)
    expect(parseHtml(again.body).querySelector('#release-error')?.textContent).toContain(t('admin.releases.alreadyDeleted', { name: 'second' }))
    expect(hooks.stopPreview).toHaveBeenCalledTimes(1)

    await rm(releaseDir(releasesDir, live.id), { recursive: true })
    await db.updateTable('releases').set({ state: 'previous' }).where('id', '=', live.id).execute()
    const doc = parseHtml((await olivia.get(`/admin/releases/${live.id}`)).body)
    expect(doc.querySelector('#files-missing')).not.toBeNull()
    expect(doc.querySelector('form[action$="/activate"]')).toBeNull()
  })

  it("names hidden slots and fields by the type's label and where they are in it", async () => {
    await start({ releasesDir, adminHost: hooks })
    const home = await db.selectFrom('documents').select('head_rev').where('type', '=', 'home').where('locale', '=', 'en').executeTakeFirstOrThrow()
    await sql`update revisions set data = json_set(data, '$.slots.hero.data.tagline', 'x', '$.slots.banner', json('{"data":{}}')) where id = ${home.head_rev}`.execute(db)
    const text = textOf((await olivia.get(`/admin/releases/${live.id}`)).body)
    expect(text).toContain(t('admin.releases.hiddenField', { label: 'Home', path: 'hero › tagline', documents: 1 }).replace(/`/g, ''))
    expect(text).toContain(t('admin.releases.hiddenSlot', { label: 'Home', slot: 'banner', documents: 1 }).replace(/`/g, ''))
  })

  it('is not there without a releases folder', async () => {
    ;({ app } = await makeApp({ withOwner: true }))
    closers.push(() => app.close())
    await app.ready()
    olivia = await signIn(app, 'owner@example.com')
    expect((await olivia.get('/admin/releases')).statusCode).toBe(404)
    expect(parseHtml((await olivia.get('/admin')).body).querySelector('nav a[href="/admin/releases"]')).toBeNull()
  })
})
