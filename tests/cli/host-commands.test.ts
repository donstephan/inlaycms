import { existsSync } from 'node:fs'
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as tar from 'tar'
import { runCli } from '../../src/adapters/cli/main.js'
import { t } from '../../src/core/messages/index.js'
import { generateKeyPair } from '../../src/core/release/keys.js'
import { packRelease } from '../../src/core/release/pack.js'
import { png } from '../fixtures/media.js'

const fixtures = resolve(import.meta.dirname, '../fixtures')

let packDir: string
let file: string
let publicKey: string

beforeAll(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'inlay-cli-host-pack-'))
  const siteDir = join(packDir, 'site')
  await cp(join(fixtures, 'release'), siteDir, { recursive: true })
  await mkdir(join(siteDir, 'assets'))
  await writeFile(join(siteDir, 'assets/pic.png'), await png(20, 10))
  const keys = generateKeyPair()
  publicKey = keys.publicKey
  file = join(packDir, 'site.tgz')
  await packRelease({ configFile: join(siteDir, 'inlay.config.ts'), privateKey: keys.privateKey, out: file, name: 'host-1' })
})
afterAll(() => rm(packDir, { recursive: true, force: true }))

/** A working folder without a config file, as on a host, and its data folder. */
let dir: string
let data: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inlay-cli-host-'))
  data = join(dir, 'data')
  vi.stubEnv('INLAY_DATA_DIR', '')
  vi.stubEnv('INLAY_BASE_URL', 'http://localhost:3000')
  vi.stubEnv('INLAY_SECRET', 'x'.repeat(32))
  vi.stubEnv('INLAY_TRUSTED_KEYS', publicKey)
  vi.stubEnv('HOOK', '')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

