import type { Kysely } from 'kysely'
import { systemCtx } from '../../src/core/auth/roles.js'
import { createCore } from '../../src/core/core.js'
import type { Database } from '../../src/core/db/schema.js'
import { InlayError } from '../../src/core/errors.js'
import { defineSite } from '../../src/core/registry/define.js'
import { defineMigration, type MigrationContext } from '../../src/core/registry/migration.js'
import { buildRegistry } from '../../src/core/registry/registry.js'
import { runReleaseMigrations } from '../../src/core/content/release-migrations.js'
import type { DocumentData } from '../../src/core/types.js'
import { makeCore } from '../helpers/core.js'
import { noTestimonialsSite } from '../fixtures/evolve.js'
import { shippedSite } from '../fixtures/shipped.js'

async function insertRelease(db: Kysely<Database>, id: string): Promise<void> {
  await db
    .insertInto('releases')
    .values({
      id,
      name: id,
      state: 'staged',
      file: `${id}.tar.gz`,
      checksum: 'x',
      signed_by: 'key',
      inlay_range: '*',
      secrets: '[]',
      schema: '{}',
      pushed_by: null,
      pushed_at: '2026-01-01T00:00:00.000Z',
      activated_at: null,
      deactivated_at: null,
    })
    .execute()
}

async function setup() {
  const made = await makeCore({ site: shippedSite() })
  await made.core.applyShippedContent()
  await insertRelease(made.db, 'r1')
  return made
}

