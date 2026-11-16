import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import { createCore, type Core } from '../../src/core/core.js'
import { openDatabase } from '../../src/core/db/connection.js'
import { migrateSystem } from '../../src/core/db/migrate.js'
import type { Database } from '../../src/core/db/schema.js'
import type { SiteDefinition } from '../../src/core/registry/define.js'
import type { Ctx, UploadLimits } from '../../src/core/types.js'
import { site as fixtureSite } from '../fixtures/site.js'

/** A core over a fresh in-memory DB whose clock starts at 2026-01-01T00:00:00Z and ticks 1s per call. */
export async function makeCore(
  opts: { site?: SiteDefinition; media?: boolean; backups?: boolean; uploads?: UploadLimits; now?: () => Date } = {},
): Promise<{ core: Core; db: Kysely<Database>; owner: Ctx; editor: Ctx; mediaDir: string | null; backupsDir: string | null }> {
  const mediaDir = opts.media ? await mkdtemp(join(tmpdir(), 'inlay-media-')) : null
  const backupsDir = opts.backups ? await mkdtemp(join(tmpdir(), 'inlay-backups-')) : null
  const db = openDatabase(':memory:')
  await migrateSystem(db)
  let time = Date.parse('2026-01-01T00:00:00.000Z')
  const now = opts.now ?? (() => {
    const d = new Date(time)
    time += 1000
    return d
  })
  const core = createCore({
    site: opts.site ?? fixtureSite,
    db,
    now,
    media: mediaDir ?? undefined,
    backups: backupsDir ?? undefined,
    uploads: opts.uploads,
  })
  const owner: Ctx = { actor: { id: 'user-owner', name: 'Olivia Owner', role: 'owner' }, source: 'admin' }
  const editor: Ctx = { actor: { id: 'user-editor', name: 'Eddie Editor', role: 'editor' }, source: 'admin' }
  return { core, db, owner, editor, mediaDir, backupsDir }
}
