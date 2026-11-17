import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { runCli } from '../../src/adapters/cli/main.js'
import { pushFile } from '../../src/adapters/cli/remote.js'
import { AUTH, type HostApi } from '../../src/adapters/site/plugin.js'
import { openDatabase } from '../../src/core/db/connection.js'
import { migrateSystem } from '../../src/core/db/migrate.js'
import { t } from '../../src/core/messages/index.js'
import { generateKeyPair } from '../../src/core/release/keys.js'
import { packRelease } from '../../src/core/release/pack.js'
import { loadRelease, type LoadedRelease } from '../../src/core/release/read.js'
import { activateRelease } from '../../src/host/activate.js'
import { createSiteApp } from '../../src/host/app.js'
import { formatDiff } from '../../src/host/diff.js'
import { ensureDataDir, readHostConfig, type HostConfig } from '../../src/host/config.js'
import type { ActivationSummary } from '../../src/host/ipc.js'
import { startPreviewApp, type PreviewApp } from '../../src/host/preview-worker.js'
import { listReleases, releaseDir, storeRelease, type ReleaseRow } from '../../src/host/store.js'
import { png } from '../fixtures/media.js'

const fixtures = resolve(import.meta.dirname, '../fixtures')

/** The fixture release's site with a render function on its home template, as a host can only serve that. */
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
  routes: [defineRoute({ method: 'GET', path: '/ping', handler: () => ({ json: { ok: true } }) })],
  content,
})
`

/** The fixture's shipped home page with a new title but the same edition. */
const staleContent = `import { defineContent } from 'inlaycms/site'

