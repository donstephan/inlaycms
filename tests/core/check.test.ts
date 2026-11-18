import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql, type Kysely } from 'kysely'
import { Migrator } from 'kysely/migration'
import { z } from 'zod'
import { bootInlay } from '../../src/core/boot.js'
import { checkDatabase, checkWithoutDatabase } from '../../src/core/check.js'
import { createCore } from '../../src/core/core.js'
import { openDatabase } from '../../src/core/db/connection.js'
import { migrateSystem } from '../../src/core/db/migrate.js'
import * as m0001 from '../../src/core/db/migrations/0001_content.js'
import type { Database } from '../../src/core/db/schema.js'
import { InlayError } from '../../src/core/errors.js'
import { f } from '../../src/core/fields/builtins.js'
import { formatReport, type CheckReport } from '../../src/core/report.js'
import { t } from '../../src/core/messages/index.js'
import { defineContent, defineEntries } from '../../src/core/registry/content.js'
import { defineIntegration } from '../../src/core/registry/integration.js'
import { defineCollection, defineSingleton, defineSite, defineTemplate, type SiteDefinition } from '../../src/core/registry/define.js'
import { articleSite } from '../fixtures/articles.js'
import { redirectSite, rootSite } from '../fixtures/code-redirects.js'
import { png } from '../fixtures/media.js'
import { BasicPage, Post, site } from '../fixtures/site.js'
import { post, shippedSite } from '../fixtures/shipped.js'

