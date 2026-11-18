import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import * as tar from 'tar'
import { AUTH, type HostApi } from '../../src/adapters/site/plugin.js'
import { PREVIEW_PATH } from '../../src/adapters/site/preview.js'
import { verifyPreviewToken } from '../../src/core/preview.js'
import { openDatabase } from '../../src/core/db/connection.js'
import { migrateSystem } from '../../src/core/db/migrate.js'
import { InlayError } from '../../src/core/errors.js'
import { t } from '../../src/core/messages/index.js'
import { generateKeyPair, sign } from '../../src/core/release/keys.js'
import type { ReleaseManifest } from '../../src/core/release/manifest.js'
import { packRelease } from '../../src/core/release/pack.js'
import { loadRelease, type LoadedRelease } from '../../src/core/release/read.js'
import { activateRelease } from '../../src/host/activate.js'
import { createSiteApp } from '../../src/host/app.js'
import { ensureDataDir, readHostConfig, type HostConfig } from '../../src/host/config.js'
import type { ActivationSummary } from '../../src/host/ipc.js'
import { startPreviewApp, type PreviewApp } from '../../src/host/preview-worker.js'
import { pendingMigrations, pushRelease, type ReleaseDiff } from '../../src/host/push.js'
import { listReleases, releaseDir, storeRelease, type ReleaseRow } from '../../src/host/store.js'
import { png } from '../fixtures/media.js'

const fixtures = resolve(import.meta.dirname, '../fixtures')

/** The fixture release's site with a render function on its home template, as a host can only serve that. */
const siteTs = (fields: string) => `import { defineRoute, defineSingleton, defineSite, defineTemplate, f, z } from 'inlaycms/site'
import { content } from './content.js'

const Home = defineTemplate({
  name: 'home',
  fields: z.object({ ${fields} }),
  render: ({ fields }) => fields.title,
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

const summary: ActivationSummary = {
  shipped: { created: 1, replaced: 0, skipped: 0 },
  migrations: [],
  backup: null,
  noop: false,
  warnings: 0,
}

/** Unpacks `file` into a copy at `out`, lets `change` edit the files, and packs them back up. */
async function repack(file: string, out: string, change: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'inlay-push-repack-'))
  try {
    await tar.x({ file, cwd: dir })
    await change(dir)
    await tar.c({ gzip: true, cwd: dir, portable: true, file: out }, await readdir(dir))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** A copy of `file` whose manifest `change` edits, signed again with `privateKey`. */
async function remanifest(file: string, out: string, privateKey: string, change: (m: ReleaseManifest) => void): Promise<void> {
  await repack(file, out, async (d) => {
    const manifest = JSON.parse(await readFile(join(d, 'manifest.json'), 'utf8')) as ReleaseManifest
    change(manifest)
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2))
    await writeFile(join(d, 'manifest.json'), bytes)
    await writeFile(join(d, 'manifest.sig'), sign(privateKey, bytes))
  })
}

let packDir: string
let file: string
let changed: string
let required: string
let bumped: string
let untrusted: string
let tooNew: string
let needsSecret: string
let keys: { privateKey: string; publicKey: string }

/** The fixture's shipped home page at edition 2, with a new title. */
const bumpedContent = `import { defineContent } from 'inlaycms/site'

