import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDatabase } from '../../src/core/db/connection.js'
import { migrateSystem } from '../../src/core/db/migrate.js'
import type { MessageId } from '../../src/core/messages/index.js'
import { generateKeyPair } from '../../src/core/release/keys.js'
import { packRelease } from '../../src/core/release/pack.js'
import { loadRelease } from '../../src/core/release/read.js'
import { activateRelease } from '../../src/host/activate.js'
import { ensureDataDir, readHostConfig, type HostConfig } from '../../src/host/config.js'
import type { PrimaryMessage, WorkerMessage } from '../../src/host/ipc.js'
import { releaseDir, storeRelease, type ReleaseRow } from '../../src/host/store.js'
import { runWorker, type WorkerEnv } from '../../src/host/worker.js'
import { png } from '../fixtures/media.js'

vi.mock('../../src/core/version.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/version.js')>()),
  inlayVersion: () => '0.6.0',
}))

const fixtures = resolve(import.meta.dirname, '../fixtures')

const siteTs = `import { defineSingleton, defineSite, defineTemplate, f, z } from 'inlaycms/site'
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
  content,
})
`

let packDir: string
let file: string
let keys: { privateKey: string; publicKey: string }

beforeAll(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'inlay-worker-pack-'))
  const siteDir = join(packDir, 'site')
  await cp(join(fixtures, 'release'), siteDir, { recursive: true })
  await mkdir(join(siteDir, 'assets'))
  await writeFile(join(siteDir, 'assets/pic.png'), await png(20, 10))
  await writeFile(join(siteDir, 'site.ts'), siteTs)
  keys = generateKeyPair()
  file = join(packDir, 'site.tgz')
  await packRelease({ configFile: join(siteDir, 'inlay.config.ts'), privateKey: keys.privateKey, out: file, name: 'worker-1' })
})
afterAll(() => rm(packDir, { recursive: true, force: true }))

let dataDir: string
let socket: string
let config: HostConfig

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'inlay-worker-'))
  socket = join(dataDir, 'w.sock')
  config = readHostConfig({
    INLAY_DATA_DIR: dataDir,
    INLAY_BASE_URL: 'https://example.com',
    INLAY_SECRET: 's'.repeat(32),
    INLAY_RATE_LIMIT: 'off',
    HOOK: 'hook-value',
  })
  await ensureDataDir(config)
})
afterEach(() => rm(dataDir, { recursive: true, force: true }))

async function withDb<T>(fn: (db: ReturnType<typeof openDatabase>) => Promise<T>): Promise<T> {
  const db = openDatabase(config.paths.db)
  try {
    await migrateSystem(db)
    return await fn(db)
  } finally {
    await db.destroy()
  }
}

const store = () =>
  withDb((db) =>
    storeRelease({ db, releasesDir: config.paths.releases, trustedKeys: [keys.publicKey], now: () => new Date() }, file, {
      pushedBy: null,
    }),
  )

async function activated(): Promise<ReleaseRow> {
  const row = await store()
  const loaded = await loadRelease(releaseDir(config.paths.releases, row.id))
  await withDb((db) =>
    activateRelease(
      {
        db,
        loaded,
        releasesDir: config.paths.releases,
        backupsDir: config.paths.backups,
        mediaDir: config.paths.media,
        secretsEnv: config.secrets,
        now: () => new Date(),
      },
      row.id,
    ),
  )
  return row
}

function get(path: string): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((done, fail) => {
    const req = request({ socketPath: socket, path, agent: false, headers: { host: 'example.com' } }, (res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => (body += chunk.toString()))
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', fail)
    req.end()
  })
}

/** Runs a worker on a Unix socket, fetches `/` and shuts it down. */
async function serveOnce(env: Partial<WorkerEnv> = {}) {
  const sent: WorkerMessage[] = []
  const logs: MessageId[] = []
  const exits: number[] = []
  let deliver: (m: PrimaryMessage) => void = () => {}
  await runWorker(
    config,
    { releaseId: null, activate: false, listen: { path: socket }, ...env },
    {
      send: (m) => sent.push(m),
      onMessage: (fn) => (deliver = fn),
      exit: (code) => exits.push(code),
      log: (id) => logs.push(id),
      logger: false,
    },
  )
  const res = exits.length === 0 ? await get('/') : null
  deliver({ type: 'shutdown' })
  await vi.waitFor(() => expect(exits).toHaveLength(1))
  return { res, sent, logs, exit: exits[0] }
}

describe('an upgrade', () => {
  it('keeps serving a live release packed with the previous minor after an upgrade', async () => {
    await activated()
    await withDb((db) => db.updateTable('releases').set({ inlay_range: '^0.5.0' }).execute())
    const { res, logs } = await serveOnce()
    expect(res?.status).toBe(200)
    expect(res?.body).toContain('Hello')
    expect(logs).not.toContain('host.releaseTooOld')
    expect(logs).not.toContain('host.releaseTooNew')
  })
})