async function revisionCount(db: Kysely<Database>): Promise<number> {
  return Number((await db.selectFrom('revisions').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

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

/** Takes the database back to before its newest system migration (0008), so a check has it pending. */
async function dropLastMigration(db: Kysely<Database>): Promise<void> {
  await sql`DROP TABLE integrations`.execute(db)
  await sql`DELETE FROM kysely_migration WHERE name = '0008_integrations'`.execute(db)
}

describe('checkDatabase', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inlay-check-test-'))
    path = join(dir, 'site.db')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('upgrades a snapshot and leaves the given file untouched', async () => {
    const db = openDatabase(path)
    await migrateSystem(db)
    await createCore({ site, db }).applyShippedContent()
    await dropLastMigration(db)
    await db.destroy()

    // A read-write connection removes its -wal and -shm files on close; a readonly one leaves them behind.
    const count = async () => {
      const conn = openDatabase(path)
      try {
        return await revisionCount(conn)
      } finally {
        await conn.destroy()
      }
    }
    const before = { hash: await sha256(path), revisions: await count() }
    const files = await readdir(dir)
    const report = await checkDatabase({ site, db: path })
    expect(await readdir(dir)).toEqual(files)
    expect(report.ok).toBe(true)
    expect(report.problems).toEqual([])
    expect(report.systemMigrations.length).toBeGreaterThan(0)
    expect({ hash: await sha256(path), revisions: await count() }).toEqual(before)
  })

  it('warns about entries whose page a new singleton hides, without failing', async () => {
    const rootPosts = defineSite({
      ...site,
      collections: site.collections.map((c) =>
        c.name === 'posts' ? defineCollection({ name: 'posts', label: 'Posts', template: Post, route: '/:slug' }) : c,
      ),
    })
    const db = openDatabase(path)
    await migrateSystem(db)
    const core = createCore({ site: rootPosts, db })
    await core.applyShippedContent()
    const owner = { actor: { id: 'u', name: 'Olivia Owner', role: 'owner' as const }, source: 'admin' as const }
    await core.createEntry('posts', { slug: 'pricing', fields: { title: 'Our prices', date: '2026-01-01', body: 'b' } }, owner)
    await db.destroy()

    const withPricing = defineSite({
      ...rootPosts,
      singletons: [
        ...rootPosts.singletons,
        defineSingleton({
          name: 'pricing',
          label: 'Pricing',
          template: BasicPage,
          path: '/pricing',
        }),
      ],
      content: [...rootPosts.content, defineContent('pricing', { edition: 1, content: { en: { fields: { title: 'Pricing', body: 'Plans.' } } } })],
    })
    const report = await checkDatabase({ site: withPricing, db: path })
    expect(report.ok).toBe(true)
    expect(report.warnings).toEqual([
      {
        code: 'slug_shadowed',
        message: t('report.slugShadowed', { title: 'Our prices', locale: 'en', slug: 'pricing', path: '/pricing' }),
        document: { id: expect.any(String), type: 'posts', locale: 'en', title: 'Our prices' },
      },
    ])
    expect(formatReport(report)).toContain(t('report.warning', { message: report.warnings[0]!.message }))
    expect((await checkDatabase({ site: rootPosts, db: path })).warnings).toEqual([])
  })

  const owner = { actor: { id: 'u', name: 'Olivia Owner', role: 'owner' as const }, source: 'admin' as const }
  const pageBody = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] }
  const loopSite = () => rootSite([{ from: '/x', to: '/Y' }, { from: '/y', to: '/x' }])

  it('warns about a code rule a published page hides, without failing', async () => {
    const db = openDatabase(path)
    await migrateSystem(db)
    const core = createCore({ site: redirectSite, db })
    await core.applyShippedContent()
    const entry = await core.createEntry('pages', { slug: 'old-post', fields: { title: 'Old post', body: pageBody } }, owner)
    await core.publish([entry.id], owner)
    await db.destroy()

    const report = await checkDatabase({ site: redirectSite, db: path })
    expect(report.ok).toBe(true)
    expect(report.problems).toEqual([])
    expect(report.warnings).toEqual([
      { code: 'redirect_hidden', message: t('report.redirectHidden', { from: '/old-post' }), redirect: { from: '/old-post' } },
    ])
  })

  it('warns about code rules that loop, without failing', async () => {
    const expected = [
      { code: 'redirect_loop', message: t('report.redirectLoop', { from: '/x' }), redirect: { from: '/x' } },
      { code: 'redirect_loop', message: t('report.redirectLoop', { from: '/y' }), redirect: { from: '/y' } },
    ]
    const fresh = join(dir, 'fresh.db')
    await writeFile(fresh, '')
    const onFile = await checkDatabase({ site: loopSite(), db: fresh })
    expect(onFile.ok).toBe(true)
    expect(onFile.warnings).toEqual(expected)
    const without = await checkWithoutDatabase({ site: loopSite() })
    expect(without.ok).toBe(true)
    expect(without.warnings).toEqual(expected)
  })

  it('checks without a database report no hidden rules', async () => {
    // `/about` still fires at `/es/about` (the Spanish page lives at `/es/acerca`), so only `/es/acerca` is hidden.
    const s = rootSite([
      { from: '/about', to: '/blog' },
      { from: '/es/acerca', to: '/blog' },
    ])
    const { db } = await bootInlay({ site: s, db: path, backups: join(dir, 'backups') })
    await db.destroy()
    const onFile = await checkDatabase({ site: s, db: path })
    expect(onFile.warnings.map((w) => [w.code, 'redirect' in w ? w.redirect.from : null])).toEqual([['redirect_hidden', '/es/acerca']])
    expect((await checkWithoutDatabase({ site: s })).warnings).toEqual([])
  })

  it('checks shipped content at an edition already applied, which boot leaves alone', async () => {
    const db = openDatabase(path)
    await migrateSystem(db)
    await createCore({ site, db }).applyShippedContent()
    await db.destroy()

    const about = defineContent('about', { edition: 1, content: { en: { fields: { body: 'No title.' } } } })
    const broken = defineSite({ ...site, content: site.content.map((c) => (c.type === 'about' ? about : c)) })
    const report = await checkDatabase({ site: broken, db: path })
    expect(report.ok).toBe(false)
    expect(report.problems.map((p) => p.code)).toEqual(['shipped_content'])
    expect(report.shipped.created).toEqual([])

    const booted = await bootInlay({ site: broken, db: path, backups: join(dir, 'backups') })
    try {
      expect(booted.report.ok).toBe(true)
      expect(booted.report.problems).toEqual([])
    } finally {
      await booted.db.destroy()
    }
  })

  it.skipIf(process.getuid?.() === 0)('works in a read-only directory', async () => {
    const db = openDatabase(path)
    await migrateSystem(db)
    await createCore({ site, db }).applyShippedContent()
    await db.destroy()

    const files = await readdir(dir)
    await chmod(dir, 0o555)
    try {
      const report = await checkDatabase({ site, db: path })
      expect(report.ok).toBe(true)
      expect(await readdir(dir)).toEqual(files)
    } finally {
      await chmod(dir, 0o755)
    }
  })

  it('lists pending system migrations', async () => {
    const db = openDatabase(path)
    await new Migrator({ db, provider: { getMigrations: async () => ({ '0001_content': m0001 }) } }).migrateToLatest()
    await db.destroy()

    const report = await checkDatabase({ site, db: path })
    expect(report.systemMigrations).toEqual(['0002_media', '0003_redirects', '0004_token_cutoffs', '0005_site_lock', '0006_releases', '0007_published_at', '0008_integrations'])
    expect(report.ok).toBe(true)
  })

  it('imports shipped-content files into a throwaway media directory', async () => {
    const db = openDatabase(path)
    await migrateSystem(db)
    await createCore({ site, db }).applyShippedContent()
    await db.destroy()
    const photo = join(dir, 'team.png')
    await writeFile(photo, await png(40, 20))

    const report = await checkDatabase({ site: teamSite(photo), db: path })
    expect(report.problems).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.shipped.created.map((c) => c.type)).toContain('team')
    expect(existsSync(join(dir, 'media'))).toBe(false)
  })

  it('reports invalid shipped content as a problem', async () => {
    const db = openDatabase(path)
    await migrateSystem(db)
    await db.destroy()

    const invalid = defineSite({ ...site, content: [defineContent('about', { edition: 1, content: { en: { fields: {} } } })] })
    const report = await checkDatabase({ site: invalid, db: path })
    expect(report.ok).toBe(false)
    expect(report.problems.map((p) => p.code)).toEqual(['shipped_content'])
    expect(report.problems[0]!.issues!.length).toBeGreaterThan(0)
  })

  it('reports a shipped slug already taken as a problem, which activation would resolve', async () => {
    const db = openDatabase(path)
    await migrateSystem(db)
    const owner = { actor: { id: 'user-owner', name: 'Olivia Owner', role: 'owner' as const }, source: 'admin' as const }
    await createCore({ site, db }).createEntry('posts', { slug: 'hello', fields: { title: 'Mine', date: '2026-01-01', body: 'Text' } }, owner)
    await db.destroy()

    const report = await checkDatabase({ site: shippedSite([defineEntries('posts', [post('a', {}, 'hello')])]), db: path })
    expect(report.ok).toBe(false)
    expect(report.problems).toEqual([{ code: 'shipped_content', message: expect.stringContaining('hello-2') }])
    expect(report.shipped.warnings).toEqual([])
    expect(formatReport(report).filter((line) => line.includes('hello-2'))).toHaveLength(1)
  })

  it('fails with not_found for a missing file', async () => {
    const e = await checkDatabase({ site, db: join(dir, 'nope.db') }).catch((err: unknown) => err)
    expect(e).toBeInstanceOf(InlayError)
    expect((e as InlayError).code).toBe('not_found')
    expect((e as InlayError).message).toContain('nope.db')
  })
})