async function runWith(argv: string[], password?: string) {
  const out: string[] = []
  const err: string[] = []
  const io = { cwd: dir, out: (l: string) => out.push(l), err: (l: string) => err.push(l) }
  const code = await runCli(argv, password === undefined ? io : { ...io, readSecret: async () => password })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

const run = (...argv: string[]) => runWith(argv)

/** The one backup archive in the data folder whose name ends with `suffix`. */
async function archiveName(suffix: string): Promise<string> {
  const names = (await readdir(join(data, 'backups'))).filter((n) => n.endsWith(suffix))
  expect(names).toHaveLength(1)
  return names[0]!
}

async function entries(archive: string): Promise<string[]> {
  const names: string[] = []
  await tar.t({ file: archive, onReadEntry: (e) => names.push(e.path) })
  return names
}

describe('kept commands on a host, without a config file', () => {
  it('backup takes the data folder from --data, or from INLAY_DATA_DIR', async () => {
    expect((await run('activate', file, '--data', data)).code).toBe(0)
    const r = await run('backup', '--data', data)
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    const [archive] = (await readdir(join(data, 'backups'))).filter((n) => n.endsWith('-manual.tar.gz'))
    expect(await entries(join(data, 'backups', archive!))).toEqual(expect.arrayContaining(['inlay.db', 'release.tgz', 'media/']))

    vi.stubEnv('INLAY_DATA_DIR', data)
    const again = await run('backup')
    expect(again.err).toBe('')
    expect(again.code).toBe(0)
  })

  it('export writes the content of the live release', async () => {
    expect((await run('activate', file, '--data', data)).code).toBe(0)
    const r = await run('export', '--data', data, '--out', 'content.tar.gz')
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toContain('1 documents')
    expect(existsSync(join(dir, 'content.tar.gz'))).toBe(true)
  })

  it('import uses the site of the live release', async () => {
    expect((await run('activate', file, '--data', data)).code).toBe(0)
    expect((await run('export', '--data', data, '--out', 'content.tar.gz')).code).toBe(0)
    const dry = await run('import', 'content.tar.gz', '--data', data, '--dry-run')
    expect(dry.code).toBe(0)
    const r = await run('import', 'content.tar.gz', '--data', data)
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toContain('Content restored from')
    expect((await readdir(join(data, 'backups'))).some((n) => n.endsWith('-pre-import.tar.gz'))).toBe(true)
  })

  it('import refuses without a live release', async () => {
    await mkdir(data)
    await writeFile(join(dir, 'content.tar.gz'), '')
    const r = await run('import', 'content.tar.gz', '--data', data)
    expect(r.code).toBe(2)
    expect(r.err).toContain('no live release')
  })

  it('restore-backup puts back the database, media and live release in the data folder', async () => {
    expect((await run('activate', file, '--data', data)).code).toBe(0)
    expect((await run('backup', '--data', data)).code).toBe(0)
    const archive = await archiveName('-manual.tar.gz')
    const pointer = await readFile(join(data, 'releases', 'current.json'), 'utf8')
    const { id } = JSON.parse(pointer) as { id: string }
    await rm(join(data, 'releases'), { recursive: true })

    // A bare name is looked up in the data folder's backups.
    const r = await run('restore-backup', archive, '--data', data)
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toContain(t('cli.backupRestoredRelease', { name: 'host-1' }))
    expect(await readFile(join(data, 'releases', 'current.json'), 'utf8')).toBe(pointer)
    expect(existsSync(join(data, 'releases', id, 'site.js'))).toBe(true)
    expect(existsSync(join(data, 'releases', `${id}.tgz`))).toBe(true)
    expect((await run('export', '--data', data, '--out', 'content.tar.gz')).out).toContain('1 documents')
  })

  it('restore-backup refuses a backup whose release file is not the one its database recorded', async () => {
    expect((await run('activate', file, '--data', data)).code).toBe(0)
    expect((await run('backup', '--data', data)).code).toBe(0)
    const archive = join(data, 'backups', await archiveName('-manual.tar.gz'))
    const work = join(dir, 'work')
    await mkdir(work)
    await tar.x({ file: archive, cwd: work })
    await appendFile(join(work, 'release.tgz'), '\n')
    const tampered = join(dir, 'tampered.tar.gz')
    await tar.c({ gzip: true, file: tampered, cwd: work }, await readdir(work))
    const before = await readFile(join(data, 'inlay.db'))

    const r = await run('restore-backup', tampered, '--data', data)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(t('error.backupReleaseChecksum'))
    expect(await readFile(join(data, 'inlay.db'))).toEqual(before)
  })

  it('create-owner works on the data folder, with no live release or with one', async () => {
    const fresh = await runWith(['create-owner', '--data', data, '--email', 'olive@example.com', '--name', 'Olive'], 'a long enough password')
    expect(fresh.err).toBe('')
    expect(fresh.code).toBe(0)
    expect(fresh.out).toContain(t('cli.ownerCreated', { email: 'olive@example.com' }))

    // Another host, with a live release; a host has one owner.
    const other = join(dir, 'other')
    expect((await run('activate', file, '--data', other)).code).toBe(0)
    vi.stubEnv('INLAY_DATA_DIR', other)
    const live = await runWith(['create-owner', '--email', 'oscar@example.com', '--name', 'Oscar'], 'another long password')
    expect(live.err).toBe('')
    expect(live.code).toBe(0)
    expect(live.out).toContain(t('cli.ownerCreated', { email: 'oscar@example.com' }))
  })

  it('says which one it uses when there is both a config file and a data folder', async () => {
    await cp(join(fixtures, 'release'), dir, { recursive: true })
    vi.stubEnv('INLAY_DATA_DIR', data)
    const config = await run('backup')
    expect(config.err).toContain(t('cli.usingConfig', { file: join(dir, 'inlay.config.ts') }))
    const host = await run('backup', '--data', data)
    expect(host.err).toContain(t('cli.usingData', { path: data }))
  })

  it('refuses --data with --config or --db', async () => {
    expect((await run('backup', '--data', data, '--config', 'x.ts')).code).toBe(2)
    expect((await run('export', '--data', data, '--db', 'x.db')).code).toBe(2)
  })
})