export const content = [
  defineContent('home', {
    edition: 2,
    content: { en: { fields: { title: 'Bumped', picture: { file: new URL('./assets/pic.png', import.meta.url), alt: 'A picture' } } } },
  }),
]
`

/** Packs the fixture site with `fields` on its home template (and `contentTs` as its shipped content) into `<packDir>/<name>.tgz`. */
async function packSite(name: string, fields: string, contentTs?: string): Promise<string> {
  // A folder per site: a config already imported from a path is not imported again.
  const siteDir = join(packDir, name)
  await cp(join(fixtures, 'release'), siteDir, { recursive: true })
  await mkdir(join(siteDir, 'assets'))
  await writeFile(join(siteDir, 'assets/pic.png'), await png(20, 10))
  await writeFile(join(siteDir, 'site.ts'), siteTs(fields))
  if (contentTs !== undefined) await writeFile(join(siteDir, 'content.ts'), contentTs)
  const out = join(packDir, `${name}.tgz`)
  await packRelease({ configFile: join(siteDir, 'inlay.config.ts'), privateKey: keys.privateKey, out, name })
  return out
}

beforeAll(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'inlay-push-pack-'))
  keys = generateKeyPair()
  const title = "title: f.text({ label: 'Title' }), picture: f.image({ label: 'Picture' })"
  file = await packSite('test-1', title)
  changed = await packSite('test-2', `${title}, subtitle: f.text({ label: 'Subtitle' }).optional()`)
  required = await packSite('test-3', `${title}, summary: f.text({ label: 'Summary' })`)
  bumped = await packSite('test-4', title, bumpedContent)
  untrusted = join(packDir, 'untrusted.tgz')
  await remanifest(file, untrusted, generateKeyPair().privateKey, () => {})
  tooNew = join(packDir, 'too-new.tgz')
  await remanifest(file, tooNew, keys.privateKey, (m) => {
    m.inlay.range = '^99.0.0'
  })
  needsSecret = join(packDir, 'needs-secret.tgz')
  await remanifest(file, needsSecret, keys.privateKey, (m) => {
    m.secrets = ['HOOK', 'MAIL_TOKEN']
  })
})
afterAll(() => rm(packDir, { recursive: true, force: true }))

let dataDir: string
let config: HostConfig
let app: FastifyInstance | undefined
let host: { requestActivation: ReturnType<typeof vi.fn<HostApi['requestActivation']>> }
let tokens: { push: string; owner: string; editor: string }
let clock: number
const now = () => new Date(Date.UTC(2026, 10, 5, 12, 0, clock++))

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'inlay-push-'))
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
  host = { requestActivation: vi.fn<HostApi['requestActivation']>(async () => summary) }
})
afterEach(async () => {
  await app?.close()
  await rm(dataDir, { recursive: true, force: true })
})

/** Stores and activates the fixture release, as `inlaycms activate` would; returns it loaded, with its id. */
async function activated(): Promise<{ loaded: LoadedRelease; id: string }> {
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
    return { loaded, id: row.id }
  } finally {
    await db.destroy()
  }
}

/** The app under the host with an owner (a push key and a plain key) and an editor (a key). */
async function start(loaded: LoadedRelease | null, hooks: HostApi = host, pushMaxBytes?: number): Promise<FastifyInstance> {
  const made = await createSiteApp(config, loaded, { content: 'none', now, host: hooks, ...(pushMaxBytes !== undefined && { pushMaxBytes }) })
  app = made.app
  const service = app.inlay[AUTH]
  const password = 'correct horse battery'
  const owner = await service.createUser({ email: 'owner@example.com', name: 'Olivia Owner', password, role: 'owner' })
  const editor = await service.createUser({ email: 'editor@example.com', name: 'Eddie Editor', password, role: 'editor' })
  tokens = {
    push: await service.createApiKey(owner.id!, 'push', { permissions: { release: ['push'] } }),
    owner: await service.createApiKey(owner.id!, 'plain'),
    editor: await service.createApiKey(editor.id!, 'editor'),
  }
  return app
}

async function push(body: Buffer | string, opts: { query?: string; token?: string | null; type?: string } = {}) {
  const token = opts.token === undefined ? tokens.push : opts.token
  return app!.inject({
    method: 'POST',
    url: `/_inlay/releases${opts.query ?? ''}`,
    headers: {
      'content-type': opts.type ?? 'application/gzip',
      ...(token !== null && { authorization: `Bearer ${token}` }),
    },
    payload: typeof body === 'string' ? await readFile(body) : body,
  })
}

const auth = () => ({ authorization: `Bearer ${tokens.push}` })

async function rows(): Promise<ReleaseRow[]> {
  const db = openDatabase(config.paths.db)
  try {
    return await listReleases(db)
  } finally {
    await db.destroy()
  }
}

describe('POST /_inlay/releases', () => {
  it('stores a pushed release as staged and answers with its diff', async () => {
    await start(null)
    const res = await push(file, { query: '?name=first' })
    expect(res.statusCode).toBe(201)
    const body = res.json<{ release: ReleaseRow; diff: ReleaseDiff; activation: ActivationSummary | null }>()
    expect(body.release).toMatchObject({ name: 'first', state: 'staged', pushed_by: expect.any(String) })
    expect(body.diff.structural.types.added).toEqual(['home'])
    expect(body.diff.structural.types.removed).toEqual([])
    expect(body.diff.content).toBeNull()
    expect(body.activation).toBeNull()
    expect(res.json().warnings).toEqual([])
    expect(host.requestActivation).not.toHaveBeenCalled()

    const [row] = await rows()
    expect(row).toMatchObject({ id: body.release.id, state: 'staged' })
    expect((await readdir(config.paths.releases)).sort()).toEqual([body.release.id, `${body.release.id}.tgz`].sort())
    expect(await readdir(releaseDir(config.paths.releases, body.release.id))).toContain('site.js')
    expect(body.release).not.toHaveProperty('schema')
  })

  it('answers with a signed link that previews the staged release', async () => {
    await start(null)
    const body = (await push(file)).json<{ release: ReleaseRow; previewUrl: string }>()
    const url = new URL(body.previewUrl)
    expect(`${url.origin}${url.pathname}`).toBe(`${config.baseUrl}${PREVIEW_PATH}`)
    expect(url.searchParams.get('path')).toBe('/')
    expect(verifyPreviewToken(config.secret, url.searchParams.get('token')!, now())).toMatchObject({ release: body.release.id })

    // Made live at once: nothing to preview.
    const live = (await push(file, { query: '?activate=1' })).json()
    expect(live).not.toHaveProperty('previewUrl')
  })

  it('refuses a release name over 100 characters', async () => {
    await start(null)
    const res = await push(file, { query: `?name=${'n'.repeat(101)}` })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: { code: 'validation', message: t('error.releaseNameTooLong', { max: 100 }) } })
    expect((await push(file, { query: `?name=${'n'.repeat(100)}` })).statusCode).toBe(201)
  })

  it('diffs a release against the current one', async () => {
    const { loaded } = await activated()
    await start(loaded)
    const res = await push(changed)
    expect(res.statusCode).toBe(201)
    const { diff } = res.json<{ diff: ReleaseDiff }>()
    expect(diff.structural.types).toEqual({ added: [], removed: [], changed: [] })
    expect(diff.structural.fields).toContainEqual(expect.objectContaining({ type: 'home', change: 'added', path: expect.stringContaining('subtitle') }))
  })

  it('activates with activate=1 through the host', async () => {
    await start(null)
    const res = await push(file, { query: '?activate=1' })
    expect(res.statusCode).toBe(201)
    const body = res.json<{ release: ReleaseRow; activation: ActivationSummary }>()
    expect(host.requestActivation).toHaveBeenCalledWith(body.release.id)
    expect(body.activation).toEqual(summary)
  })

  it('answers 500 when the activation fails, keeping the release staged', async () => {
    await start(null)
    host.requestActivation.mockRejectedValueOnce(new Error('the worker fell over'))
    const res = await push(file, { query: '?activate=1' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toMatchObject({ error: { message: expect.stringContaining('the worker fell over') } })
    expect((await rows()).map((r) => r.state)).toEqual(['staged'])
  })

  it('a dry run reports the diff and keeps nothing', async () => {
    await start(null)
    const before = await readdir(config.paths.releases)
    const res = await push(file, { query: '?dryRun=1&activate=1' })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ release: null; diff: ReleaseDiff; activation: null }>()
    expect(body.release).toBeNull()
    expect(body.activation).toBeNull()
    expect(body.diff.structural.types.added).toEqual(['home'])
    expect(host.requestActivation).not.toHaveBeenCalled()
    expect(await rows()).toEqual([])
    expect(await readdir(config.paths.releases)).toEqual(before)
  })

  it('a bad push leaves nothing behind', async () => {
    await start(null)
    const before = await readdir(config.paths.releases)
    const garbage = await push(randomBytes(64 * 1024))
    expect(garbage.statusCode).toBe(400)
    expect(garbage.json()).toEqual({ error: { code: 'release', message: expect.any(String) } })

    const gzipped = await push(Buffer.from([0x1f, 0x8b, 0x08, 0x00, ...randomBytes(4096)]))
    expect(gzipped.statusCode).toBe(400)

    const unsigned = await push(untrusted)
    expect(unsigned.statusCode).toBe(403)
    expect(unsigned.json()).toEqual({
      error: { code: 'release', message: "This release isn't signed by a trusted key, so it wasn't opened." },
    })

    expect(await readdir(config.paths.releases)).toEqual(before)
    expect(await rows()).toEqual([])
    // The worker is still serving.
    expect((await app!.inject({ method: 'GET', url: '/_inlay/releases', headers: auth() })).statusCode).toBe(200)
  })

  it('answers a bad push over a real connection without hanging', async () => {
    await start(null)
    await app!.listen({ port: 0, host: '127.0.0.1' })
    const address = app!.server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const res = await fetch(`http://127.0.0.1:${port}/_inlay/releases`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${tokens.push}` },
      body: randomBytes(256 * 1024),
      signal: AbortSignal.timeout(10_000),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'release' } })
    expect(await rows()).toEqual([])
  })

  it('refuses a release for another Inlay version or with secrets the host lacks, with 409', async () => {
    await start(null)
    const version = await push(tooNew)
    expect(version.statusCode).toBe(409)
    expect(version.json().error.message).toContain('99.0.0')
    const secret = await push(needsSecret)
    expect(secret.statusCode).toBe(409)
    expect(secret.json().error.message).toContain('MAIL_TOKEN')
    expect(await rows()).toEqual([])
    expect(await readdir(config.paths.releases)).toEqual([])
  })

  it('needs a push token: 401 without one, 403 for a key that may not push', async () => {
    await start(null)
    const none = await push(file, { token: null })
    expect(none.statusCode).toBe(401)
    expect(none.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } })
    // The body is never read: the connection is closed after the answer.
    expect(none.headers.connection).toBe('close')
    expect((await push(file, { token: 'not-a-key' })).statusCode).toBe(401)
    expect((await push(file, { token: tokens.editor })).statusCode).toBe(403)
    const owner = await push(file, { token: tokens.owner })
    expect(owner.statusCode).toBe(403)
    expect(owner.headers.connection).toBe('close')
    expect(owner.json()).toEqual({ error: { code: 'forbidden', message: expect.any(String) } })
    expect(await rows()).toEqual([])
  })

  it('wants the release file as the body', async () => {
    await start(null)
    const res = await push(Buffer.from('{"a":1}'), { type: 'application/json' })
    expect(res.statusCode).toBe(415)
    expect(res.json()).toMatchObject({ error: { message: expect.any(String) } })
    expect(res.headers.connection).toBe('close')
  })

  it('answers 413 for a body over the limit, with or without a length, and keeps nothing', async () => {
    await start(null, host, 1024)
    const before = await readdir(config.paths.releases)
    const sized = await push(randomBytes(4096))
    expect(sized.statusCode).toBe(413)
    expect(sized.headers.connection).toBe('close')

    // Chunked, with no length given: read until it is too much, then answered.
    const chunked = await app!.inject({
      method: 'POST',
      url: '/_inlay/releases',
      headers: { 'content-type': 'application/gzip', authorization: `Bearer ${tokens.push}` },
      payload: Readable.from([randomBytes(600), randomBytes(600), randomBytes(600)]),
    })
    expect(chunked.statusCode).toBe(413)
    expect(chunked.json()).toEqual({ error: { code: 'validation', message: t('error.pushTooLarge', { mb: 0 }) } })
    expect(chunked.headers.connection).toBe('close')
    expect(await readdir(config.paths.releases)).toEqual(before)
    expect(await rows()).toEqual([])
  })

  it('answers 413 over a real chunked connection instead of resetting it', async () => {
    await start(null, host, 1024)
    await app!.listen({ port: 0, host: '127.0.0.1' })
    const address = app!.server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const { request } = await import('node:http')
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, method: 'POST', path: '/_inlay/releases', headers: { 'content-type': 'application/gzip', authorization: `Bearer ${tokens.push}` } },
        (res) => {
          let body = ''
          res.on('data', (c: Buffer) => (body += c.toString('utf8')))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        },
      )
      req.on('error', reject)
      // Sent in pieces, without ending: the server answers before the body is done.
      req.write(randomBytes(800))
      req.write(randomBytes(800))
    })
    expect(answer.status).toBe(413)
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: 'validation' } })
  })
})