describe('formatReport', () => {
  it('lists the issues of a shipped_content problem underneath it', () => {
    const report: CheckReport = {
      ok: false,
      systemMigrations: [],
      shipped: { created: [], replaced: [], skipped: [], deletedRefs: [], warnings: [] },
      warnings: [],
      problems: [
        {
          code: 'shipped_content',
          message: 'The shipped content of "Home" (en) doesn\'t fit the site code.',
          issues: [
            { path: ['fields', 'title'], labels: ['Title'], code: 'required', message: 'Title is required.' },
            { path: ['slots', 'hero', 'data', 'headline'], labels: ['Hero', 'Headline'], code: 'too_long', message: 'Headline is too long.' },
          ],
        },
      ],
    }
    expect(formatReport(report)).toEqual([
      t('report.problem', { message: 'The shipped content of "Home" (en) doesn\'t fit the site code.' }),
      t('report.issue', { message: 'Title is required.' }),
      t('report.issue', { message: 'Headline is too long.' }),
    ])
    const [problem, issue] = formatReport(report)
    expect(issue!.startsWith(' ')).toBe(true)
    expect(problem!.startsWith(' ')).toBe(false)
  })

  it('summarizes what was done', () => {
    const lines = formatReport({
      ok: true,
      systemMigrations: ['0002_media'],
      shipped: { created: [], replaced: [], skipped: [], deletedRefs: [], warnings: [] },
      problems: [],
      warnings: [],
    })
    expect(lines).toEqual([t('report.systemMigrations', { names: '0002_media' })])
  })

  it('has a line for each kind of shipped-content change', () => {
    const item = { documentId: 'd', type: 'home', key: 'home', locale: 'en', edition: 2 }
    const lines = formatReport({
      ok: true,
      systemMigrations: [],
      shipped: {
        created: [item, item],
        replaced: [item],
        skipped: [item],
        deletedRefs: [{ item, target: { type: 'testimonials', key: 'maria' }, field: 'Testimonials › Items' }],
        warnings: [{ item, message: 'Slug taken.' }],
      },
      problems: [],
      warnings: [],
    })
    expect(lines).toEqual([
      t('report.shippedCreated', { count: 2 }),
      t('report.shippedReplaced', { count: 1 }),
      t('report.shippedSkipped', { count: 1 }),
      t('report.shippedDeletedRefs', {
        type: 'home',
        key: 'home',
        locale: 'en',
        field: 'Testimonials › Items',
        targetType: 'testimonials',
        targetKey: 'maria',
      }),
      t('report.warning', { message: 'Slug taken.' }),
    ])
  })
})