const countEntries = async (db: Kysely<Database>) =>
  (await db.selectFrom('documents').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n

describe('release migrations', () => {
  it('runs functions in order, once, and records them', async () => {
    const { core, db } = await setup()
    const ran: string[] = []
    const migrations = [
      defineMigration({ name: 'first', run: async () => void ran.push('first') }),
      defineMigration({ name: 'second', run: async () => void ran.push('second') }),
    ]
    expect(await core.runReleaseMigrations('r1', migrations)).toEqual(['first', 'second'])
    expect(ran).toEqual(['first', 'second'])
    expect(await core.runReleaseMigrations('r1', migrations)).toEqual([])
    expect(ran).toEqual(['first', 'second'])
    const rows = await db.selectFrom('release_migrations').selectAll().orderBy('ran_at').execute()
    expect(rows.map((r) => [r.release_id, r.name])).toEqual([
      ['r1', 'first'],
      ['r1', 'second'],
    ])
    expect(rows.every((r) => typeof r.ran_at === 'string' && r.ran_at.length > 0)).toBe(true)
  })

  it('a throwing function leaves nothing behind', async () => {
    const { core, db } = await setup()
    const before = await countEntries(db)
    const revisions = await db.selectFrom('revisions').select('id').execute()
    let fail = true
    const ran: string[] = []
    const migrations = [
      defineMigration({
        name: 'create',
        run: async (ctx) => {
          ran.push('create')
          await ctx.create('posts', { fields: { title: 'From a release', date: '2026-01-01', body: 'Text' } })
        },
      }),
      defineMigration({
        name: 'boom',
        run: async () => {
          ran.push('boom')
          if (fail) throw new Error('boom')
        },
      }),
    ]
    await expect(core.runReleaseMigrations('r1', migrations)).rejects.toThrow('boom')
    expect(await db.selectFrom('release_migrations').selectAll().execute()).toHaveLength(0)
    expect(await countEntries(db)).toBe(before)
    expect(await db.selectFrom('revisions').select('id').execute()).toHaveLength(revisions.length)
    fail = false
    expect(await core.runReleaseMigrations('r1', migrations)).toEqual(['create', 'boom'])
    expect(ran).toEqual(['create', 'boom', 'create', 'boom'])
    expect(await countEntries(db)).toBe(before + 1)
  })

  it('writes carry source release and the release id', async () => {
    const { core, db } = await setup()
    const home = (await core.findSingleton('home'))!
    await core.runReleaseMigrations('r1', [
      defineMigration({
        name: 'retitle',
        run: async (ctx) => {
          const { head } = await ctx.read(home.id)
          await ctx.save(home.id, { ...head!, fields: { ...head!.fields, title: 'Start' } })
          await ctx.publish([home.id])
        },
      }),
    ])
    const doc = await db.selectFrom('documents').selectAll().where('id', '=', home.id).executeTakeFirstOrThrow()
    expect(doc.published_rev).toBe(doc.head_rev)
    const rev = await db.selectFrom('revisions').selectAll().where('id', '=', doc.head_rev!).executeTakeFirstOrThrow()
    expect(rev.source).toBe('release')
    expect(rev.release_id).toBe('r1')
    expect(JSON.parse(rev.data).fields.title).toBe('Start')
    const event = await db.selectFrom('publish_events').selectAll().orderBy('id', 'desc').executeTakeFirstOrThrow()
    expect(event.source).toBe('release')
    expect(JSON.parse(event.items)).toEqual([{ documentId: home.id, revisionId: doc.head_rev, action: 'publish' }])
  })

  it('can read and list hidden types', async () => {
    const { core, db } = await setup()
    const maria = (await core.listEntries('testimonials'))[0]!
    const stored = await db
      .selectFrom('revisions')
      .select('data')
      .where('id', '=', maria.headRev)
      .executeTakeFirstOrThrow()
    const hidden = createCore({ site: noTestimonialsSite, db })
    let seen: { types: string[]; list: Awaited<ReturnType<MigrationContext['list']>>; read: Awaited<ReturnType<MigrationContext['read']>> } | null = null
    await hidden.runReleaseMigrations('r1', [
      defineMigration({
        name: 'look',
        run: async (ctx) => {
          seen = { types: await ctx.types(), list: await ctx.list('testimonials'), read: await ctx.read(maria.id) }
        },
      }),
    ])
    expect(seen!.types).toContain('testimonials')
    expect(seen!.types).toContain('home')
    expect(seen!.list).toEqual([
      expect.objectContaining({ id: maria.id, groupId: maria.groupId, type: 'testimonials', locale: 'en', key: 'maria', hidden: true, deleted: false }),
      expect.objectContaining({ type: 'testimonials', locale: 'es', key: 'maria', hidden: true }),
    ])
    expect(seen!.read.head).toEqual(JSON.parse(stored.data))
    expect(seen!.read.published).toEqual(JSON.parse(stored.data))
  })

  it('create with a key sets documents.key', async () => {
    const { core, db } = await setup()
    let created: { id: string; groupId: string } | null = null
    await core.runReleaseMigrations('r1', [
      defineMigration({
        name: 'add',
        run: async (ctx) => {
          created = await ctx.create('posts', { key: 'launch', fields: { title: 'Launch', date: '2026-01-01', body: 'Text' } })
        },
      }),
    ])
    const doc = await db.selectFrom('documents').selectAll().where('id', '=', created!.id).executeTakeFirstOrThrow()
    expect(doc.key).toBe('launch')
    expect(doc.group_id).toBe(created!.groupId)
    expect(doc.published_rev).toBeNull()
    const rev = await db.selectFrom('revisions').selectAll().where('id', '=', doc.head_rev!).executeTakeFirstOrThrow()
    expect(rev.source).toBe('release')
    expect(rev.release_id).toBe('r1')
  })

  it('a failed write the function catches leaves nothing of itself', async () => {
    const { core, db } = await setup()
    const before = await countEntries(db)
    await core.runReleaseMigrations('r1', [
      defineMigration({
        name: 'clash',
        run: async (ctx) => {
          await ctx.create('posts', { key: 'launch', fields: { title: 'One', date: '2026-01-01', body: 'Text' } })
          await expect(
            ctx.create('posts', { key: 'launch', fields: { title: 'Two', date: '2026-01-01', body: 'Text' } }),
          ).rejects.toThrow()
        },
      }),
    ])
    expect(await countEntries(db)).toBe(before + 1)
    expect(await db.selectFrom('release_migrations').select('name').execute()).toEqual([{ name: 'clash' }])
  })

  it('a call the function fails to await and never looks at fails the run', async () => {
    const { core, db } = await setup()
    const before = await countEntries(db)
    await expect(
      core.runReleaseMigrations('r1', [
        defineMigration({
          name: 'forgotten',
          run: async (ctx) => {
            await ctx.create('posts', { key: 'launch', fields: { title: 'One', date: '2026-01-01', body: 'Text' } })
            void ctx.create('posts', { key: 'launch', fields: { title: 'Two', date: '2026-01-01', body: 'Text' } })
          },
        }),
      ]),
    ).rejects.toThrow()
    expect(await db.selectFrom('release_migrations').selectAll().execute()).toHaveLength(0)
    expect(await countEntries(db)).toBe(before)
  })

  it('a save chained on a read without awaiting lands before the function is recorded', async () => {
    const { core, db } = await setup()
    const home = (await core.findSingleton('home'))!
    await core.runReleaseMigrations('r1', [
      defineMigration({
        name: 'chained',
        run: async (ctx) => {
          void ctx.read(home.id).then(({ head }) => ctx.save(home.id, { ...head!, fields: { ...head!.fields, title: 'Chained' } }))
        },
      }),
    ])
    const doc = await db.selectFrom('documents').select('head_rev').where('id', '=', home.id).executeTakeFirstOrThrow()
    const rev = await db.selectFrom('revisions').select('data').where('id', '=', doc.head_rev!).executeTakeFirstOrThrow()
    expect(JSON.parse(rev.data).fields.title).toBe('Chained')
    expect(await db.selectFrom('release_migrations').select('name').execute()).toEqual([{ name: 'chained' }])
  })

  it('a read → save round trip keeps every slot unchanged', async () => {
    const { core, db } = await setup()
    const home = (await core.findSingleton('home', 'es'))!
    const headOf = async () => {
      const doc = await db.selectFrom('documents').select('head_rev').where('id', '=', home.id).executeTakeFirstOrThrow()
      const rev = await db.selectFrom('revisions').select('data').where('id', '=', doc.head_rev!).executeTakeFirstOrThrow()
      return { rev: doc.head_rev, data: JSON.parse(rev.data) as DocumentData }
    }
    const before = await headOf()
    expect(before.data.slots.quotes?.enabled).toBe(false)
    await core.runReleaseMigrations('r1', [
      defineMigration({
        name: 'round-trip',
        run: async (ctx) => {
          const { head } = await ctx.read(home.id)
          await ctx.save(home.id, head!)
        },
      }),
    ])
    const same = await headOf()
    expect(same.rev).toBe(before.rev)
    expect(same.data).toEqual(before.data)
    await core.runReleaseMigrations('r1', [
      defineMigration({
        name: 'retitle',
        run: async (ctx) => {
          const { head } = await ctx.read(home.id)
          await ctx.save(home.id, { ...head!, fields: { ...head!.fields, title: 'Portada' } })
        },
      }),
    ])
    const after = await headOf()
    expect(after.rev).not.toBe(before.rev)
    expect(after.data.fields.title).toBe('Portada')
    expect(after.data.slots).toEqual(before.data.slots)
  })

  it('parallel calls from one function all land', async () => {
    const { core, db } = await setup()
    const before = await countEntries(db)
    await core.runReleaseMigrations('r1', [
      defineMigration({
        name: 'parallel',
        run: async (ctx) => {
          await Promise.all(
            ['One', 'Two', 'Three'].map((title) => ctx.create('posts', { fields: { title, date: '2026-01-01', body: 'Text' } })),
          )
        },
      }),
    ])
    expect(await countEntries(db)).toBe(before + 3)
    expect(await db.selectFrom('release_migrations').select('name').execute()).toEqual([{ name: 'parallel' }])
  })

  it('a create refused for a duplicate slug is rolled back alone and the function goes on', async () => {
    const { core, db } = await setup()
    const before = await countEntries(db)
    let refused: unknown = null
    await core.runReleaseMigrations('r1', [
      defineMigration({
        name: 'dup',
        run: async (ctx) => {
          await ctx.create('posts', { slug: 'same', fields: { title: 'One', date: '2026-01-01', body: 'Text' } })
          try {
            await ctx.create('posts', { slug: 'same', fields: { title: 'Two', date: '2026-01-01', body: 'Text' } })
          } catch (e) {
            refused = e
          }
          await ctx.create('posts', { slug: 'other', fields: { title: 'Three', date: '2026-01-01', body: 'Text' } })
        },
      }),
    ])
    expect(refused).toBeInstanceOf(InlayError)
    expect(await countEntries(db)).toBe(before + 2)
    const slugs = await db.selectFrom('documents').select('head_slug').where('type', '=', 'posts').execute()
    expect(slugs.map((r) => r.head_slug).sort()).toEqual(expect.arrayContaining(['other', 'same']))
    expect(await db.selectFrom('release_migrations').select('name').execute()).toEqual([{ name: 'dup' }])
  })

  it('refuses to run outside a transaction', async () => {
    const { core, db } = await setup()
    const deps = { db, registry: core.registry, now: () => new Date(), media: null, uploads: { maxBytes: 1, types: [] } }
    await expect(runReleaseMigrations(deps, 'r1', [], systemCtx('release'))).rejects.toMatchObject({
      messageId: 'error.migrationTransaction',
    })
  })

  it('runs inside the caller\'s transaction', async () => {
    const { core, db } = await setup()
    const deps = { db, registry: core.registry, now: () => new Date('2026-02-01T00:00:00.000Z'), media: null, uploads: { maxBytes: 1, types: [] } }
    await expect(
      db.transaction().execute(async (trx) => {
        const names = await runReleaseMigrations({ ...deps, db: trx }, 'r1', [
          defineMigration({
            name: 'add',
            run: async (ctx) => void (await ctx.create('posts', { fields: { title: 'T', date: '2026-01-01', body: 'B' } })),
          }),
        ], systemCtx('release'))
        expect(names).toEqual(['add'])
        expect(await trx.selectFrom('release_migrations').selectAll().execute()).toEqual([
          { release_id: 'r1', name: 'add', ran_at: '2026-02-01T00:00:00.000Z' },
        ])
        throw new Error('roll back')
      }),
    ).rejects.toThrow('roll back')
    expect(await db.selectFrom('release_migrations').selectAll().execute()).toHaveLength(0)
  })

  it('migration names must be unique', () => {
    const run = async () => {}
    const site = (names: string[]) => defineSite({ ...shippedSite(), migrations: names.map((name) => ({ name, run })) })
    expect(() => buildRegistry(site(['a', 'b']))).not.toThrow()
    expect(() => buildRegistry(site(['a', 'a']))).toThrow(InlayError)
    expect(() => buildRegistry(site(['a', 'a']))).toThrow('"a"')
    expect(() => buildRegistry(site(['']))).toThrow(InlayError)
  })
})
