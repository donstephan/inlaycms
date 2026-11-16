import { spawn, type ChildProcess } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runCli } from '../../src/adapters/cli/main.js'
import { openDatabase } from '../../src/core/db/connection.js'
import { migrateSystem } from '../../src/core/db/migrate.js'
import { generateKeyPair } from '../../src/core/release/keys.js'
import { packRelease } from '../../src/core/release/pack.js'
import { loadRelease } from '../../src/core/release/read.js'
import { activateRelease } from '../../src/host/activate.js'
import { ensureDataDir, readHostConfig } from '../../src/host/config.js'
import { releaseDir, storeRelease } from '../../src/host/store.js'
import { png } from '../fixtures/media.js'

const root = resolve(import.meta.dirname, '../..')
const fixtures = resolve(import.meta.dirname, '../fixtures')

/** The fixture release with a home page to render and a POST route. */
const siteTs = `import { defineRoute, defineSingleton, defineSite, defineTemplate, f, z } from 'inlaycms/site'
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
  routes: [defineRoute({ method: 'POST', path: '/echo', handler: (req) => ({ json: { got: req.body } }) })],
  content,
})
`

let packDir: string
let file: string
let keys: { privateKey: string; publicKey: string }

beforeAll(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'inlay-serve-pack-'))
  const siteDir = join(packDir, 'site')
  await cp(join(fixtures, 'release'), siteDir, { recursive: true })
  await mkdir(join(siteDir, 'assets'))
  await writeFile(join(siteDir, 'assets/pic.png'), await png(20, 10))
  await writeFile(join(siteDir, 'site.ts'), siteTs)
  keys = generateKeyPair()
  file = join(packDir, 'site.tgz')
  await packRelease({ configFile: join(siteDir, 'inlay.config.ts'), privateKey: keys.privateKey, out: file, name: 'serve-1' })
}, 30_000)
afterAll(() => rm(packDir, { recursive: true, force: true }))

let dataDir: string
let env: Record<string, string>
let child: ChildProcess | undefined
let output: string

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  await new Promise((done) => server.close(done))
  return port
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'inlay-serve-'))
  const port = await freePort()
  env = {
    INLAY_DATA_DIR: dataDir,
    INLAY_PORT: String(port),
    INLAY_HOST: '127.0.0.1',
    INLAY_BASE_URL: `http://127.0.0.1:${port}`,
    INLAY_SECRET: 's'.repeat(32),
    INLAY_TRUSTED_KEYS: keys.publicKey,
    INLAY_RATE_LIMIT: 'off',
    HOOK: 'hook-value',
  }
  child = undefined
  output = ''
})
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const gone = new Promise((done) => child!.once('exit', done))
    child.kill('SIGKILL')
    await gone
  }
  await rm(dataDir, { recursive: true, force: true })
})

const url = (path: string) => `${env.INLAY_BASE_URL}${path}`

function startServe(): ChildProcess {
  child = spawn(process.execPath, ['--import', 'tsx', 'src/adapters/cli/bin.ts', 'serve'], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
  return child
}

async function answering(): Promise<void> {
  const deadline = Date.now() + 25_000
  for (;;) {
    if (child?.exitCode !== null) throw new Error(`inlaycms serve exited early:\n${output}`)
    try {
      await fetch(url('/'))
      return
    } catch {
      if (Date.now() > deadline) throw new Error(`inlaycms serve never answered:\n${output}`)
      await new Promise((done) => setTimeout(done, 100))
    }
  }
}

function exited(proc: ChildProcess): Promise<number | null> {
  if (proc.exitCode !== null) return Promise.resolve(proc.exitCode)
  return new Promise((done) => proc.once('exit', (code) => done(code)))
}

/** Stores the packed release and activates it in-process, the way the offline `inlaycms activate` will. */
async function activateOffline(): Promise<void> {
  const config = readHostConfig(env)
  await ensureDataDir(config)
  const db = openDatabase(config.paths.db)
  try {
    await migrateSystem(db)
    const now = () => new Date()
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
  } finally {
    await db.destroy()
  }
}

describe('inlaycms serve', () => {
  it('serves "no site yet" and the admin setup without a release', async () => {
    startServe()
    await answering()
    const home = await fetch(url('/'))
    expect(home.status).toBe(200)
    expect(home.headers.get('x-robots-tag')).toBe('noindex')
    expect(await home.text()).toContain('This site has no release yet.')
    const admin = await fetch(url('/admin'), { redirect: 'manual' })
    expect(admin.status).toBe(302)
    expect(admin.headers.get('location')).toBe('/admin/setup')
    expect((await fetch(url('/admin/setup'))).status).toBe(200)
  }, 30_000)

  it('serves the activated release after a restart', async () => {
    await activateOffline()
    startServe()
    await answering()
    const home = await fetch(url('/'))
    expect(home.status).toBe(200)
    expect(await home.text()).toContain('Hello')
    const css = await fetch(url('/public/site.css'))
    expect(css.status).toBe(200)
    expect(await css.text()).toContain('color: #333')
    const echo = await fetch(url('/echo'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=Ana',
    })
    expect(echo.status).toBe(200)
    expect(await echo.json()).toEqual({ got: { name: 'Ana' } })
    const admin = await fetch(url('/admin'), { redirect: 'manual' })
    expect(admin.status).toBe(302)
  }, 30_000)

  it('exits 2 and says what is missing without its settings', async () => {
    delete env.INLAY_SECRET
    const proc = startServe()
    expect(await exited(proc)).toBe(2)
    expect(output).toContain('INLAY_SECRET')
  }, 30_000)

  it('takes no arguments', async () => {
    const err: string[] = []
    const code = await runCli(['serve', '--port', '1'], { cwd: root, out: () => {}, err: (line) => err.push(line) })
    expect(code).toBe(2)
    expect(err.join('\n')).toContain('Usage: inlaycms')
  })

  it('exits cleanly on SIGTERM', async () => {
    const proc = startServe()
    await answering()
    proc.kill('SIGTERM')
    expect(await exited(proc)).toBe(0)
    await expect(fetch(url('/'))).rejects.toThrow()
  }, 30_000)
})