describe('integration policy warnings', () => {
  const base = { locales: ['en'], defaultLocale: 'en' }
  const integration = (csp: Parameters<typeof defineIntegration>[0]['csp'] = {}) =>
    defineIntegration({ name: 'gtm', label: 'Tag Manager', csp, head: () => null })

  it('warns about unsafe-inline', async () => {
    const report = await checkWithoutDatabase({ site: defineSite({ ...base, integrations: [integration({ 'script-src': ["'unsafe-inline'"] })] }) })
    expect(report.ok).toBe(true)
    expect(report.warnings.map((w) => w.code)).toEqual(['csp_unsafe_inline'])
  })

  it('warns about unsafe-eval', async () => {
    const report = await checkWithoutDatabase({ site: defineSite({ ...base, integrations: [integration({ 'script-src': ["'unsafe-eval'"] })] }) })
    expect(report.ok).toBe(true)
    expect(report.warnings.map((w) => w.code)).toEqual(['csp_unsafe_eval'])
  })

  it.each(['https:', 'http:', 'data:', 'blob:'])('warns about the scheme source %s for scripts', async (scheme) => {
    const report = await checkWithoutDatabase({ site: defineSite({ ...base, integrations: [integration({ 'script-src': [scheme] })] }) })
    expect(report.ok).toBe(true)
    expect(report.warnings).toEqual([
      { code: 'csp_script_scheme', message: t('report.cspScriptScheme', { owner: t('definition.cspOwnerIntegration', { name: 'gtm' }), source: scheme }) },
    ])
  })

  it('does not warn about a scheme source outside script-src, or about an origin', async () => {
    const report = await checkWithoutDatabase({
      site: defineSite({ ...base, csp: { 'img-src': ['https:', 'data:'] }, integrations: [integration({ 'script-src': ['https://tags.example'] })] }),
    })
    expect(report.warnings).toEqual([])
  })

  it('names the integration or the site that asks for it', async () => {
    const report = await checkWithoutDatabase({
      site: defineSite({ ...base, csp: { 'script-src': ["'unsafe-eval'"] }, integrations: [integration({ 'script-src': ["'unsafe-inline'"] })] }),
    })
    expect(report.warnings.map((w) => w.message)).toEqual([
      t('report.cspUnsafeEval', { owner: t('definition.cspOwnerSite') }),
      t('report.cspUnsafeInline', { owner: t('definition.cspOwnerIntegration', { name: 'gtm' }) }),
    ])
    expect(report.warnings[1]?.message).toMatch(/^The integration "gtm" allows/)
  })

  it('warns when the site overrides the policy', async () => {
    const headers = { 'content-security-policy': "default-src 'self'" }
    const withOne = await checkWithoutDatabase({ site: defineSite({ ...base, headers, integrations: [integration()] }) })
    expect(withOne.warnings.map((w) => w.code)).toEqual(['csp_overridden'])
    const none = await checkWithoutDatabase({ site: defineSite({ ...base, headers }) })
    expect(none.warnings).toEqual([])
  })
})