describe('the other release routes', () => {
  it('lists releases with the current one', async () => {
    const { loaded, id } = await activated()
    await start(loaded)
    const pushed = (await push(changed)).json<{ release: ReleaseRow }>().release
    const res = await app!.inject({ method: 'GET', url: '/_inlay/releases', headers: auth() })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ releases: ReleaseRow[]; current: string | null }>()
    expect(body.current).toBe(id)
    expect(body.releases.map((r) => r.id).sort()).toEqual([id, pushed.id].sort())
    for (const release of body.releases) expect(release).not.toHaveProperty('schema')
    expect((await app!.inject({ method: 'GET', url: '/_inlay/releases' })).statusCode).toBe(401)
  })

  it('activates a stored release by id', async () => {
    await start(null)
    const pushed = (await push(file)).json<{ release: ReleaseRow }>().release
    const res = await app!.inject({ method: 'POST', url: `/_inlay/releases/${pushed.id}/activate`, headers: auth() })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ release: { id: pushed.id }, activation: summary })
    expect(host.requestActivation).toHaveBeenCalledWith(pushed.id)

    const unknown = await app!.inject({ method: 'POST', url: '/_inlay/releases/nope/activate', headers: auth() })
    expect(unknown.statusCode).toBe(404)
    const editor = await app!.inject({
      method: 'POST',
      url: `/_inlay/releases/${pushed.id}/activate`,
      headers: { authorization: `Bearer ${tokens.editor}` },
    })
    expect(editor.statusCode).toBe(403)
  })

  it('deletes a staged release but not the current one', async () => {
    const { loaded, id } = await activated()
    await start(loaded)
    const pushed = (await push(changed)).json<{ release: ReleaseRow }>().release
    const res = await app!.inject({ method: 'DELETE', url: `/_inlay/releases/${pushed.id}`, headers: auth() })
    expect(res.statusCode).toBe(204)
    expect((await rows()).find((r) => r.id === pushed.id)?.state).toBe('deleted')
    expect(await readdir(config.paths.releases)).not.toContain(pushed.id)

    const current = await app!.inject({ method: 'DELETE', url: `/_inlay/releases/${id}`, headers: auth() })
    expect(current.statusCode).toBe(409)
    expect(current.json()).toMatchObject({ error: { code: 'release' } })
    expect((await app!.inject({ method: 'DELETE', url: '/_inlay/releases/nope', headers: auth() })).statusCode).toBe(404)
  })

  it('deleting a release clears cached code-image variants no remaining release names', async () => {
    const { loaded } = await activated()
    await start(loaded)
    const pushed = (await push(changed)).json<{ release: ReleaseRow }>().release
    const unused = join(config.paths.media, 'cache', `code-${'a'.repeat(64)}`)
    const library = join(config.paths.media, 'cache', 'b'.repeat(64))
    await mkdir(unused, { recursive: true })
    await mkdir(library, { recursive: true })
    const res = await app!.inject({ method: 'DELETE', url: `/_inlay/releases/${pushed.id}`, headers: auth() })
    expect(res.statusCode).toBe(204)
    expect(existsSync(unused)).toBe(false)
    expect(existsSync(library)).toBe(true)
  })
})

