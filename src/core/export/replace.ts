import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import { writeSiteLock, type SiteLockRow } from '../site-lock/site-lock.js'

export interface ReplaceCounts {
  documents: number
  revisions: number
  media: number
  redirects: number
}

const CHUNK = 200

type Table = 'documents' | 'revisions' | 'publish_events' | 'refs' | 'media' | 'media_deletions' | 'redirects'

/** Deleted children first, so no foreign key is left pointing at a removed row. */
const DELETE_ORDER: readonly Table[] = ['refs', 'publish_events', 'revisions', 'documents', 'media_deletions', 'media', 'redirects']
/** Copied parents first, for the same reason. */
const COPY_ORDER: readonly Table[] = ['documents', 'revisions', 'publish_events', 'refs', 'media', 'media_deletions', 'redirects']

/**
 * Replaces every content table of `live` with the rows of `from`, ids and all,
 * in one transaction. `removedMedia` lists the media ids `live` had that
 * `from` doesn't, so the caller can remove their files once this commits.
 */
export async function replaceContent(
  live: Kysely<Database>,
  from: Kysely<Database>,
  siteLock?: SiteLockRow,
): Promise<ReplaceCounts & { removedMedia: string[] }> {
  return live.transaction().execute(async (trx) => {
    const oldMedia = (await trx.selectFrom('media').select('id').execute()).map((m) => m.id)
    for (const table of DELETE_ORDER) await trx.deleteFrom(table).execute()

    const copied = new Map<Table, number>()
    for (const table of COPY_ORDER) {
      const rows = await from.selectFrom(table).selectAll().execute()
      for (let i = 0; i < rows.length; i += CHUNK) {
        await trx.insertInto(table).values(rows.slice(i, i + CHUNK) as never).execute()
      }
      copied.set(table, rows.length)
    }

    if (siteLock) await writeSiteLock(trx, siteLock)

    const newMedia = new Set((await trx.selectFrom('media').select('id').execute()).map((m) => m.id))
    return {
      documents: copied.get('documents') ?? 0,
      revisions: copied.get('revisions') ?? 0,
      media: copied.get('media') ?? 0,
      redirects: copied.get('redirects') ?? 0,
      removedMedia: oldMedia.filter((id) => !newMedia.has(id)),
    }
  })
}
