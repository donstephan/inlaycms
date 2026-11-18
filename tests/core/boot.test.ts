import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql, type Kysely } from 'kysely'
import { Migrator } from 'kysely/migration'
import { z } from 'zod'
import { bootInlay, type BootOptions } from '../../src/core/boot.js'
import { openDatabase } from '../../src/core/db/connection.js'
import * as m0001 from '../../src/core/db/migrations/0001_content.js'
import type { Database } from '../../src/core/db/schema.js'
import { InlayError } from '../../src/core/errors.js'
import { f } from '../../src/core/fields/builtins.js'
import { defineContent } from '../../src/core/registry/content.js'
import { defineSingleton, defineSite, defineTemplate, type SiteDefinition } from '../../src/core/registry/define.js'
import type { Ctx } from '../../src/core/types.js'
import { postSummarySite } from '../fixtures/evolve.js'
import { site } from '../fixtures/site.js'
import { articleSite } from '../fixtures/articles.js'
import { rootSite } from '../fixtures/code-redirects.js'
import { png, sha256 } from '../fixtures/media.js'

const TeamPage = defineTemplate({
  name: 'teamPage',
  label: 'Team page',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    photo: f.image({ label: 'Photo' }),
    intro: f.richText({ label: 'Intro' }),
  }),
})

const teamSite = (photo: string): SiteDefinition =>
  defineSite({
    ...articleSite,
    singletons: [
      ...articleSite.singletons,
      defineSingleton({
        name: 'team',
        label: 'Team',
        template: TeamPage,
        path: '/team',
      }),
    ],
    content: [
      ...articleSite.content,
      defineContent('team', {
        edition: 1,
        content: { en: { fields: { title: 'Team', photo: { file: photo, alt: 'Our team' }, intro: '## Hello\n\nWe **build** sites.' } } },
      }),
    ],
  })

async function rejection(p: Promise<unknown>): Promise<InlayError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(InlayError)
    return e as InlayError
  }
  throw new Error('expected a rejection')
}

