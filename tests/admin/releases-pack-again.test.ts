import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { openDatabase } from '../../src/core/db/connection.js'
import type { Database } from '../../src/core/db/schema.js'
import { t } from '../../src/core/messages/index.js'
import { inlayVersion } from '../../src/core/version.js'
import { generateKeyPair } from '../../src/core/release/keys.js'
import { packRelease } from '../../src/core/release/pack.js'
import { adminHostHooks, type AdminHostHooks } from '../../src/host/hooks.js'
import type { ActivationSummary } from '../../src/host/ipc.js'
import type { HostApi } from '../../src/adapters/site/plugin.js'
import type { ContentDiff, PushOptions } from '../../src/host/push.js'
import { storeRelease, type ReleaseRow } from '../../src/host/store.js'
import { png } from '../fixtures/media.js'
import { makeApp, type MakeAppOptions } from '../helpers/app.js'
import { parseHtml, signIn, type AdminClient } from '../helpers/admin.js'

vi.mock('../../src/core/version.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/version.js')>()),
  NEXT_OLDEST_RELEASE: '99.0.0',
}))

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

describe('the pack again notice on the Releases screen', () => {
  it('badges the releases on the list', async () => {
    await start({ releasesDir, adminHost: hooks })
    const res = await olivia.get('/admin/releases')
    expect(res.statusCode).toBe(200)
    const rows = [...parseHtml(res.body).querySelectorAll('#releases tbody tr')].map((r) => r.textContent?.replace(/\s+/g, ' ') ?? '')
    expect(rows.find((r) => r.includes('first'))).toContain(t('admin.releases.packAgainBadge'))
    expect(rows.find((r) => r.includes('second'))).toContain(t('admin.releases.packAgainBadge'))
  })

  it('leaves it off a deleted release', async () => {
    await start({ releasesDir, adminHost: hooks })
    await db.updateTable('releases').set({ state: 'deleted' }).where('id', '=', staged.id).execute()
    const res = await olivia.get('/admin/releases')
    const rows = [...parseHtml(res.body).querySelectorAll('#releases tbody tr')].map((r) => r.textContent?.replace(/\s+/g, ' ') ?? '')
    const row = rows.find((r) => r.includes('second'))
    expect(row).toBeDefined()
    expect(row).not.toContain(t('admin.releases.packAgainBadge'))
    expect(rows.find((r) => r.includes('first'))).toContain(t('admin.releases.packAgainBadge'))
  })

  it("explains it on a release's page", async () => {
    await start({ releasesDir, adminHost: hooks })
    const res = await olivia.get(`/admin/releases/${live.id}`)
    const alert = parseHtml(res.body).querySelector('#pack-again')
    expect(alert?.textContent).toContain(t('release.packAgain', { packed: inlayVersion() }))
  })
})