export const content = [
  defineContent('home', {
    edition: 1,
    content: { en: { fields: { title: 'Changed', picture: { file: new URL('./assets/pic.png', import.meta.url), alt: 'A picture' } } } },
  }),
]
`

const summary: ActivationSummary = {
  shipped: { created: 1, replaced: 0, skipped: 0 },
  migrations: [],
  backup: null,
  noop: false,
  warnings: 0,
}

let packDir: string
let keys: { privateKey: string; publicKey: string }
let keyFile: string
let file: string
let stale: string
let untrusted: string

/** Copies the fixture site, with a render function and `contentTs` as its shipped content, into `<packDir>/<name>`. */
async function siteDir(name: string, contentTs?: string): Promise<string> {
  const dir = join(packDir, name)
  await cp(join(fixtures, 'release'), dir, { recursive: true })
  await mkdir(join(dir, 'assets'))
  await writeFile(join(dir, 'assets/pic.png'), await png(20, 10))
  await writeFile(join(dir, 'site.ts'), siteTs)
  if (contentTs !== undefined) await writeFile(join(dir, 'content.ts'), contentTs)
  return dir
}

async function packSite(name: string, contentTs?: string, privateKey = keys.privateKey): Promise<string> {
  const dir = await siteDir(name, contentTs)
  const out = join(packDir, `${name}.tgz`)
  await packRelease({ configFile: join(dir, 'inlay.config.ts'), privateKey, out, name })
  return out
}

beforeAll(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'inlay-cli-push-pack-'))
  keys = generateKeyPair()
  keyFile = join(packDir, 'signing.key')
  await writeFile(keyFile, keys.privateKey)
  file = await packSite('test-1')
  stale = await packSite('test-2', staleContent)
  untrusted = await packSite('untrusted', undefined, generateKeyPair().privateKey)
}, 30_000)
afterAll(() => rm(packDir, { recursive: true, force: true }))

let dataDir: string
let config: HostConfig
let app: FastifyInstance | undefined
let host: string
let previews: Map<string, PreviewApp>
let hooks: {
  requestActivation: ReturnType<typeof vi.fn<HostApi['requestActivation']>>
  startPreview: NonNullable<HostApi['startPreview']>
  stopPreview: NonNullable<HostApi['stopPreview']>
}
let tokens: { push: string; owner: string }
let clock: number
const now = () => new Date(Date.UTC(2026, 10, 5, 12, 0, clock++))

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'inlay-cli-push-'))
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
  previews = new Map()
  hooks = {
    requestActivation: vi.fn<HostApi['requestActivation']>(async () => summary),
    // The release's preview in this process, as the preview worker runs it.
    startPreview: async (id, o) => {
      const running = previews.get(id)
      if (running) return running.socket
      const preview = await startPreviewApp(config, id, { logger: false, now, ...(o?.dir !== undefined && { dir: o.dir }) })
      previews.set(id, preview)
      return preview.socket
    },
    stopPreview: async (id) => {
      const preview = previews.get(id)
      previews.delete(id)
      await preview?.close()
    },
  }
  vi.stubEnv('INLAY_PUSH_TOKEN', '')
  vi.stubEnv('INLAY_SIGNING_KEY', '')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const preview of previews.values()) await preview.close()
  await app?.close()
  await rm(dataDir, { recursive: true, force: true })
})

/** Stores and activates the fixture release, as `inlaycms activate` would. */
async function activated(): Promise<LoadedRelease> {
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
    return loaded
  } finally {
    await db.destroy()
  }
}

/** The app under the host, listening on a free port, with an owner who has a push key and a plain key. */
async function start(loaded: LoadedRelease | null): Promise<void> {
  const made = await createSiteApp(config, loaded, { content: 'none', now, host: hooks })
  app = made.app
  const service = app.inlay[AUTH]
  const owner = await service.createUser({ email: 'owner@example.com', name: 'Olivia Owner', password: 'correct horse battery', role: 'owner' })
  tokens = {
    push: await service.createApiKey(owner.id!, 'push', { permissions: { release: ['push'] } }),
    owner: await service.createApiKey(owner.id!, 'plain'),
  }
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  host = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
}

async function run(cwd: string, ...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli(argv, { cwd, out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

async function rows(): Promise<ReleaseRow[]> {
  const db = openDatabase(config.paths.db)
  try {
    return await listReleases(db)
  } finally {
    await db.destroy()
  }
}

describe('inlaycms push', () => {
  it('packs the site, pushes it and prints what it changes', async () => {
    await start(null)
    const dir = await siteDir('packed')
    const r = await run(dir, 'push', host, '--token', tokens.push, '--key', keyFile, '--name', 'packed-1')
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    const [row] = await rows()
    expect(row).toMatchObject({ name: 'packed-1', state: 'staged' })
    expect(r.out).toContain('Release packed-1 packed')
    expect(r.out).toContain(t('cli.pushStaged', { name: 'packed-1', id: row!.id }))
    expect(r.out).toContain(t('diff.release.typeAdded', { type: 'home' }))
    expect(r.out).toContain('`home` (en) will be created from the shipped content.')
    expect(r.out).toContain(t('diff.release.secrets', { count: 1, names: 'HOOK' }))
    expect(r.out).toContain(t('cli.pushActivateHint', { host, id: row!.id }))
    expect(r.out).toMatch(new RegExp(`Preview it \\(the link works for 24 hours\\): https://example\\.com/_inlay/preview\\?token=v2\\.[0-9a-z]+\\.${row!.id}\\.`))
    expect(hooks.requestActivation).not.toHaveBeenCalled()
  }, 30_000)

  it('warns about shipped content that changed without a new edition', async () => {
    await start(await activated())
    const r = await run(packDir, 'push', host, '--file', stale, '--token', tokens.push)
    expect(r.code).toBe(0)
    expect(r.out).toContain("`home` content changed but is still edition 1; it won't be applied.")
  })

  it('says when nothing changes', async () => {
    await start(await activated())
    const r = await run(packDir, 'push', host, '--file', file, '--token', tokens.push)
    expect(r.code).toBe(0)
    expect(r.out).toContain(t('diff.release.nothing'))
  })

  it('a dry run reports and keeps nothing', async () => {
    await start(null)
    const before = await readdir(config.paths.releases)
    const r = await run(packDir, 'push', host, '--file', file, '--dry-run', '--token', tokens.push)
    expect(r.code).toBe(0)
    expect(r.out).toContain(t('cli.pushDryRun'))
    expect(r.out).toContain(t('diff.release.typeAdded', { type: 'home' }))
    expect(await rows()).toEqual([])
    expect(await readdir(config.paths.releases)).toEqual(before)
  })

  it('with --activate has the host make it live and prints what that did', async () => {
    await start(null)
    const r = await run(packDir, 'push', host, '--file', file, '--activate', '--token', tokens.push)
    expect(r.code).toBe(0)
    const [row] = await rows()
    expect(hooks.requestActivation).toHaveBeenCalledWith(row!.id)
    expect(r.out).toContain('1 document of shipped content created.')
    expect(r.out).toContain('Release test-1 is now live.')
  })

  it('prints the diff and the reason, and exits 1, when the release could not be made live', async () => {
    await start(null)
    hooks.requestActivation.mockRejectedValueOnce(new Error('the worker fell over'))
    const r = await run(packDir, 'push', host, '--file', file, '--activate', '--token', tokens.push)
    expect(r.code).toBe(1)
    expect(r.out).toContain(t('diff.release.typeAdded', { type: 'home' }))
    expect(r.err).toContain('the worker fell over')
    expect((await rows()).map((row) => row.state)).toEqual(['staged'])
  })

  it('takes the token from INLAY_PUSH_TOKEN', async () => {
    await start(null)
    vi.stubEnv('INLAY_PUSH_TOKEN', tokens.push)
    const r = await run(packDir, 'push', host, '--file', file)
    expect(r.code).toBe(0)
    expect(await rows()).toHaveLength(1)
  })

  it('exits 2 without a token, a signing key, a file or a server address', async () => {
    await start(null)
    const noToken = await run(packDir, 'push', host, '--file', file)
    expect(noToken.code).toBe(2)
    expect(noToken.err).toContain(t('cli.pushToken'))

    const noKey = await run(await siteDir('no-key'), 'push', host, '--token', tokens.push)
    expect(noKey.code).toBe(2)
    expect(noKey.err).toContain(t('cli.packKey'))

    const noFile = await run(packDir, 'push', host, '--file', 'nope.tgz', '--token', tokens.push)
    expect(noFile.code).toBe(2)
    expect(noFile.err).toContain(join(packDir, 'nope.tgz'))

    const notHost = await run(packDir, 'push', 'example.com', '--file', file, '--token', tokens.push)
    expect(notHost.code).toBe(2)
    expect(notHost.err).toContain(t('cli.pushHost', { host: 'example.com' }))
    expect(await rows()).toEqual([])
  }, 30_000)

  it("prints the server's message and exits 1 when it refuses", async () => {
    await start(null)
    const forbidden = await run(packDir, 'push', host, '--file', file, '--token', tokens.owner)
    expect(forbidden.code).toBe(1)
    expect(forbidden.err).toContain(t('error.pushForbidden'))

    const unsigned = await run(packDir, 'push', host, '--file', untrusted, '--token', tokens.push)
    expect(unsigned.code).toBe(1)
    expect(unsigned.err).toContain("This release isn't signed by a trusted key, so it wasn't opened.")
    expect(await rows()).toEqual([])
  })

  it('--dry-run with --activate is a usage error', async () => {
    const r = await run(packDir, 'push', 'https://example.com', '--file', file, '--dry-run', '--activate', '--token', 'any')
    expect(r.code).toBe(2)
    expect(r.err).toBe(t('cli.pushDryRunActivate'))
  })

  it('refuses plain http to anything but this computer unless --insecure', async () => {
    const r = await run(packDir, 'push', 'http://example.com', '--file', file, '--token', 'any')
    expect(r.code).toBe(2)
    expect(r.err).toBe(t('cli.pushInsecure', { host: 'http://example.com' }))
    expect((await run(packDir, 'releases', 'http://example.com', '--token', 'any')).code).toBe(2)
    expect((await run(packDir, 'activate', 'http://example.com', 'x', '--token', 'any')).code).toBe(2)

    // With --insecure it is sent (here to a server that isn't there).
    const insecure = await run(packDir, 'releases', 'http://inlay-test.invalid', '--token', 'any', '--insecure')
    expect(insecure.code).toBe(1)
    expect(insecure.err).toContain("couldn't be reached")
    // --insecure goes only with a server address.
    expect((await run(packDir, 'releases', '--data', dataDir, '--insecure')).code).toBe(2)
  })

  it('exits 1 when the server cannot be reached', async () => {
    await start(null)
    await app!.close()
    const gone = host
    app = undefined
    const r = await run(packDir, 'push', gone, '--file', file, '--token', 'any')
    expect(r.code).toBe(1)
    expect(r.err).toContain(`The server at ${gone} couldn't be reached`)
  })
})

