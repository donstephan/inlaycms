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

/** The fixture release, its home page saying which release renders it. */
const siteTs = (which: string) => `import { defineSingleton, defineSite, defineTemplate, f, z } from 'inlaycms/site'
import { content } from './content.js'

const Home = defineTemplate({
  name: 'home',
  fields: z.object({ title: f.text({ label: 'Title' }), picture: f.image({ label: 'Picture' }) }),
  render: ({ fields }) => '${which}: ' + fields.title,
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
let keys: { privateKey: string; publicKey: string }
let first: string
let second: string
let third: string

async function packSite(name: string): Promise<string> {
  const siteDir = join(packDir, name)
  await cp(join(fixtures, 'release'), siteDir, { recursive: true })
  await mkdir(join(siteDir, 'assets'))
  await writeFile(join(siteDir, 'assets/pic.png'), await png(20, 10))
  await writeFile(join(siteDir, 'site.ts'), siteTs(name))
  const out = join(packDir, `${name}.tgz`)
  await packRelease({ configFile: join(siteDir, 'inlay.config.ts'), privateKey: keys.privateKey, out, name })
  return out
}

beforeAll(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'inlay-swap-pack-'))
  keys = generateKeyPair()
  first = await packSite('swap-1')
  second = await packSite('swap-2')
  third = await packSite('swap-3')
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
  dataDir = await mkdtemp(join(tmpdir(), 'inlay-swap-'))
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
  vi.unstubAllEnvs()
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
  const deadline = Date.now() + 20_000
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

/** Stores the first release and activates it in-process, as `inlaycms activate` does offline. */
async function activateOffline(file: string): Promise<void> {
  const config = readHostConfig(env)
  await ensureDataDir(config)
  const db = openDatabase(config.paths.db)
  try {
    await migrateSystem(db)
    const now = () => new Date()
    const row = await storeRelease({ db, releasesDir: config.paths.releases, trustedKeys: [keys.publicKey], now }, file, {
      pushedBy: null,
    })
    await activateRelease(
      {
        db,
        loaded: await loadRelease(releaseDir(config.paths.releases, row.id)),
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

async function run(...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli(argv, { cwd: root, out: (l) => out.push(l), err: (l) => err.push(l), readSecret: async () => 'a-long-password' })
  return { code, out, err: err.join('\n') }
}

describe('inlaycms push --activate on a running server', () => {
  it('swaps releases without refusing a request', async () => {
    await activateOffline(first)
    // A push key minted offline, before the server starts.
    vi.stubEnv('INLAY_DATA_DIR', '')
    expect((await run('create-owner', '--data', dataDir, '--email', 'olivia@example.com', '--name', 'Olivia')).code).toBe(0)
    const token = await run('create-token', '--data', dataDir, '--email', 'olivia@example.com', '--name', 'ci', '--push')
    expect(token.code).toBe(0)
    const key = token.out[0]!

    const proc = startServe()
    await answering()
    expect(await (await fetch(url('/'))).text()).toContain('swap-1: Hello')

    const failures: string[] = []
    const seen = new Set<string>()
    let requests = 0
    let running = true
    const loop = (async () => {
      while (running) {
        requests++
        try {
          const res = await fetch(url('/'), { signal: AbortSignal.timeout(10_000) })
          const body = await res.text()
          if (res.status !== 200) failures.push(`status ${res.status}: ${body.slice(0, 200)}`)
          else seen.add(body.includes('swap-2') ? 'swap-2' : body.includes('swap-1') ? 'swap-1' : body.slice(0, 80))
        } catch (e) {
          failures.push(`refused: ${e instanceof Error ? `${e.message} ${String(e.cause ?? '')}` : String(e)}`)
        }
        await new Promise((done) => setTimeout(done, 50))
      }
    })()

    let pushed: Awaited<ReturnType<typeof run>>
    try {
      pushed = await run('push', env.INLAY_BASE_URL!, '--file', second, '--activate', '--token', key)
      // A few more requests after the swap, all on the new release.
      const after = requests
      while (requests < after + 5) await new Promise((done) => setTimeout(done, 50))
    } finally {
      running = false
      await loop
    }
    expect(pushed.err, output).toBe('')
    expect(pushed.code).toBe(0)
    expect(pushed.out).toContain('Release swap-2 is now live.')
    // The content half of the diff arrived from the release's preview worker.
    expect(pushed.out.join('\n'), output).not.toContain("couldn't be worked out")
    expect(failures, output).toEqual([])
    expect(seen).toEqual(new Set(['swap-1', 'swap-2']))
    // The old worker drains: a connection opened before the swap may answer once more from swap-1, then closes. Once
    // a burst has used every idle connection, all answers come from swap-2.
    await vi.waitFor(
      async () => {
        const bodies = await Promise.all(Array.from({ length: 10 }, async () => (await fetch(url('/'))).text()))
        expect(bodies.every((body) => body.includes('swap-2: Hello'))).toBe(true)
      },
      { timeout: 10_000, interval: 100 },
    )

    // A release pushed without --activate: the printed link previews it through its own worker, cookie and all.
    const staged = await run('push', env.INLAY_BASE_URL!, '--file', third, '--token', key)
    expect(staged.err, output).toBe('')
    expect(staged.code).toBe(0)
    expect(staged.out.join('\n'), output).not.toContain("couldn't be worked out")
    const link = /Preview it \(the link works for 24 hours\): (\S+)/.exec(staged.out.join('\n'))?.[1]
    expect(link, staged.out.join('\n')).toBeDefined()
    const turnedOn = await fetch(link!, { redirect: 'manual' })
    expect(turnedOn.status).toBe(302)
    const cookie = turnedOn.headers.getSetCookie()[0]!.split(';')[0]!
    const previewed = await fetch(url('/'), { headers: { cookie } })
    expect(previewed.status, output).toBe(200)
    expect(previewed.headers.get('cache-control')).toBe('no-store')
    const page = await previewed.text()
    expect(page).toContain('swap-3: Hello')
    expect(page).toContain('Previewing release swap-3')
    // Without the cookie, the live release still answers.
    expect(await (await fetch(url('/'))).text()).toContain('swap-2: Hello')

    proc.kill('SIGTERM')
    expect(await exited(proc)).toBe(0)
    const listed = await run('releases', '--data', dataDir, '--json')
    expect(listed.code).toBe(0)
    const rows = JSON.parse(listed.out.join('\n')) as Array<{ name: string; state: string }>
    expect(Object.fromEntries(rows.map((r) => [r.name, r.state]))).toEqual({ 'swap-1': 'previous', 'swap-2': 'current', 'swap-3': 'staged' })
  }, 60_000)
})