describe('the content diff', () => {
  let previews: Map<string, PreviewApp>
  let hooks: {
    requestActivation: HostApi['requestActivation']
    startPreview: ReturnType<typeof vi.fn<NonNullable<HostApi['startPreview']>>>
    stopPreview: ReturnType<typeof vi.fn<NonNullable<HostApi['stopPreview']>>>
  }

  beforeEach(() => {
    previews = new Map()
    hooks = {
      requestActivation: host.requestActivation,
      // The release's preview in this process, as the preview worker runs it.
      startPreview: vi.fn<NonNullable<HostApi['startPreview']>>(async (id, o) => {
        const running = previews.get(id)
        if (running) return running.socket
        const preview = await startPreviewApp(config, id, { logger: false, now, ...(o?.dir !== undefined && { dir: o.dir }) })
        previews.set(id, preview)
        return preview.socket
      }),
      stopPreview: vi.fn<NonNullable<HostApi['stopPreview']>>(async (id) => {
        const preview = previews.get(id)
        previews.delete(id)
        await preview?.close()
      }),
    }
  })
  afterEach(async () => {
    for (const preview of previews.values()) await preview.close()
  })

  it('names the types a new required field leaves with gaps, and keeps the preview running', async () => {
    const { loaded } = await activated()
    await start(loaded, hooks)
    const res = await push(required)
    expect(res.statusCode).toBe(201)
    const body = res.json<{ release: ReleaseRow; diff: ReleaseDiff; warnings: string[] }>()
    expect(body.diff.content?.gaps).toEqual([{ type: 'home', label: 'Home', documents: 1 }])
    expect(body.warnings).toEqual([])
    expect(hooks.startPreview).toHaveBeenCalledWith(body.release.id)
    expect(hooks.stopPreview).not.toHaveBeenCalled()
    expect([...previews.keys()]).toEqual([body.release.id])
  })

  it('reports the shipped documents a bumped edition replaces', async () => {
    const { loaded } = await activated()
    await start(loaded, hooks)
    const res = await push(bumped)
    expect(res.statusCode).toBe(201)
    const { diff } = res.json<{ diff: ReleaseDiff }>()
    expect(diff.content?.shipped.replaced.map((i) => [i.type, i.edition])).toEqual([['home', 2]])
    expect(diff.content?.gaps).toEqual([])
  })

  it('a dry run works the content diff out from its scratch folder, stops the preview and never records a row', async () => {
    const { loaded, id } = await activated()
    await start(loaded, hooks)
    const before = (await readdir(config.paths.releases)).sort()
    const start_ = hooks.startPreview.getMockImplementation()!
    let during: { rows: string[]; files: string[] } | null = null
    hooks.startPreview.mockImplementationOnce(async (releaseId, o) => {
      // While the preview works the diff out, the live table and folder have nothing of it.
      during = { rows: (await rows()).map((r) => r.id), files: await readdir(config.paths.releases) }
      return start_(releaseId, o)
    })
    const res = await push(required, { query: '?dryRun=1' })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ release: null; diff: ReleaseDiff; warnings: string[] }>()
    expect(body.release).toBeNull()
    expect(body.warnings).toEqual([])
    expect(body.diff.content?.gaps).toEqual([{ type: 'home', label: 'Home', documents: 1 }])
    const [previewed, how] = hooks.startPreview.mock.calls[0]!
    expect(how?.dir).toMatch(/[\\/]\.push-[^\\/]+$/)
    expect(during).toEqual({ rows: [id], files: expect.not.arrayContaining([previewed, `${previewed}.tgz`]) })
    expect(hooks.stopPreview).toHaveBeenCalledWith(previewed)
    expect(previews.size).toBe(0)
    expect((await rows()).map((r) => r.id)).toEqual([id])
    expect((await readdir(config.paths.releases)).sort()).toEqual(before)
  })

  it('with activate, gives the content half 10 seconds in all and goes on without it', async () => {
    await start(null, hooks)
    const db = openDatabase(config.paths.db)
    try {
      const result = await pushRelease(
        {
          db,
          config,
          registry: null,
          now,
          host: { startPreview: () => new Promise<string>(() => {}) },
          activateDiffTimeoutMs: 50,
        },
        file,
        { dryRun: false, activate: true, pushedBy: null },
      )
      expect(result.release?.state).toBe('staged')
      expect(result.diff.content).toBeNull()
      expect(result.warnings).toEqual([t('push.diffUnavailable', { reason: t('error.pushDiffTimeout', { seconds: 1 }) })])
    } finally {
      await db.destroy()
    }
  })

  it("leaves the content half out with a warning when the preview can't start or answer", async () => {
    await start(null, hooks)
    hooks.startPreview.mockRejectedValueOnce(new InlayError('invalid_operation', 'error.previewUnavailable'))
    const res = await push(file)
    expect(res.statusCode).toBe(201)
    const body = res.json<{ release: ReleaseRow; diff: ReleaseDiff; warnings: string[] }>()
    expect(body.release.state).toBe('staged')
    expect(body.diff.content).toBeNull()
    expect(body.diff.structural.types.added).toEqual(['home'])
    expect(body.warnings).toEqual([t('push.diffUnavailable', { reason: t('error.previewUnavailable') })])

    // A socket nothing listens on: said in plain words.
    hooks.startPreview.mockResolvedValueOnce(join(dataDir, 'nothing.sock'))
    const unanswered = (await push(changed)).json<{ diff: ReleaseDiff; warnings: string[] }>()
    expect(unanswered.diff.content).toBeNull()
    expect(unanswered.warnings).toEqual([t('push.diffUnavailable', { reason: t('error.pushDiffUnreachable') })])
  })

  it('deleting a staged release stops its preview', async () => {
    await start(null, hooks)
    hooks.startPreview.mockRejectedValueOnce(new InlayError('invalid_operation', 'error.previewUnavailable'))
    const pushed = (await push(file)).json<{ release: ReleaseRow }>().release
    const res = await app!.inject({ method: 'DELETE', url: `/_inlay/releases/${pushed.id}`, headers: auth() })
    expect(res.statusCode).toBe(204)
    expect(hooks.stopPreview).toHaveBeenCalledWith(pushed.id)
  })

  it('lists only the migration functions not yet run for the release', async () => {
    const { id } = await activated()
    const db = openDatabase(config.paths.db)
    try {
      await db.insertInto('release_migrations').values({ release_id: id, name: 'first', ran_at: now().toISOString() }).execute()
      expect(await pendingMigrations(db, id, ['first', 'second'])).toEqual(['second'])
      expect(await pendingMigrations(db, 'other', ['first', 'second'])).toEqual(['first', 'second'])
    } finally {
      await db.destroy()
    }
  })
})