describe('a server that answers oddly', () => {
  let server: Server | undefined
  let address: string

  /** A server that reads the whole request, then does what `answer` says. */
  async function fake(answer: (req: IncomingMessage, res: ServerResponse) => void): Promise<void> {
    server = createServer((req, res) => {
      req.resume()
      req.on('end', () => answer(req, res))
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const a = server.address()
    address = `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`
  }
  afterEach(async () => {
    server?.closeAllConnections()
    await new Promise((resolve) => server?.close(resolve))
    server = undefined
  })

  it('a 502 after the upload says the push may still have gone through', async () => {
    await fake((_req, res) => res.writeHead(502, { 'content-type': 'text/html' }).end('<h1>Bad gateway</h1>'))
    const r = await run(packDir, 'push', address, '--file', file, '--token', 'any', '--activate')
    expect(r.code).toBe(1)
    expect(r.err).toBe(t('cli.pushUnknown', { host: address, problem: t('error.remoteStatus', { status: 502 }) }))
    const activate = await run(packDir, 'activate', address, 'some-id', '--token', 'any')
    expect(activate.code).toBe(1)
    expect(activate.err).toContain(`inlaycms releases ${address}`)
  })

  it('no answer in time after the upload says the push may still have gone through', async () => {
    await fake(() => {})
    await expect(pushFile(address, 'any', file, { timeoutMs: 200 })).rejects.toMatchObject({
      messageId: 'cli.pushUnknown',
      message: t('cli.pushUnknown', { host: address, problem: t('error.remoteTimeout', { seconds: 0 }) }),
    })
  })

  it('a connection cut after the upload says so too, but one never made says the server could not be reached', async () => {
    await fake((req) => req.socket.destroy())
    await expect(pushFile(address, 'any', file)).rejects.toMatchObject({ messageId: 'cli.pushUnknown' })
    const listed = await run(packDir, 'releases', address, '--token', 'any')
    expect(listed.code).toBe(1)
    expect(listed.err).toContain("couldn't be reached")
  })

  it('does not follow a redirect, so the token goes nowhere else', async () => {
    let asked = 0
    await fake((_req, res) => {
      asked++
      res.writeHead(307, { location: 'https://elsewhere.example/_inlay/releases' }).end()
    })
    const r = await run(packDir, 'releases', address, '--token', 'any')
    expect(r.code).toBe(1)
    expect(r.err).toBe(t('error.remoteRedirect', { host: address, location: 'https://elsewhere.example/_inlay/releases' }))
    expect(asked).toBe(1)
  })

  it('anything unexpected is said in a line, not a stack trace', async () => {
    await fake((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"releases":[null],"current":null}'))
    const r = await run(packDir, 'releases', address, '--token', 'any')
    expect(r.code).toBe(1)
    expect(r.err).toMatch(new RegExp(`^Something went wrong while talking to the server at ${address.replace(/\./g, '\\.')}: `))
    expect(r.err).not.toContain('    at ')
  })
})

describe('inlaycms activate <host> <id> and inlaycms releases <host>', () => {
  it('lists the releases on the server', async () => {
    await start(null)
    expect((await run(packDir, 'push', host, '--file', file, '--token', tokens.push)).code).toBe(0)
    const [row] = await rows()
    const r = await run(packDir, 'releases', host, '--token', tokens.push)
    expect(r.code).toBe(0)
    expect(r.out).toContain(row!.id)
    expect(r.out).toContain(t('cli.releaseState.staged'))

    const json = await run(packDir, 'releases', host, '--token', tokens.push, '--json')
    expect(JSON.parse(json.out)).toEqual([expect.objectContaining({ id: row!.id, name: 'test-1', state: 'staged' })])
  })

  it('makes a release on the server live', async () => {
    await start(null)
    expect((await run(packDir, 'push', host, '--file', file, '--token', tokens.push)).code).toBe(0)
    const [row] = await rows()
    const r = await run(packDir, 'activate', host, row!.id, '--token', tokens.push)
    expect(r.code).toBe(0)
    expect(hooks.requestActivation).toHaveBeenCalledWith(row!.id)
    expect(r.out).toContain('Release test-1 is now live.')

    const unknown = await run(packDir, 'activate', host, 'nope', '--token', tokens.push)
    expect(unknown.code).toBe(1)
    expect(unknown.err).toContain(`The server at ${host} refused:`)
  })

  it('needs a token, and leaves the offline forms alone', async () => {
    await start(null)
    expect((await run(packDir, 'releases', host)).code).toBe(2)
    expect((await run(packDir, 'activate', host, 'some-id')).code).toBe(2)
    // Flags of the offline forms don't go with a server address.
    expect((await run(packDir, 'releases', host, '--token', tokens.push, '--data', dataDir)).code).toBe(2)
    expect((await run(packDir, 'activate', host, 'x', '--token', tokens.push, '--server-stopped')).code).toBe(2)
    // Without one, --token doesn't belong.
    expect((await run(packDir, 'releases', '--data', dataDir, '--token', tokens.push)).code).toBe(2)
    const offline = await run(packDir, 'releases', '--data', dataDir)
    expect(offline.code).toBe(0)
  })
})

describe('formatDiff', () => {
  it('says each change in a line of its own', () => {
    const item = (type: string, key: string, edition = 1) => ({ documentId: null, type, key, locale: 'en', edition })
    const lines = formatDiff({
      structural: {
        types: { added: ['posts'], removed: ['team', 'faq'], changed: [] },
        slots: { added: [{ type: 'home', slot: 'hero' }], removed: [{ type: 'home', slot: 'testimonials' }], optional: [], required: [] },
        locales: { added: [], removed: ['fr'] },
        fields: [
          { type: 'home', path: 'fields.seo.title', change: 'added' },
          { type: 'home', path: 'fields.summary', change: 'required' },
          { type: 'home', path: 'slots.hero.headline', change: 'type' },
        ],
        routes: { added: [{ method: 'POST', path: '/contact' }], removed: [{ method: 'GET', path: '/ping' }], sitemap: { added: [], removed: [] } },
        secrets: ['HOOK', 'MAIL'],
        migrations: ['split-names'],
        shipped: { stale: [{ type: 'home', key: 'home', locale: 'en', edition: 2 }, { type: 'home', key: 'home', locale: 'fr', edition: 2 }] },
      },
      content: {
        gaps: [{ type: 'home', label: 'Home', documents: 1 }],
        shipped: { created: [item('posts', 'hello')], replaced: [item('about', 'about', 3)], skipped: [], deletedRefs: [], warnings: [] },
        hidden: { types: [{ type: 'team', documents: 12 }], locales: [{ locale: 'fr', documents: 3 }] },
      },
    })
    expect(lines).toEqual([
      "Removes the content type `team`, which has 12 documents; they'll be hidden, not deleted.",
      'Removes the content type `faq`; any content it has will be hidden, not deleted.',
      '`home` loses the slot `testimonials`; what is in it will be hidden, not deleted.',
      "Removes the language `fr`, which has 3 documents; they'll be hidden, not deleted.",
      'Adds the content type `posts`.',
      '`home` gets the new slot `hero`.',
      '`home`: the field `seo.title` is new.',
      '`home`: the field `summary` becomes required.',
      "`home`: the field `slots.hero.headline` holds a different kind of value now; values that don't fit any more will read as empty.",
      'Home: 1 published document will have a required field with no value.',
      '`posts/hello` (en) will be created from the shipped content.',
      '`about` (en) will be replaced by edition 3 of the shipped content.',
      "`home` content changed but is still edition 2; it won't be applied.",
      'The migration function `split-names` will run.',
      'Adds the route POST /contact.',
      'Removes the route GET /ping.',
      'Needs the secrets HOOK, MAIL set on the server.',
    ])
  })
})
