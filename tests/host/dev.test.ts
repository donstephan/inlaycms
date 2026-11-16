import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { t } from '../../src/core/messages/index.js'
import { png } from '../fixtures/media.js'

const root = resolve(import.meta.dirname, '../..')
const fixtures = resolve(import.meta.dirname, '../fixtures')

/** The fixture site with a home page to render, in its own folder outside the repository. */
const siteTs = (greeting: string) => `import { defineRoute, defineSingleton, defineSite, defineTemplate, f, z } from 'inlaycms/site'
import { content } from './content.js'

const Home = defineTemplate({
  name: 'home',
  fields: z.object({ title: f.text({ label: 'Title' }), picture: f.image({ label: 'Picture' }) }),
  render: ({ fields }) => \`\${fields.title}${greeting}\`,
})

export const site = defineSite({
  locales: ['en'],
  defaultLocale: 'en',
  singletons: [defineSingleton({ name: 'home', label: 'Home', template: Home, path: '/' })],
  secrets: ['HOOK'],
  routes: [defineRoute({ method: 'GET', path: '/ping', handler: () => ({ json: { ok: true } }) })],
  content,
})
`

let siteDir: string
let port: number
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
  siteDir = await mkdtemp(join(tmpdir(), 'inlay-dev-'))
  await cp(join(fixtures, 'release'), siteDir, { recursive: true })
  await mkdir(join(siteDir, 'assets'))
  await writeFile(join(siteDir, 'assets/pic.png'), await png(20, 10))
  await writeFile(join(siteDir, 'site.ts'), siteTs(''))
  await writeFile(join(siteDir, 'package.json'), '{ "type": "module" }\n')
  port = await freePort()
  child = undefined
  output = ''
})
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const gone = new Promise((done) => child!.once('exit', done))
    child.kill('SIGKILL')
    await gone
  }
  await rm(siteDir, { recursive: true, force: true })
})

const url = (path: string) => `http://localhost:${port}${path}`

function startDev(): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, INLAY_RATE_LIMIT: 'off', HOOK: 'hook-value' }
  for (const name of ['INLAY_DATA_DIR', 'INLAY_BASE_URL', 'INLAY_SECRET', 'INLAY_PORT', 'INLAY_HOST', 'INLAY_DEV_CONFIG']) {
    delete env[name]
  }
  child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/adapters/cli/bin.ts', 'dev', '--config', join(siteDir, 'inlay.config.ts'), '--port', String(port)],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
  return child
}

/** Polls `/` until its body passes `ok`. */
async function home(ok: (body: string) => boolean): Promise<string> {
  const deadline = Date.now() + 25_000
  let last = ''
  for (;;) {
    if (child?.exitCode !== null) throw new Error(`inlaycms dev exited early:\n${output}`)
    try {
      const res = await fetch(url('/'))
      last = await res.text()
      if (res.status === 200 && ok(last)) return last
    } catch {
      // Not listening yet, or restarting.
    }
    if (Date.now() > deadline) throw new Error(`inlaycms dev never served the page (last: ${last}):\n${output}`)
    await new Promise((done) => setTimeout(done, 100))
  }
}

function exited(proc: ChildProcess): Promise<number | null> {
  if (proc.exitCode !== null) return Promise.resolve(proc.exitCode)
  return new Promise((done) => proc.once('exit', (code) => done(code)))
}

describe('inlaycms dev', () => {
  it('serves the site from source with its shipped content applied', async () => {
    startDev()
    expect(await home((body) => body.includes('Hello'))).toContain('Hello')
    expect(output).toContain(t('host.devListening', { url: `http://localhost:${port}` }))
    const css = await fetch(url('/public/site.css'))
    expect(css.status).toBe(200)
    expect(await css.text()).toContain('color: #333')
    expect(await (await fetch(url('/ping'))).json()).toEqual({ ok: true })
    const admin = await fetch(url('/admin'), { redirect: 'manual' })
    expect(admin.status).toBe(302)
    expect(existsSync(join(siteDir, 'data/inlay.db'))).toBe(true)
  }, 30_000)

  it('restarts when the site code changes', async () => {
    startDev()
    await home((body) => body.includes('Hello'))
    await writeFile(join(siteDir, 'site.ts'), siteTs(', again'))
    expect(await home((body) => body.includes('Hello, again'))).toContain('Hello, again')
    expect(output.split(t('host.devRestart', { file: 'site.ts' })).length - 1).toBe(1)
  }, 30_000)

  it('exits cleanly on SIGTERM', async () => {
    const proc = startDev()
    await home((body) => body.includes('Hello'))
    proc.kill('SIGTERM')
    expect(await exited(proc)).toBe(0)
    await expect(fetch(url('/'))).rejects.toThrow()
  }, 30_000)
})
