import { existsSync } from 'node:fs'
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
import { readCurrentPointer, releaseDir, storeRelease, type ReleaseRow } from '../../src/host/store.js'
import { readWorkerEnv, runWorker, type WorkerEnv } from '../../src/host/worker.js'
import { png } from '../fixtures/media.js'

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
    const req = request({ socketPath: socket, path, headers: { host: 'example.com' } }, (res) => {
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

describe('a current worker', () => {
  it('serves "no site yet" without a release', async () => {
    const { res, sent, logs } = await serveOnce()
    expect(res?.status).toBe(200)
    expect(res?.headers['x-robots-tag']).toBe('noindex')
    expect(res?.body).toContain('This site has no release yet.')
    expect(sent).toEqual([{ type: 'ready', releaseId: null }])
    expect(logs).toContain('host.servingNoSite')
  })

  it('serves the current release, repairing a missing pointer from the database', async () => {
    const row = await activated()
    await rm(join(config.paths.releases, 'current.json'))
    const { res, sent, logs } = await serveOnce()
    expect(res?.status).toBe(200)
    expect(res?.body).toContain('Hello')
    expect(sent).toEqual([{ type: 'ready', releaseId: row.id }])
    expect(logs).toEqual(expect.arrayContaining(['host.pointerRepaired', 'host.serving']))
    expect((await readCurrentPointer(config.paths.releases))?.id).toBe(row.id)
  })

  it('treats a pointer with no current release in the database as no release', async () => {
    await activated()
    await withDb((db) => db.updateTable('releases').set({ state: 'previous' }).execute())
    const { res, sent } = await serveOnce()
    expect(res?.status).toBe(200)
    expect(res?.body).toContain('This site has no release yet.')
    expect(sent).toEqual([{ type: 'ready', releaseId: null }])
  })

  it('serves "temporarily unavailable" when the live release is missing', async () => {
    const row = await activated()
    await rm(releaseDir(config.paths.releases, row.id), { recursive: true })
    const { res, sent, logs } = await serveOnce()
    expect(res?.status).toBe(503)
    expect(res?.headers['retry-after']).toBe('60')
    expect(res?.headers['x-robots-tag']).toBeUndefined()
    // Still the live release: should this worker keep crashing, the primary falls back to "unavailable", not "no site yet".
    expect(sent).toEqual([{ type: 'ready', releaseId: row.id }])
    expect(logs).toEqual(expect.arrayContaining(['host.releaseMissing', 'host.servingUnavailable']))
  })

  it('serves "temporarily unavailable" when the live release needs another version of Inlay', async () => {
    const row = await activated()
    await withDb((db) => db.updateTable('releases').set({ inlay_range: '^99.0.0' }).execute())
    const { res, sent, logs } = await serveOnce()
    expect(res?.status).toBe(503)
    expect(sent).toEqual([{ type: 'ready', releaseId: row.id }])
    expect(logs).toContain('host.releaseVersion')
  })

  it('serves "temporarily unavailable" when the primary says so', async () => {
    await activated()
    const { res } = await serveOnce({ noSite: 'unavailable' })
    expect(res?.status).toBe(503)
  })
})

describe('an activation worker', () => {
  it('says activated, then ready with what it did, and serves the release', async () => {
    const row = await store()
    const { res, sent } = await serveOnce({ releaseId: row.id, activate: true })
    expect(res?.status).toBe(200)
    expect(res?.body).toContain('Hello')
    const activation = { shipped: { created: 1, replaced: 0, skipped: 0 }, migrations: [], backup: null, noop: false, warnings: 0 }
    expect(sent).toEqual([
      { type: 'activated', activation },
      { type: 'ready', releaseId: row.id, activation },
    ])
  })

  it('reports a failure without activated, and exits 1', async () => {
    const row = await store()
    await withDb((db) => db.updateTable('releases').set({ inlay_range: '^99.0.0' }).execute())
    const { res, sent, exit } = await serveOnce({ releaseId: row.id, activate: true })
    expect(res).toBeNull()
    expect(exit).toBe(1)
    expect(sent).toEqual([{ type: 'failed', error: expect.objectContaining({ messageId: 'error.releaseVersion' }) }])
    expect(existsSync(join(config.paths.releases, 'current.json'))).toBe(false)
  })
})

describe('a preview worker', () => {
  it('serves the staged release on a copy of the database, says preview-ready, and removes the copy when shut down', async () => {
    await activated()
    const staged = await store()
    const { res, sent, logs, exit } = await serveOnce({ preview: staged.id })
    expect(sent).toEqual([{ type: 'preview-ready', releaseId: staged.id, socket }])
    expect(res?.status).toBe(200)
    expect(res?.body).toContain('Hello')
    expect(res?.body).toContain(`Previewing release ${staged.name}`)
    expect(res?.headers['cache-control']).toBe('no-store')
    expect(exit).toBe(0)
    expect(logs).toEqual([])
    expect(existsSync(join(dataDir, 'run', `preview-${staged.id}`))).toBe(false)
  })

  it('reports a release it cannot preview as failed, and exits 1', async () => {
    const row = await activated()
    const { res, sent, logs, exit } = await serveOnce({ preview: row.id })
    expect(res).toBeNull()
    expect(exit).toBe(1)
    expect(sent).toEqual([{ type: 'failed', error: expect.objectContaining({ messageId: 'error.previewNotStaged' }) }])
    expect(logs).toEqual(['host.previewFailed'])
  })
})

describe('readWorkerEnv', () => {
  it('reads the release, the page and where to listen', () => {
    expect(readWorkerEnv({})).toEqual({ releaseId: null, activate: false })
    expect(
      readWorkerEnv({ INLAY_WORKER_RELEASE: 'r', INLAY_WORKER_ACTIVATE: '1', INLAY_WORKER_NO_SITE: 'unavailable', INLAY_WORKER_LISTEN: 'port:4000' }),
    ).toEqual({ releaseId: 'r', activate: true, noSite: 'unavailable', listen: { port: 4000 } })
    expect(readWorkerEnv({ INLAY_WORKER_LISTEN: 'socket:/tmp/a.sock' }).listen).toEqual({ path: '/tmp/a.sock' })
    expect(() => readWorkerEnv({ INLAY_WORKER_LISTEN: 'nowhere' })).toThrow(/INLAY_WORKER_LISTEN/)
    expect(readWorkerEnv({ INLAY_WORKER_PREVIEW: 'rel-2', INLAY_WORKER_LISTEN: 'socket:/tmp/p.sock' })).toEqual({
      releaseId: null,
      activate: false,
      listen: { path: '/tmp/p.sock' },
      preview: 'rel-2',
    })
    expect(readWorkerEnv({ INLAY_WORKER_PREVIEW: '' }).preview).toBeUndefined()
    expect(readWorkerEnv({ INLAY_WORKER_PREVIEW: 'rel-2', INLAY_WORKER_PREVIEW_DIR: '/d/releases/.push-x' }).previewDir).toBe('/d/releases/.push-x')
    expect(readWorkerEnv({ INLAY_WORKER_PREVIEW_DIR: '/d/releases/.push-x' }).previewDir).toBeUndefined()
  })
})