async function revisionCount(db: Kysely<Database>): Promise<number> {
  return Number((await db.selectFrom('revisions').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)
}

describe('bootInlay', () => {
  let dir: string
  let opts: (s: SiteDefinition) => BootOptions
  const open: Array<Kysely<Database>> = []

  async function boot(s: SiteDefinition) {
    const result = await bootInlay(opts(s))
    open.push(result.db)
    return result
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inlay-boot-'))
    opts = (s) => ({ site: s, db: join(dir, 'site.db'), backups: join(dir, 'backups') })
  })

  afterEach(async () => {
    for (const db of open.splice(0)) await db.destroy()
    await rm(dir, { recursive: true, force: true })
  })

  it('creates a missing database and publishes the shipped content', async () => {
    const { core, report, backup } = await boot(site)
    expect(existsSync(join(dir, 'site.db'))).toBe(true)
    expect(backup).toBeNull()
    expect(report.ok).toBe(true)
    expect(report.systemMigrations).toEqual(['0001_content', '0002_media', '0003_redirects', '0004_token_cutoffs', '0005_site_lock', '0006_releases', '0007_published_at', '0008_integrations'])
    expect(report.shipped.created.length).toBeGreaterThan(0)
    const home = (await core.findSingleton('home'))!
    expect(home.publishedRev).not.toBeNull()
    expect(existsSync(join(dir, 'backups'))).toBe(false)
  })

  it('does nothing when booted again with the same site', async () => {
    const first = await boot(site)
    const revisions = await revisionCount(first.db)
    await first.db.destroy()
    open.splice(0)

    const { db, report, backup } = await boot(site)
    expect(backup).toBeNull()
    expect(report.ok).toBe(true)
    expect(report.systemMigrations).toEqual([])
    expect(report.shipped).toEqual({ created: [], replaced: [], skipped: [], deletedRefs: [], warnings: [] })
    expect(await revisionCount(db)).toBe(revisions)
  })

  /** A database with only the first system migration run, so boot has system migrations to run. */
  async function staleDatabase(opts: { blocked?: boolean } = {}) {
    const db = openDatabase(join(dir, 'site.db'))
    await new Migrator({ db, provider: { getMigrations: async () => ({ '0001_content': m0001 }) } }).migrateToLatest()
    // A table the next system migration creates, so it fails before any pending one is recorded.
    if (opts.blocked) await sql`CREATE TABLE media (id TEXT)`.execute(db)
    await db.destroy()
  }

  it('backs up, then runs pending system migrations', async () => {
    await staleDatabase()

    const { report, backup } = await boot(site)
    expect(backup).not.toBeNull()
    expect(backup!.reason).toBe('pre-migration')
    const files = await readdir(join(dir, 'backups'))
    expect(files).toHaveLength(1)
    expect(files[0]!.endsWith('-pre-migration.tar.gz')).toBe(true)
    expect(report.ok).toBe(true)
    expect(report.systemMigrations.length).toBeGreaterThan(0)
    expect(report.systemMigrations).not.toContain('0001_content')
  })

  it('boots a database saved under a different schema without touching content', async () => {
    const first = await boot(site)
    const editor: Ctx = { actor: { id: 'user-editor', name: 'Eddie Editor', role: 'editor' }, source: 'admin' }
    const post = await first.core.createEntry('posts', { fields: { title: 'Hello', date: '2026-02-01', body: 'Hi' } }, editor)
    await first.core.publish([post.id], editor)
    const revisions = await revisionCount(first.db)
    await first.db.destroy()
    open.splice(0)

    const { core, db, report, backup } = await boot(postSummarySite)
    expect(report.ok).toBe(true)
    expect(report.problems).toEqual([])
    expect(backup).toBeNull()
    expect(await revisionCount(db)).toBe(revisions)
    expect((await core.listGaps()).map((g) => g.document.id)).toEqual([post.id])
  })

  it('makes one pre-migration backup however many times a failing boot is retried', async () => {
    await staleDatabase({ blocked: true })

    await expect(bootInlay(opts(site))).rejects.toThrow()
    await expect(bootInlay(opts(site))).rejects.toThrow()

    const files = await readdir(join(dir, 'backups'))
    expect(files.filter((f) => f.endsWith('-pre-migration.tar.gz'))).toHaveLength(1)
  })

  it('makes a new pre-migration backup once the database has changed since the last one', async () => {
    let clock = Date.parse('2026-10-28T10:00:00Z')
    const now = () => new Date((clock += 60_000))
    await staleDatabase({ blocked: true })

    await expect(bootInlay({ ...opts(site), now })).rejects.toThrow()
    await utimes(join(dir, 'site.db'), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))

    await expect(bootInlay({ ...opts(site), now })).rejects.toThrow()
    const files = await readdir(join(dir, 'backups'))
    expect(files.filter((f) => f.endsWith('-pre-migration.tar.gz'))).toHaveLength(2)
  })

  it('refuses to boot when the shipped content is invalid', async () => {
    const home = site.content.find((c) => c.type === 'home')!.documents[0]!
    const invalid = defineSite({
      ...site,
      content: site.content.map((c) =>
        c.type === 'home' ? defineContent('home', { edition: 1, content: { en: { ...home.content.en, fields: {} } } }) : c,
      ),
    })
    const e = await rejection(bootInlay(opts(invalid)))
    expect(e.code).toBe('check_failed')
    const problems = e.details.problems!
    expect(problems.map((p) => p.code)).toEqual(['shipped_content'])
    expect(problems[0]!.issues!.length).toBeGreaterThan(0)
  })

  it('boots with code-rule warnings', async () => {
    const { report } = await boot(rootSite([{ from: '/x', to: '/Y' }, { from: '/y', to: '/x' }]))
    expect(report.warnings.map((w) => w.code)).toEqual(['redirect_loop', 'redirect_loop'])
  })

  it('imports shipped-content files into the media directory', async () => {
    const photo = join(dir, 'team.png')
    const bytes = await png(40, 20)
    await writeFile(photo, bytes)
    const media = join(dir, 'media')
    const result = await bootInlay({ ...opts(teamSite(photo)), media })
    open.push(result.db)
    expect(existsSync(join(media, sha256(bytes)))).toBe(true)
  })
})
