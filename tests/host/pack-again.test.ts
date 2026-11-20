import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runCli } from '../../src/adapters/cli/main.js'
import { openDatabase } from '../../src/core/db/connection.js'
import { migrateSystem } from '../../src/core/db/migrate.js'
import { t, type MessageId } from '../../src/core/messages/index.js'
import { generateKeyPair } from '../../src/core/release/keys.js'
import { packRelease } from '../../src/core/release/pack.js'
import { loadRelease } from '../../src/core/release/read.js'
import { inlayVersion } from '../../src/core/version.js'
import { activateRelease } from '../../src/host/activate.js'
import { ensureDataDir, readHostConfig, type HostConfig } from '../../src/host/config.js'
import type { PrimaryMessage, WorkerMessage } from '../../src/host/ipc.js'
import { pushRelease, releaseInfo } from '../../src/host/push.js'
import { releaseDir, storeRelease, type ReleaseRow } from '../../src/host/store.js'
import { runWorker, type WorkerEnv } from '../../src/host/worker.js'
import { png } from '../fixtures/media.js'

vi.mock('../../src/core/version.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/version.js')>()),
  NEXT_OLDEST_RELEASE: '99.0.0',
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

async function cli(...argv: string[]) {
  const out: string[] = []
  const code = await runCli(argv, { cwd: dataDir, out: (l) => out.push(l), err: () => {} })
  return { code, out }
}

describe('the pack again warning', () => {
  const packed = inlayVersion()

  it('logs it for the live release when the worker starts', async () => {
    await activated()
    const { res, logs } = await serveOnce()
    expect(res?.status).toBe(200)
    expect(logs).toContain('host.releasePackAgain')
  })

  it("adds it to a push's warnings, dry run too", async () => {
    const db = openDatabase(':memory:')
    try {
      await migrateSystem(db)
      const opts = { db, config: { ...config, trustedKeys: [keys.publicKey] }, registry: null, now: () => new Date() }
      for (const dryRun of [true, false]) {
        const result = await pushRelease(opts, file, { dryRun, pushedBy: null })
        expect(result.warnings).toContain(t('push.packAgain', { packed }))
      }
    } finally {
      await db.destroy()
    }
  })

  it('puts it on the rows the push API lists', async () => {
    const row = await store()
    expect(releaseInfo(row).warning).toBe(t('release.packAgain', { packed }))
  })

  it('prints it under the row in inlaycms releases, and in --json', async () => {
    const row = await store()
    const text = await cli('releases', '--data', dataDir)
    expect(text.code).toBe(0)
    const at = text.out.findIndex((l) => l.includes(row.id))
    expect(text.out[at + 1]).toBe(t('cli.releaseWarning', { warning: t('release.packAgain', { packed }) }))
    const json = await cli('releases', '--data', dataDir, '--json')
    expect(JSON.parse(json.out.join('\n'))).toEqual([expect.objectContaining({ id: row.id, warning: t('release.packAgain', { packed }) })])
  })

  it('leaves it off a deleted release', async () => {
    const row = await store()
    expect(releaseInfo({ ...row, state: 'deleted' })).not.toHaveProperty('warning')
  })

  it('prints no warning for a remote row the host sent without one', async () => {
    const row = { id: 'r1', name: 'old', state: 'current', pushed_at: 'then', activated_at: 'later', inlay_range: '0.5.0' }
    const server = createServer((_req, res) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ releases: [row], current: 'r1' })),
    )
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    try {
      const { port } = server.address() as AddressInfo
      const out: string[] = []
      const code = await runCli(['releases', `http://127.0.0.1:${port}`, '--token', 'any'], {
        cwd: dataDir,
        out: (l) => out.push(l),
        err: () => {},
      })
      expect(code).toBe(0)
      expect(out.join('\n')).toContain('r1')
      expect(out).toHaveLength(1)
    } finally {
      await new Promise((done) => server.close(done))
    }
  })
})
