import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Migrator } from 'kysely/migration'
import * as tar from 'tar'
import { runCli } from '../../src/adapters/cli/main.js'
import { systemCtx } from '../../src/core/auth/roles.js'
import { createBackup } from '../../src/core/backup/backup.js'
import { databaseInUse, restoreBackup } from '../../src/core/backup/restore.js'
import { openDatabase } from '../../src/core/db/connection.js'
import * as m0001 from '../../src/core/db/migrations/0001_content.js'
import { t } from '../../src/core/messages/index.js'
import { generateKeyPair } from '../../src/core/release/keys.js'
import { packRelease } from '../../src/core/release/pack.js'
import { listReleases, readCurrentPointer, releaseDir } from '../../src/host/store.js'
import { writeArchive } from '../fixtures/archives.js'
import { png } from '../fixtures/media.js'

const fixtures = resolve(import.meta.dirname, '../fixtures')

let packDir: string
let file: string
let keys: { privateKey: string; publicKey: string }

beforeAll(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'inlay-cli-activate-pack-'))
  const siteDir = join(packDir, 'site')
  await cp(join(fixtures, 'release'), siteDir, { recursive: true })
  await mkdir(join(siteDir, 'assets'))
  await writeFile(join(siteDir, 'assets/pic.png'), await png(20, 10))
  keys = generateKeyPair()
  file = join(packDir, 'site.tgz')
  await packRelease({ configFile: join(siteDir, 'inlay.config.ts'), privateKey: keys.privateKey, out: file, name: 'test-1' })
})
afterAll(() => rm(packDir, { recursive: true, force: true }))

