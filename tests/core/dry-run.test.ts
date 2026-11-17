import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { runTransaction, withTransaction } from '../../src/core/content/dry-run.js'
import { openDatabase } from '../../src/core/db/connection.js'
import { migrateSystem } from '../../src/core/db/migrate.js'
import type { CoreDeps } from '../../src/core/types.js'
import { makeCore } from '../helpers/core.js'

async function setup() {
  const { core, db } = await makeCore()
  await sql`create table t (v text not null)`.execute(db)
  const deps = { db, registry: core.registry, now: () => new Date(), media: null, uploads: { maxBytes: 1, types: [] } } as CoreDeps
  const insert = (d: CoreDeps, v: string) => sql`insert into t (v) values (${v})`.execute(d.db)
  const values = async () => (await sql<{ v: string }>`select v from t order by rowid`.execute(db)).rows.map((r) => r.v)
  return { deps, insert, values }
}

describe('withTransaction', () => {
  it('opens a transaction outside one', async () => {
    const { deps, insert, values } = await setup()
    await expect(
      withTransaction(deps, async (tx) => {
        expect(tx.db.isTransaction).toBe(true)
        await insert(tx, 'a')
        throw new Error('stop')
      }),
    ).rejects.toThrow('stop')
    expect(await values()).toEqual([])
    await withTransaction(deps, (tx) => insert(tx, 'b'))
    expect(await values()).toEqual(['b'])
  })

  it('a nested failure rolls back only its savepoint; the outer commit keeps the rest', async () => {
    const { deps, insert, values } = await setup()
    await withTransaction(deps, async (tx) => {
      await insert(tx, 'outer')
      await withTransaction(tx, (inner) => insert(inner, 'kept'))
      await expect(
        withTransaction(tx, async (inner) => {
          await insert(inner, 'dropped')
          await withTransaction(inner, (deeper) => insert(deeper, 'dropped too'))
          throw new Error('inner')
        }),
      ).rejects.toThrow('inner')
      await insert(tx, 'after')
    })
    expect(await values()).toEqual(['outer', 'kept', 'after'])
  })

  it('a nested success rolls back with the outer transaction', async () => {
    const { deps, insert, values } = await setup()
    await expect(
      withTransaction(deps, async (tx) => {
        await withTransaction(tx, (inner) => insert(inner, 'gone'))
        throw new Error('outer')
      }),
    ).rejects.toThrow('outer')
    expect(await values()).toEqual([])
  })

  it('a dry run inside a transaction rolls back only itself', async () => {
    const { deps, insert, values } = await setup()
    await withTransaction(deps, async (tx) => {
      await insert(tx, 'kept')
      expect(await runTransaction(tx, async (inner) => (await insert(inner, 'dry'), 'result'), { dryRun: true })).toBe('result')
    })
    expect(await values()).toEqual(['kept'])
  })
})

describe('withTransaction with write', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inlay-write-tx-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  /** Two connections to one file: the transaction's, and another that doesn't wait for locks. */
  async function connections() {
    const file = join(dir, 'inlay.db')
    const a = openDatabase(file)
    await migrateSystem(a)
    await sql`create table t (v text not null)`.execute(a)
    const b = openDatabase(file, { busyTimeoutMs: 0 })
    const deps = { db: a, now: () => new Date() } as CoreDeps
    const insert = (db: typeof a, v: string) => sql`insert into t (v) values (${v})`.execute(db)
    const values = async () => (await sql<{ v: string }>`select v from t order by rowid`.execute(a)).rows.map((r) => r.v)
    return { a, b, deps, insert, values }
  }

  it('without it, a new transaction still takes the write lock before its first read', async () => {
    const { a, b, deps, insert, values } = await connections()
    try {
      await withTransaction(deps, async (tx) => {
        await sql`select count(*) from t`.execute(tx.db)
        await expect(insert(b, 'other')).rejects.toMatchObject({ code: 'SQLITE_BUSY' })
        await insert(tx.db, 'mine')
      })
      expect(await values()).toEqual(['mine'])
    } finally {
      await b.destroy()
      await a.destroy()
    }
  })

  it('refuses write inside a transaction, where the lock can no longer come first', async () => {
    const { a, b, deps, insert, values } = await connections()
    try {
      await expect(
        withTransaction(deps, async (tx) => {
          await insert(tx.db, 'outer')
          await withTransaction(tx, async (inner) => insert(inner.db, 'inner'), { write: true })
        }),
      ).rejects.toMatchObject({ code: 'invalid_operation', messageId: 'error.transactionWrite' })
      expect(await values()).toEqual([])
    } finally {
      await b.destroy()
      await a.destroy()
    }
  })

  it('takes the write lock first, so the other connection waits and the transaction writes', async () => {
    const { a, b, deps, insert, values } = await connections()
    try {
      await withTransaction(
        deps,
        async (tx) => {
          await sql`select count(*) from t`.execute(tx.db)
          await expect(insert(b, 'other')).rejects.toMatchObject({ code: 'SQLITE_BUSY' })
          await insert(tx.db, 'mine')
        },
        { write: true },
      )
      await insert(b, 'other')
      expect(await values()).toEqual(['mine', 'other'])
    } finally {
      await b.destroy()
      await a.destroy()
    }
  })
})
