import { existsSync, readdirSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import Fastify from 'fastify'
import { sql, type Kysely } from 'kysely'
import { inlay } from '../../src/adapters/site/plugin.js'
import { listBackups } from '../../src/core/backup/backup.js'
import { bootInlay } from '../../src/core/boot.js'
import { openDatabase } from '../../src/core/db/connection.js'
import { migrateSystem } from '../../src/core/db/migrate.js'
import type { Database } from '../../src/core/db/schema.js'
import { InlayError } from '../../src/core/errors.js'
import { generateKeyPair } from '../../src/core/release/keys.js'
import { packRelease } from '../../src/core/release/pack.js'
import { loadRelease } from '../../src/core/release/read.js'
import { inlayVersion } from '../../src/core/version.js'
import { activateRelease, summarize } from '../../src/host/activate.js'
import { deleteRelease, getRelease, readCurrentPointer, releaseDir, storeRelease, type ReleaseRow } from '../../src/host/store.js'
import { appOptions } from '../helpers/app.js'
import { png } from '../fixtures/media.js'
import { shippedSite } from '../fixtures/shipped.js'

const fixtures = resolve(import.meta.dirname, '../fixtures')

async function rejection(p: Promise<unknown>): Promise<InlayError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(InlayError)
    return e as InlayError
  }
  throw new Error('expected a rejection')
}

const contentTs = (edition: number, title: string) => `import { defineContent } from 'inlaycms/site'

export const content = [
  defineContent('home', {
    edition: ${edition},
    content: {
      en: { fields: { title: ${JSON.stringify(title)}, picture: { file: new URL('./assets/pic.png', import.meta.url), alt: 'A picture' } } },
    },
  }),
]
`

const siteTs = (migrations: string) => `import { defineMigration, defineRoute, defineSingleton, defineSite, defineTemplate, f, z } from 'inlaycms/site'
import { content } from './content.js'

const Home = defineTemplate({
  name: 'home',
  fields: z.object({ title: f.text({ label: 'Title' }), picture: f.image({ label: 'Picture' }) }),
})

export const site = defineSite({
  locales: ['en'],
  defaultLocale: 'en',
  singletons: [defineSingleton({ name: 'home', label: 'Home', template: Home, path: '/' })],
  secrets: ['HOOK'],
  routes: [defineRoute({ method: 'GET', path: '/ping', handler: () => ({ json: { ok: true } }) })],
  content,
  migrations: [${migrations}],
})
`

/** Edition 1, a migration function that changes nothing. */
const FIRST = `defineMigration({ name: 'first-note', run: async () => {} })`

/** Edition 2, a migration function that adds "!" to the home title and publishes it. */
const SHOUT = `defineMigration({
    name: 'shout-title',
    run: async (ctx) => {
      for (const doc of await ctx.list('home')) {
        const { head } = await ctx.read(doc.id)
        await ctx.save(doc.id, { ...head, fields: { ...head.fields, title: head.fields.title + '!' } })
        await ctx.publish([doc.id])
      }
    },
  })`

/** Edition 3, a migration function that writes a draft and then throws. */
const EXPLODE = `defineMigration({
    name: 'explode',
    run: async (ctx) => {
      const [doc] = await ctx.list('home')
      const { head } = await ctx.read(doc.id)
      await ctx.save(doc.id, { ...head, fields: { ...head.fields, title: 'Half done' } })
      throw new Error('boom')
    },
  })`

let packDir: string
let keys: { privateKey: string; publicKey: string }
const files: Record<'a' | 'b' | 'bad', string> = { a: '', b: '', bad: '' }

async function packVariant(name: string, edition: number, title: string, migrations: string): Promise<string> {
  const siteDir = join(packDir, name)
  await cp(join(fixtures, 'release'), siteDir, { recursive: true })
  await mkdir(join(siteDir, 'assets'))
  await writeFile(join(siteDir, 'assets/pic.png'), await png(20, 10))
  await writeFile(join(siteDir, 'content.ts'), contentTs(edition, title))
  await writeFile(join(siteDir, 'site.ts'), siteTs(migrations))
  const out = join(packDir, `${name}.tgz`)
  await packRelease({ configFile: join(siteDir, 'inlay.config.ts'), privateKey: keys.privateKey, out, name })
  return out
}