let dir: string
let data: string
const paths = () => ({
  db: join(data, 'inlay.db'),
  media: join(data, 'media'),
  backups: join(data, 'backups'),
  releases: join(data, 'releases'),
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inlay-cli-activate-'))
  data = join(dir, 'data')
  vi.stubEnv('INLAY_DATA_DIR', data)
  vi.stubEnv('INLAY_BASE_URL', 'http://localhost:3000')
  vi.stubEnv('INLAY_SECRET', 'x'.repeat(32))
  vi.stubEnv('INLAY_TRUSTED_KEYS', keys.publicKey)
  vi.stubEnv('HOOK', '')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

async function run(...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli(argv, { cwd: dir, out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

async function rows() {
  // Read-write, as a read-only connection can't remove the write-ahead log on close and the database would look in use.
  const db = openDatabase(paths().db)
  try {
    return await listReleases(db)
  } finally {
    await db.destroy()
  }
}

async function entries(archive: string): Promise<string[]> {
  const names: string[] = []
  await tar.t({ file: archive, onReadEntry: (e) => names.push(e.path) })
  return names
}

describe('inlaycms activate', () => {
  it('stores and activates a release file on a fresh data folder', async () => {
    const r = await run('activate', file)
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toContain('Release test-1 is now live.')
    expect(r.out).toContain('1 document of shipped content created.')

    const [row] = await rows()
    expect(row).toMatchObject({ name: 'test-1', state: 'current', pushed_by: null })
    expect(await readCurrentPointer(paths().releases)).toMatchObject({ id: row!.id, name: 'test-1' })
    expect(existsSync(join(releaseDir(paths().releases, row!.id), 'site.js'))).toBe(true)
  })

  it('activates a stored release by id, and again as a no-op', async () => {
    expect((await run('activate', file, '--name', 'first')).code).toBe(0)
    expect((await run('activate', file, '--name', 'second')).code).toBe(0)
    const first = (await rows()).find((row) => row.name === 'first')!
    expect(first.state).toBe('previous')

    const r = await run('activate', first.id)
    expect(r.code).toBe(0)
    expect(r.out).toContain('Release first is now live.')
    expect((await rows()).find((row) => row.name === 'first')!.state).toBe('current')
    expect((await readCurrentPointer(paths().releases))?.id).toBe(first.id)

    const again = await run('activate', first.id)
    expect(again.code).toBe(0)
    expect(again.out).toContain('first is already live')
  })

  it('refuses while the server is running, and goes ahead with --server-stopped', async () => {
    await mkdir(data, { recursive: true })
    await writeFile(`${paths().db}-wal`, '')
    const r = await run('activate', file)
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/server/i)
    expect(existsSync(paths().db)).toBe(false)

    await rm(`${paths().db}-wal`)
    expect((await run('activate', file, '--server-stopped')).code).toBe(0)
  })

  it('exits 2 on a release error and on an unknown id', async () => {
    vi.stubEnv('INLAY_TRUSTED_KEYS', generateKeyPair().publicKey)
    const bad = await run('activate', file)
    expect(bad.code).toBe(2)
    expect(bad.err).toContain("isn't signed by a trusted key")
    expect(await rows()).toEqual([])

    const unknown = await run('activate', 'no-such-release')
    expect(unknown.code).toBe(2)
    expect(unknown.err).toContain('no-such-release')
  })

  it('exits 2 when a declared secret is not set, leaving the release staged', async () => {
    vi.stubEnv('HOOK', undefined)
    const r = await run('activate', file)
    expect(r.code).toBe(2)
    expect(r.err).toContain('HOOK')
    expect((await rows())[0]?.state).toBe('staged')
  })

  it('needs trusted keys and the data folder', async () => {
    vi.stubEnv('INLAY_TRUSTED_KEYS', '')
    expect((await run('activate', file)).code).toBe(2)
    vi.stubEnv('INLAY_TRUSTED_KEYS', keys.publicKey)
    vi.stubEnv('INLAY_DATA_DIR', '')
    const r = await run('activate', file)
    expect(r.code).toBe(2)
    expect(r.err).toContain('INLAY_DATA_DIR')
  })

  it('prints usage without a release or with flags it does not take', async () => {
    expect((await run('activate')).code).toBe(2)
    expect((await run('activate', file, '--out', 'x')).code).toBe(2)
    expect((await run('releases', file)).code).toBe(2)
    expect((await run('check', '--data', data)).code).toBe(2)
    expect((await run('backup', '--data', data, '--db', 'x.db')).code).toBe(2)
  })
})

describe('inlaycms activate on an older database', () => {
  it('backs it up before updating its structure', async () => {
    await mkdir(data, { recursive: true })
    const db = openDatabase(paths().db)
    await new Migrator({ db, provider: { getMigrations: async () => ({ '0001_content': m0001 }) } }).migrateToLatest()
    await db.destroy()
    const r = await run('activate', file)
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    const backups = (await readdir(paths().backups)).filter((n) => n.endsWith('-pre-migration.tar.gz'))
    expect(backups).toHaveLength(1)
    expect(r.out).toContain(backups[0])

    // A fresh data folder has nothing to back up.
    data = join(dir, 'fresh')
    expect((await run('activate', file, '--data', data)).code).toBe(0)
    expect(existsSync(paths().backups) ? await readdir(paths().backups) : []).toEqual([])
  })
})

describe('inlaycms activate --data', () => {
  it('uses the folder given instead of INLAY_DATA_DIR', async () => {
    vi.stubEnv('INLAY_DATA_DIR', '')
    data = join(dir, 'other')
    const r = await run('activate', file, '--data', 'other', '--name', 'launch')
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect((await rows())[0]).toMatchObject({ name: 'launch', state: 'current' })
  })
})

describe('inlaycms releases', () => {
  it('says when there are none', async () => {
    const r = await run('releases')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/no releases/i)
  })

  it('needs only the data folder, and finds none in a database from before releases', async () => {
    vi.stubEnv('INLAY_BASE_URL', '')
    vi.stubEnv('INLAY_SECRET', '')
    await mkdir(data, { recursive: true })
    const db = openDatabase(paths().db)
    await new Migrator({ db, provider: { getMigrations: async () => ({ '0001_content': m0001 }) } }).migrateToLatest()
    await db.destroy()
    const r = await run('releases')
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/no releases/i)
  })

  it('lists id, name, state, pushed and activated times, also as JSON', async () => {
    expect((await run('activate', file, '--name', 'first')).code).toBe(0)
    expect((await run('activate', file, '--name', 'second')).code).toBe(0)
    const listed = await rows()

    const r = await run('releases')
    expect(r.code).toBe(0)
    for (const row of listed) {
      expect(r.out).toContain(row.id)
      expect(r.out).toContain(row.name)
      expect(r.out).toContain(row.pushed_at)
      expect(r.out).toContain(row.activated_at!)
    }
    expect(r.out.indexOf('second')).toBeLessThan(r.out.indexOf('first'))
    expect(r.out.split('\n').filter((l) => l.startsWith('    '))).toEqual([])

    const json = await run('releases', '--json')
    for (const entry of JSON.parse(json.out)) expect(entry).not.toHaveProperty('warning')
    expect(JSON.parse(json.out)).toEqual(
      listed.map((row) => ({
        id: row.id,
        name: row.name,
        state: row.state,
        pushedAt: row.pushed_at,
        activatedAt: row.activated_at,
      })),
    )
  })

  it('leaves the database looking stopped, so activate still goes ahead', async () => {
    expect((await run('activate', file, '--name', 'first')).code).toBe(0)
    expect((await run('releases')).code).toBe(0)
    expect(await databaseInUse(paths().db)).toBe(false)
    expect((await run('activate', file, '--name', 'second')).code).toBe(0)
  })

  it('works while the server is running', async () => {
    expect((await run('activate', file)).code).toBe(0)
    const db = openDatabase(paths().db)
    try {
      await db.selectFrom('releases').select('id').execute()
      const r = await run('releases')
      expect(r.code).toBe(0)
      expect(r.out).toContain('test-1')
    } finally {
      await db.destroy()
    }
  })
})

describe('backups with the current release', () => {
  async function backup(): Promise<string> {
    const db = openDatabase(paths().db)
    try {
      return (await createBackup({ db, backups: paths().backups, media: paths().media, reason: 'manual', ctx: systemCtx('system') })).path
    } finally {
      await db.destroy()
    }
  }

  it('puts the current release file and its identity in the archive', async () => {
    expect((await run('activate', file)).code).toBe(0)
    const [row] = await rows()
    const archive = await backup()
    expect(await entries(archive)).toEqual(expect.arrayContaining(['backup.json', 'inlay.db', 'release.tgz', 'release.json']))

    const out = join(dir, 'out')
    await mkdir(out)
    await tar.x({ file: archive, cwd: out })
    expect(JSON.parse(await readFile(join(out, 'release.json'), 'utf8'))).toEqual({ id: row!.id, name: 'test-1' })
    expect(await readFile(join(out, 'release.tgz'))).toEqual(await readFile(file))
  })

  it('takes the release a pre-activation backup is made before', async () => {
    expect((await run('activate', file, '--name', 'first')).code).toBe(0)
    const first = (await rows())[0]!
    // The first activation had no documents to back up; the second backs up with the first live.
    expect((await run('activate', file, '--name', 'second')).code).toBe(0)
    const [archive] = (await readdir(paths().backups)).filter((n) => n.endsWith('pre-activation.tar.gz'))
    const out = join(dir, 'out')
    await mkdir(out)
    await tar.x({ file: join(paths().backups, archive!), cwd: out })
    expect(JSON.parse(await readFile(join(out, 'release.json'), 'utf8'))).toEqual({ id: first.id, name: 'first' })
  })

  it('restores the release onto a fresh data folder, with the pointer', async () => {
    expect((await run('activate', file)).code).toBe(0)
    const [row] = await rows()
    const archive = await backup()

    data = join(dir, 'fresh')
    vi.stubEnv('INLAY_DATA_DIR', data)
    await mkdir(data)
    const result = await restoreBackup({ archive, db: paths().db, media: paths().media, backups: paths().backups })
    expect(result.release).toEqual({ id: row!.id, name: 'test-1', verified: false })
    expect(existsSync(join(paths().releases, `${row!.id}.tgz`))).toBe(true)
    expect(existsSync(join(releaseDir(paths().releases, row!.id), 'site.js'))).toBe(true)
    expect(existsSync(join(releaseDir(paths().releases, row!.id), 'manifest.json'))).toBe(true)
    expect(await readCurrentPointer(paths().releases)).toMatchObject({ id: row!.id, name: 'test-1' })
    expect((await rows())[0]).toMatchObject({ id: row!.id, state: 'current' })
  })

  it('checks the release signature with trusted keys, and the Inlay version always', async () => {
    expect((await run('activate', file)).code).toBe(0)
    const archive = await backup()
    const restoreInto = async (name: string, more: { trustedKeys?: string[]; inlayVersion?: string }) => {
      data = join(dir, name)
      await mkdir(data)
      return restoreBackup({ archive, db: paths().db, media: paths().media, backups: paths().backups, ...more })
    }

    const signed = await restoreInto('signed', { trustedKeys: [keys.publicKey] })
    expect(signed.release?.verified).toBe(true)

    const untrusted = restoreInto('untrusted', { trustedKeys: [generateKeyPair().publicKey] })
    await expect(untrusted).rejects.toMatchObject({ messageId: 'error.backupRelease' })
    await expect(untrusted).rejects.toThrow(/trusted key/)
    expect(existsSync(paths().db)).toBe(false)

    const older = restoreInto('older', { inlayVersion: '0.4.0' })
    await expect(older).rejects.toMatchObject({ messageId: 'error.backupRelease' })
    await expect(older).rejects.toThrow(/0\.4\.0/)
    expect(existsSync(paths().db)).toBe(false)
  })

  it('restore-backup says when it could not check the release signature', async () => {
    expect((await run('activate', file)).code).toBe(0)
    const archive = await backup()
    vi.stubEnv('INLAY_TRUSTED_KEYS', '')
    data = join(dir, 'fresh')
    const r = await run('restore-backup', archive, '--data', data)
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toContain("wasn't checked against a trusted key")
  })

  it('restore-backup says which release it put back', async () => {
    expect((await run('activate', file)).code).toBe(0)
    const archive = await backup()
    await writeFile(
      join(dir, 'inlay.config.ts'),
      `import { site } from '${pathToFileURL(join(fixtures, 'site.ts')).href}'\nexport default { site, db: './fresh/inlay.db' }\n`,
    )
    await mkdir(join(dir, 'fresh'))
    const r = await run('restore-backup', archive)
    // INLAY_DATA_DIR is set too: the config file wins, and the command says so.
    expect(r.err).toBe(t('cli.usingConfig', { file: join(dir, 'inlay.config.ts') }))
    expect(r.code).toBe(0)
    expect(r.out).toContain('test-1')
    expect(r.out).not.toContain("wasn't checked against a trusted key")
    expect(await readCurrentPointer(join(dir, 'fresh/releases'))).toMatchObject({ name: 'test-1' })
  })

  it('restores an archive whose release was tampered with as nothing at all', async () => {
    expect((await run('activate', file)).code).toBe(0)
    const archive = await backup()
    const out = join(dir, 'out')
    await mkdir(out)
    await tar.x({ file: archive, cwd: out })
    await writeFile(join(out, 'release.tgz'), 'not a release')
    const tampered = join(dir, 'tampered.tar.gz')
    await tar.c({ gzip: true, file: tampered, cwd: out }, await readdir(out))

    data = join(dir, 'fresh')
    await mkdir(data)
    await expect(restoreBackup({ archive: tampered, db: paths().db, media: paths().media, backups: paths().backups })).rejects.toThrow(
      /release/,
    )
    expect(existsSync(paths().db)).toBe(false)
    expect(await readCurrentPointer(paths().releases)).toBeNull()
  })

  it('refuses a release.json that names a path', async () => {
    expect((await run('activate', file)).code).toBe(0)
    const archive = await backup()
    const out = join(dir, 'out')
    await mkdir(out)
    await tar.x({ file: archive, cwd: out })
    await writeArchive(join(dir, 'hostile.tar.gz'), [
      { path: 'backup.json', body: await readFile(join(out, 'backup.json')) },
      { path: 'inlay.db', body: await readFile(join(out, 'inlay.db')) },
      { path: 'release.tgz', body: await readFile(join(out, 'release.tgz')) },
      { path: 'release.json', body: JSON.stringify({ id: '../../escape', name: 'x' }) },
    ])
    data = join(dir, 'fresh')
    await mkdir(data)
    await expect(
      restoreBackup({ archive: join(dir, 'hostile.tar.gz'), db: paths().db, media: paths().media, backups: paths().backups }),
    ).rejects.toThrow(/isn't a backup/)
    expect(existsSync(join(dir, 'escape'))).toBe(false)
  })

  it('restores an older archive without a release as before, leaving the releases alone', async () => {
    expect((await run('activate', file)).code).toBe(0)
    const archive = await backup()
    const out = join(dir, 'out')
    await mkdir(out)
    await tar.x({ file: archive, cwd: out })
    const older = join(dir, 'older.tar.gz')
    await tar.c({ gzip: true, file: older, cwd: out }, ['backup.json', 'inlay.db'])

    data = join(dir, 'fresh')
    await mkdir(data)
    const result = await restoreBackup({ archive: older, db: paths().db, media: paths().media, backups: paths().backups })
    expect(result.release).toBeNull()
    expect(existsSync(paths().db)).toBe(true)
    expect(await readCurrentPointer(paths().releases)).toBeNull()
  })
})
