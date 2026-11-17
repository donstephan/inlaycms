import { sql } from 'kysely'
import { InlayError } from '../errors.js'
import type { CoreDeps } from '../types.js'

/** Thrown inside a dry run's transaction to roll it back. */
export class DryRun extends Error {}

const savepoints = new WeakMap<object, number>()

/**
 * Runs `fn` in a transaction. When `deps.db` is already a transaction, `fn`
 * runs in a savepoint of it: a throw rolls back only what `fn` wrote, and
 * the rest commits or rolls back with the outer transaction. A new transaction
 * takes the write lock before `fn` reads anything, so a commit from another
 * connection (another process on the same database) can't make its first write
 * fail with SQLITE_BUSY or SQLITE_BUSY_SNAPSHOT; it waits for that connection
 * instead. `write` says the caller needs that guarantee for everything it
 * reads: inside a transaction it throws `error.transactionWrite`, since the
 * outer one may not have taken the lock first.
 */
export async function withTransaction<T>(
  deps: CoreDeps,
  fn: (tx: CoreDeps) => Promise<T>,
  opts: { write?: true } = {},
): Promise<T> {
  if (!deps.db.isTransaction) {
    return deps.db.transaction().execute(async (trx) => {
      await sql`update releases set name = name where id = ''`.execute(trx)
      return fn({ ...deps, db: trx })
    })
  }
  if (opts.write) throw new InlayError('invalid_operation', 'error.transactionWrite')
  const n = (savepoints.get(deps.db) ?? 0) + 1
  savepoints.set(deps.db, n)
  const name = sql.id(`sp_${n}`)
  await sql`savepoint ${name}`.execute(deps.db)
  let value: T
  try {
    value = await fn(deps)
  } catch (e) {
    try {
      await sql`rollback to savepoint ${name}`.execute(deps.db)
      await sql`release savepoint ${name}`.execute(deps.db)
    } catch {
      // The original error matters more than a failed rollback.
    }
    throw e
  }
  await sql`release savepoint ${name}`.execute(deps.db)
  return value
}

/**
 * Runs `fn` in a transaction (a savepoint inside one). With `dryRun`, `fn`
 * runs in full, then the transaction is rolled back and `fn`'s result returned.
 */
export async function runTransaction<T>(
  deps: CoreDeps,
  fn: (tx: CoreDeps) => Promise<T>,
  opts: { dryRun?: boolean },
): Promise<T> {
  let result: { value: T } | null = null
  try {
    return await withTransaction(deps, async (tx) => {
      const value = await fn(tx)
      if (opts.dryRun) {
        result = { value }
        throw new DryRun()
      }
      return value
    })
  } catch (e) {
    if (e instanceof DryRun && result !== null) return (result as { value: T }).value
    throw e
  }
}