beforeAll(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'inlay-activate-pack-'))
  keys = generateKeyPair()
  files.a = await packVariant('release-a', 1, 'Hello', FIRST)
  files.b = await packVariant('release-b', 2, 'Hello again', SHOUT)
  files.bad = await packVariant('release-bad', 3, 'Never', EXPLODE)
})
afterAll(() => rm(packDir, { recursive: true, force: true }))

let dir: string
let releasesDir: string
let backupsDir: string
let mediaDir: string
let db: Kysely<Database>
let clock: number
const now = () => new Date(Date.UTC(2026, 10, 4, 12, 0, clock++))
const withHook = (names: readonly string[]) => Object.fromEntries(names.map((n) => [n, 'hook-value']))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inlay-activate-'))
  releasesDir = join(dir, 'releases')
  backupsDir = join(dir, 'backups')
  mediaDir = join(dir, 'media')
  await mkdir(releasesDir)
  db = openDatabase(join(dir, 'inlay.db'))
  await migrateSystem(db)
  clock = 0
})
afterEach(async () => {
  await db.destroy()
  await rm(dir, { recursive: true, force: true })
})

const store = (which: keyof typeof files) =>
  storeRelease({ db, releasesDir, trustedKeys: [keys.publicKey], now }, files[which], { pushedBy: null })

async function activate(row: ReleaseRow, secretsEnv: (names: readonly string[]) => Record<string, string> = withHook) {
  const loaded = await loadRelease(releaseDir(releasesDir, row.id))
  return activateRelease({ db, loaded, releasesDir, backupsDir, mediaDir, secretsEnv, now }, row.id)
}

/** Every row of every table, to compare the whole database before and after. */
async function dump(): Promise<Record<string, unknown[]>> {
  const { rows: tables } = await sql<{ name: string }>`
    select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name
  `.execute(db)
  const out: Record<string, unknown[]> = {}
  for (const { name } of tables) out[name] = (await sql`select * from ${sql.table(name)} order by rowid`.execute(db)).rows
  return out
}

async function home(): Promise<{ edition: number | null; published: string; head: string }> {
  const doc = await db.selectFrom('documents').selectAll().where('type', '=', 'home').executeTakeFirstOrThrow()
  const title = async (id: number | null) => {
    const rev = await db.selectFrom('revisions').select('data').where('id', '=', id!).executeTakeFirstOrThrow()
    return (JSON.parse(rev.data) as { fields: { title: string } }).fields.title
  }
  return { edition: doc.edition, published: await title(doc.published_rev), head: await title(doc.head_rev) }
}

