import { InlayError } from '../errors.js'
import { listMedia } from '../media/library.js'
import type { MigrationContext, MigrationDocument, ReleaseMigration } from '../registry/migration.js'
import type { CoreDeps, Ctx, DocumentData } from '../types.js'
import { withTransaction } from './dry-run.js'
import { publish } from './publish.js'
import { readData } from './reader.js'
import { writeDraft } from './save.js'
import { createEntry } from './write.js'

/** A call's promise that notes when the migration attaches a handler to it (`then`, `catch`, `finally`, `await`). */
class Observed<T> extends Promise<T> {
  static override get [Symbol.species]() {
    return Promise
  }

  seen = false

  override then<A = T, B = never>(
    onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    this.seen = true
    return super.then(onFulfilled, onRejected)
  }
}

/** Lets pending promise callbacks run, so a call the migration chains onto another is made before `idle` checks. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * Wraps each method of `api` so calls run one at a time, in the order they
 * were made. `idle` settles once every call made so far has, calls made while
 * it waits included, and throws the first failure of a call the migration
 * never looked at.
 */
function serialised(api: MigrationContext): { api: MigrationContext; idle: () => Promise<void> } {
  let last: Promise<unknown> = Promise.resolve()
  let failed: Array<{ call: Observed<unknown>; error: unknown }> = []
  const queue = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => (...args: A): Promise<R> => {
    const run = last.then(() => fn(...args))
    const call = new Observed<R>((resolve, reject) => void run.then(resolve, reject))
    Promise.prototype.then.call(call, undefined, () => undefined)
    last = run.then(
      () => undefined,
      (error: unknown) => void failed.push({ call, error }),
    )
    return call
  }
  const wrapped: MigrationContext = {
    types: queue(api.types),
    list: queue(api.list),
    read: queue(api.read),
    create: queue(api.create),
    save: queue(api.save),
    publish: queue(api.publish),
    media: { list: queue(api.media.list) },
  }
  const idle = async () => {
    let seen: Promise<unknown>
    do {
      seen = last
      await seen
      await turn()
    } while (seen !== last)
    const unseen = failed.find((f) => !f.call.seen)
    failed = []
    if (unseen) throw unseen.error
  }
  return { api: wrapped, idle }
}

async function findDocument(deps: CoreDeps, id: string) {
  const doc = await deps.db.selectFrom('documents').selectAll().where('id', '=', id).executeTakeFirst()
  if (!doc) throw new InlayError('not_found', 'error.notFound', { name: id })
  return doc
}

/** The content API a migration function gets (spec §8.3). Writes go through `ctx`. */
function migrationContext(deps: CoreDeps, ctx: Ctx): MigrationContext {
  const { registry } = deps
  const hidden = (type: string, locale: string) => !registry.types.has(type) || !registry.locales.includes(locale)
  const revision = async (type: string, revId: number | null): Promise<DocumentData | null> => {
    if (revId === null) return null
    const rev = await deps.db.selectFrom('revisions').select('data').where('id', '=', revId).executeTakeFirstOrThrow()
    const raw: unknown = JSON.parse(rev.data)
    return registry.types.has(type) ? readData(registry, type, raw).data : (raw as DocumentData)
  }

  return {
    async types() {
      const rows = await deps.db.selectFrom('documents').select('type').distinct().orderBy('type').execute()
      return rows.map((r) => r.type)
    },
    async list(type, opts = {}) {
      let q = deps.db.selectFrom('documents').selectAll().where('type', '=', type)
      if (opts.locale !== undefined) q = q.where('locale', '=', opts.locale)
      if (!opts.includeDeleted) q = q.where('deleted_at', 'is', null)
      const rows = await q.orderBy('created_at').orderBy('locale').orderBy('id').execute()
      return rows.map(
        (row): MigrationDocument => ({
          id: row.id,
          groupId: row.group_id,
          type: row.type,
          locale: row.locale,
          slug: row.head_slug,
          key: row.key,
          edition: row.edition,
          deleted: row.deleted_at !== null,
          hidden: hidden(row.type, row.locale),
        }),
      )
    },
    async read(id) {
      const doc = await findDocument(deps, id)
      return { head: await revision(doc.type, doc.head_rev), published: await revision(doc.type, doc.published_rev) }
    },
    async create(type, input) {
      const { key, ...content } = input
      return withTransaction(deps, async (tx) => {
        const view = await createEntry(tx, type, content, ctx)
        if (key !== undefined) await tx.db.updateTable('documents').set({ key }).where('id', '=', view.id).execute()
        return { id: view.id, groupId: view.groupId }
      })
    },
    async save(id, data) {
      await findDocument(deps, id)
      await writeDraft(deps, id, { baseRevisionId: null }, ctx, () => data)
    },
    async publish(ids) {
      await publish(deps, ids, ctx)
    },
    media: {
      list: () => listMedia(deps, { limit: -1 }),
    },
  }
}

/**
 * Runs the release's migration functions not yet recorded for it, in order,
 * and records each in `release_migrations`. `deps.db` must be the caller's
 * transaction: a throw propagates and the caller rolls everything back. Each
 * content call a function makes runs in its own savepoint, one at a time; a
 * failed call the function never awaited or handled fails it too.
 * Writes are revisions with `ctx.source` and the release id. Returns the
 * names run.
 */
export async function runReleaseMigrations(
  deps: CoreDeps,
  releaseId: string,
  migrations: readonly ReleaseMigration[],
  ctx: Ctx,
): Promise<string[]> {
  if (!deps.db.isTransaction) throw new InlayError('invalid_operation', 'error.migrationTransaction')
  const done = new Set(
    (await deps.db.selectFrom('release_migrations').select('name').where('release_id', '=', releaseId).execute()).map(
      (r) => r.name,
    ),
  )
  const { api, idle } = serialised(migrationContext(deps, { ...ctx, releaseId }))
  const ran: string[] = []
  for (const migration of migrations) {
    if (done.has(migration.name)) continue
    await migration.run(api)
    await idle()
    await deps.db
      .insertInto('release_migrations')
      .values({ release_id: releaseId, name: migration.name, ran_at: deps.now().toISOString() })
      .execute()
    done.add(migration.name)
    ran.push(migration.name)
  }
  return ran
}