const revisionCount = async () =>
  (await db.selectFrom('revisions').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n

describe('activateRelease', () => {
  it('first activation creates shipped content, runs migrations, sets current and writes the pointer, without a backup', async () => {
    const a = await store('a')
    const result = await activate(a)
    expect(result.noop).toBe(false)
    expect(result.backup).toBeNull()
    expect(result.previous).toBeNull()
    expect(result.shipped.created.map((i) => [i.type, i.key, i.edition])).toEqual([['home', 'home', 1]])
    expect(result.migrations).toEqual(['first-note'])
    expect(result.release).toMatchObject({ id: a.id, state: 'current', activated_at: expect.any(String) })
    expect(await home()).toEqual({ edition: 1, published: 'Hello', head: 'Hello' })
    expect(await db.selectFrom('media').select('filename').execute()).toHaveLength(1)
    expect(await db.selectFrom('release_migrations').select(['release_id', 'name']).execute()).toEqual([
      { release_id: a.id, name: 'first-note' },
    ])
    expect(await readCurrentPointer(releasesDir)).toEqual({ id: a.id, name: 'release-a', activatedAt: result.release.activated_at })
    expect(await listBackups(backupsDir)).toEqual([])
  })

  it('second activation replaces by edition, runs only its functions, backs up first and marks the previous release', async () => {
    const a = await store('a')
    const b = await store('b')
    await activate(a)
    const result = await activate(b)
    expect(result.noop).toBe(false)
    expect(result.shipped.replaced.map((i) => [i.key, i.edition])).toEqual([['home', 2]])
    expect(result.shipped.created).toEqual([])
    expect(result.migrations).toEqual(['shout-title'])
    expect(result.backup?.reason).toBe('pre-activation')
    expect((await listBackups(backupsDir)).map((x) => x.reason)).toEqual(['pre-activation'])
    expect(result.previous).toMatchObject({ id: a.id, state: 'previous', deactivated_at: expect.any(String) })
    expect(await getRelease(db, a.id)).toMatchObject({ state: 'previous' })
    expect(result.release).toMatchObject({ id: b.id, state: 'current' })
    expect(await home()).toEqual({ edition: 2, published: 'Hello again!', head: 'Hello again!' })
    const revisions = await db.selectFrom('revisions').select(['source', 'release_id']).orderBy('id').execute()
    // Release a: its shipped home. Release b: its shipped home, then the migration function's save.
    expect(revisions).toEqual([
      { source: 'release', release_id: a.id },
      { source: 'release', release_id: b.id },
      { source: 'release', release_id: b.id },
    ])
    const events = await db.selectFrom('publish_events').selectAll().execute()
    expect(events.every((e) => e.source === 'release')).toBe(true)
    expect((await readCurrentPointer(releasesDir))?.id).toBe(b.id)
  })

  it('a throwing migration function changes nothing', async () => {
    const a = await store('a')
    const bad = await store('bad')
    await activate(a)
    const pointer = await readFile(join(releasesDir, 'current.json'), 'utf8')
    const before = await dump()
    const e = await rejection(activate(bad))
    expect(e.code).toBe('release')
    expect(e.messageId).toBe('error.releaseMigration')
    expect(e.params).toMatchObject({ name: 'explode', problem: 'boom' })
    expect(e.message).toContain('explode')
    expect(await dump()).toEqual(before)
    expect(await readFile(join(releasesDir, 'current.json'), 'utf8')).toBe(pointer)
    expect(await getRelease(db, bad.id)).toMatchObject({ state: 'staged' })
    expect(await home()).toEqual({ edition: 1, published: 'Hello', head: 'Hello' })
  })

  it('a rolled-back activation removes the media files it stored, and only those', async () => {
    const bad = await store('bad')
    await rejection(activate(bad))
    expect(await db.selectFrom('media').select('id').execute()).toEqual([])
    expect((await readdir(mediaDir).catch(() => [])).filter((n) => !n.startsWith('.'))).toEqual([])

    const a = await store('a')
    await activate(a)
    const [kept] = await db.selectFrom('media').select('id').execute()
    await rejection(activate(bad))
    expect(existsSync(join(mediaDir, kept!.id))).toBe(true)
  })

  it('refuses a release for another version of Inlay before the backup', async () => {
    const a = await store('a')
    const b = await store('b')
    await activate(a)
    await db.updateTable('releases').set({ inlay_range: '^99.0.0' }).where('id', '=', b.id).execute()
    const before = await dump()
    const e = await rejection(activate(b))
    expect(e.messageId).toBe('error.releaseTooNew')
    expect(e.params).toEqual({ packed: '99.0.0', version: inlayVersion() })
    expect(await listBackups(backupsDir)).toEqual([])
    expect(await dump()).toEqual(before)
  })

  it('refuses a previous release packed with a version older than the oldest supported before the backup', async () => {
    const a = await store('a')
    const b = await store('b')
    await activate(a)
    await db.updateTable('releases').set({ inlay_range: '^0.4.1' }).where('id', '=', b.id).execute()
    const before = await dump()
    const e = await rejection(activate(b))
    expect(e.messageId).toBe('error.releaseTooOld')
    expect(e.params).toEqual({ packed: '0.4.1', version: inlayVersion(), oldest: '0.5.0' })
    expect(await listBackups(backupsDir)).toEqual([])
    expect(await dump()).toEqual(before)
  })

  it('re-activating the current release changes nothing', async () => {
    const a = await store('a')
    const b = await store('b')
    await activate(a)
    await activate(b)
    const backups = await listBackups(backupsDir)
    const pointer = await readFile(join(releasesDir, 'current.json'), 'utf8')
    const before = await dump()
    const result = await activate(b)
    expect(result.noop).toBe(true)
    expect(result.backup).toBeNull()
    expect(result.migrations).toEqual([])
    expect(result.shipped).toEqual({ created: [], replaced: [], skipped: [], deletedRefs: [], warnings: [] })
    expect(result.release.id).toBe(b.id)
    expect(await dump()).toEqual(before)
    expect(await listBackups(backupsDir)).toEqual(backups)
    expect(await readFile(join(releasesDir, 'current.json'), 'utf8')).toBe(pointer)
  })

  it('rolling back leaves higher editions alone and does not rerun functions', async () => {
    const a = await store('a')
    const b = await store('b')
    await activate(a)
    await activate(b)
    const revisions = await revisionCount()
    const back = await activate(a)
    expect(back.shipped.created).toEqual([])
    expect(back.shipped.replaced).toEqual([])
    expect(back.migrations).toEqual([])
    expect(back.previous).toMatchObject({ id: b.id, state: 'previous' })
    expect(await home()).toEqual({ edition: 2, published: 'Hello again!', head: 'Hello again!' })
    expect(await revisionCount()).toBe(revisions)
    const forward = await activate(b)
    expect(forward.migrations).toEqual([])
    expect(forward.shipped.replaced).toEqual([])
    expect(await home()).toEqual({ edition: 2, published: 'Hello again!', head: 'Hello again!' })
    expect(await revisionCount()).toBe(revisions)
    expect((await readCurrentPointer(releasesDir))?.id).toBe(b.id)
  })

  it('refuses a missing secret before the backup', async () => {
    const a = await store('a')
    const b = await store('b')
    await activate(a)
    const before = await dump()
    const e = await rejection(activate(b, () => ({})))
    expect(e.messageId).toBe('error.releaseSecret')
    expect(e.params).toEqual({ name: 'HOOK' })
    expect(e.message).toContain('HOOK')
    expect(await listBackups(backupsDir)).toEqual([])
    expect(await dump()).toEqual(before)
  })

  it('an empty secret is present', async () => {
    const a = await store('a')
    const result = await activate(a, (names) => Object.fromEntries(names.map((n) => [n, ''])))
    expect(result.release.state).toBe('current')
  })

  it('takes the write lock first: a commit from another connection mid-activation waits, it never fails the activation', async () => {
    const a = await store('a')
    // The live worker's connection, as better-sqlite3 runs it: synchronously, here without waiting for locks.
    const other = new BetterSqlite3(join(dir, 'inlay.db'), { timeout: 0 })
    other.exec('create table probe (v integer)')
    const touch = () => other.prepare('insert into probe (v) values (1)').run()
    const seen: { commit: string; media: string[] }[] = []
    // The first clock reading is inside the transaction, after its reads and before its first write: without the
    // lock taken first, a commit here makes that write fail with SQLITE_BUSY_SNAPSHOT.
    const during = () => {
      if (seen.length === 0) {
        let commit = 'committed'
        try {
          touch()
        } catch (e) {
          commit = (e as { code?: string }).code ?? String(e)
        }
        seen.push({ commit, media: readdirSync(mediaDir).filter((n) => !n.startsWith('.')) })
      }
      return now()
    }
    try {
      const loaded = await loadRelease(releaseDir(releasesDir, a.id))
      const result = await activateRelease({ db, loaded, releasesDir, backupsDir, mediaDir, secretsEnv: withHook, now: during }, a.id)
      expect(result.release.state).toBe('current')
      expect(seen).toHaveLength(1)
      expect(seen[0]!.commit).toBe('SQLITE_BUSY')
      // The shipped files were stored before the transaction took the lock.
      expect(seen[0]!.media).toHaveLength(1)
      // Once the activation committed, the other connection writes again.
      expect(touch().changes).toBe(1)
    } finally {
      other.close()
    }
  })

  it('refuses a release for another version of Inlay even when it is already current', async () => {
    const a = await store('a')
    await activate(a)
    await db.updateTable('releases').set({ inlay_range: '^99.0.0' }).where('id', '=', a.id).execute()
    const e = await rejection(activate(a))
    expect(e.messageId).toBe('error.releaseTooNew')
    expect(e.params).toEqual({ packed: '99.0.0', version: inlayVersion() })
  })

  it('a pointer that cannot be written after the commit is reported, not thrown, and repaired by a retry', async () => {
    const a = await store('a')
    // A folder in the pointer's place: the rename onto it fails.
    await mkdir(join(releasesDir, 'current.json', 'blocked'), { recursive: true })
    const result = await activate(a)
    expect(result.noop).toBe(false)
    expect(result.pointerError).toEqual(expect.any(String))
    expect(await getRelease(db, a.id)).toMatchObject({ state: 'current' })
    expect(summarize(result).shipped.created).toBe(1)
    expect((await readdir(releasesDir)).filter((n) => n.includes('.tmp'))).toEqual([])

    await rm(join(releasesDir, 'current.json'), { recursive: true })
    const retry = await activate(a)
    expect(retry.noop).toBe(true)
    expect(retry.pointerError).toBeNull()
    expect((await readCurrentPointer(releasesDir))?.id).toBe(a.id)
  })

  it('refuses to run inside a transaction', async () => {
    const a = await store('a')
    const loaded = await loadRelease(releaseDir(releasesDir, a.id))
    const e = await rejection(
      db.transaction().execute((trx) =>
        activateRelease({ db: trx, loaded, releasesDir, backupsDir, mediaDir, secretsEnv: withHook, now }, a.id),
      ),
    )
    expect(e.messageId).toBe('error.transactionWrite')
    expect(await getRelease(db, a.id)).toMatchObject({ state: 'staged' })
  })

  it('refuses an unknown or deleted release', async () => {
    const a = await store('a')
    const loaded = await loadRelease(releaseDir(releasesDir, a.id))
    const deps = { db, loaded, releasesDir, backupsDir, mediaDir, secretsEnv: withHook, now }
    expect((await rejection(activateRelease(deps, 'nope'))).messageId).toBe('error.releaseUnknown')
    await deleteRelease({ db, releasesDir }, a.id)
    const e = await rejection(activateRelease(deps, a.id))
    expect(e.messageId).toBe('error.releaseDeleted')
    expect(e.params).toEqual({ name: 'release-a' })
    expect(existsSync(join(releasesDir, 'current.json'))).toBe(false)
  })
})

describe("content: 'none'", () => {
  it('boot leaves content alone', async () => {
    const opts = { site: shippedSite(), backups: backupsDir, media: mediaDir }
    const none = await bootInlay({ ...opts, db: join(dir, 'none.db'), content: 'none' })
    try {
      expect(none.report.shipped.created).toEqual([])
      expect(await none.db.selectFrom('documents').select('id').execute()).toEqual([])
    } finally {
      await none.db.destroy()
    }
    const apply = await bootInlay({ ...opts, db: join(dir, 'apply.db') })
    try {
      expect(apply.report.shipped.created.length).toBeGreaterThan(0)
      const revisions = await apply.db.selectFrom('revisions').select(['source', 'release_id']).execute()
      expect(revisions.length).toBeGreaterThan(0)
      expect(revisions.every((r) => r.source === 'release' && r.release_id === null)).toBe(true)
    } finally {
      await apply.db.destroy()
    }
  })

  it('the plugin passes it through', async () => {
    const none = Fastify()
    await none.register(inlay, await appOptions({ content: 'none' }))
    const apply = Fastify()
    await apply.register(inlay, await appOptions())
    try {
      expect(await none.inlay.core.findSingleton('home')).toBeNull()
      expect(await apply.inlay.core.findSingleton('home')).not.toBeNull()
    } finally {
      await none.close()
      await apply.close()
    }
  })
})
