import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { sql } from 'kysely'
import sharp from 'sharp'
import { assertCan } from '../auth/roles.js'
import type { MediaTable } from '../db/schema.js'
import { InlayError } from '../errors.js'
import { findUsages } from '../content/usages.js'
import type { CoreDeps, Ctx, MediaInfo, MediaStatus } from '../types.js'
import { detectType, isRasterImage, typeLabel } from './detect.js'
import { formatSize } from './labels.js'
import type { MediaStore } from './store.js'
import { withTransaction } from '../content/dry-run.js'

export { missingMediaLabel } from './labels.js'

export function sanitizeFilename(name: string): string {
  const base = basename(name.replace(/\\/g, '/'))
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255).trim()
  return clean || 'file'
}

function toInfo(row: MediaTable): MediaInfo {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    defaultAlt: row.default_alt,
    createdBy: row.created_by_name,
    createdAt: row.created_at,
  }
}

const mediaLocks = new Map<string, Promise<void>>()

/**
 * Runs `fn` once earlier calls for the same file in the same media folder have
 * finished, so adding a file can't interleave with deleting it.
 */
export async function withMediaLock<T>(store: MediaStore, id: string, fn: () => Promise<T>): Promise<T> {
  const key = `${store.dir}\0${id}`
  const run = (mediaLocks.get(key) ?? Promise.resolve()).then(fn)
  const done = run.then(
    () => undefined,
    () => undefined,
  )
  mediaLocks.set(key, done)
  try {
    return await run
  } finally {
    if (mediaLocks.get(key) === done) mediaLocks.delete(key)
  }
}

function requireStore(deps: CoreDeps): MediaStore {
  if (!deps.media) throw new InlayError('invalid_operation', 'error.mediaNotConfigured')
  return deps.media
}

export async function inspectUpload(
  deps: CoreDeps,
  bytes: Uint8Array,
  filename: string,
): Promise<{ id: string; filename: string; mime: string; size: number; width: number | null; height: number | null }> {
  const name = sanitizeFilename(filename)
  if (bytes.length === 0) throw new InlayError('validation', 'error.mediaEmpty', { filename: name })
  if (bytes.length > deps.uploads.maxBytes) {
    throw new InlayError('validation', 'error.mediaTooLarge', { filename: name, max: formatSize(deps.uploads.maxBytes) })
  }
  const mime = detectType(bytes, name)
  if (!deps.uploads.types.includes(mime)) {
    throw new InlayError('validation', 'error.mediaTypeNotAllowed', {
      filename: name,
      types: deps.uploads.types.map(typeLabel).join(', '),
    })
  }
  let width: number | null = null
  let height: number | null = null
  if (isRasterImage(mime)) {
    try {
      const meta = await sharp(bytes).metadata()
      if (!meta.width || !meta.height) throw new Error('no size')
      // Force a full decode so truncated files are caught.
      await sharp(bytes).rotate().toBuffer()
      const swap = (meta.orientation ?? 1) >= 5
      width = swap ? meta.height : meta.width
      height = swap ? meta.width : meta.height
    } catch {
      throw new InlayError('validation', 'error.mediaUnreadable', { filename: name })
    }
  }
  return {
    id: createHash('sha256').update(bytes).digest('hex'),
    filename: name,
    mime,
    size: bytes.length,
    width,
    height,
  }
}

export async function addMedia(
  deps: CoreDeps,
  input: { data: Uint8Array; filename: string },
  ctx: Ctx,
): Promise<{ media: MediaInfo; reused: boolean }> {
  assertCan(ctx, 'media.write')
  const store = requireStore(deps)
  const info = await inspectUpload(deps, input.data, input.filename)
  return withMediaLock(store, info.id, () => storeMedia(deps, store, info, input.data, ctx))
}

async function storeMedia(
  deps: CoreDeps,
  store: MediaStore,
  info: Awaited<ReturnType<typeof inspectUpload>>,
  data: Uint8Array,
  ctx: Ctx,
): Promise<{ media: MediaInfo; reused: boolean }> {
  const existing = await deps.db.selectFrom('media').selectAll().where('id', '=', info.id).executeTakeFirst()
  if (existing) {
    if (!(await store.has(info.id))) await store.put(info.id, data)
    return { media: toInfo(existing), reused: true }
  }
  await store.put(info.id, data)
  await deps.db
    .insertInto('media')
    .values({
      id: info.id,
      filename: info.filename,
      mime: info.mime,
      size: info.size,
      width: info.width,
      height: info.height,
      default_alt: null,
      created_by_id: ctx.actor.id,
      created_by_name: ctx.actor.name,
      created_at: deps.now().toISOString(),
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute()
  const row = await deps.db.selectFrom('media').selectAll().where('id', '=', info.id).executeTakeFirstOrThrow()
  return { media: toInfo(row), reused: false }
}

export async function getMedia(deps: CoreDeps, id: string): Promise<MediaInfo | null> {
  const row = await deps.db.selectFrom('media').selectAll().where('id', '=', id).executeTakeFirst()
  return row ? toInfo(row) : null
}

export async function listMedia(
  deps: CoreDeps,
  opts: { kind?: 'image' | 'file'; search?: string; limit?: number; offset?: number } = {},
): Promise<MediaInfo[]> {
  let q = deps.db.selectFrom('media').selectAll()
  if (opts.kind === 'image') q = q.where('mime', 'like', 'image/%')
  if (opts.kind === 'file') q = q.where('mime', 'not like', 'image/%')
  if (opts.search) {
    const escaped = opts.search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)
    q = q.where(sql<boolean>`lower(filename) like ${`%${escaped}%`} escape '\\'`)
  }
  const rows = await q
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0)
    .execute()
  return rows.map(toInfo)
}

export async function setMediaAlt(deps: CoreDeps, id: string, alt: string | null, ctx: Ctx): Promise<MediaInfo> {
  assertCan(ctx, 'media.write')
  const value = alt === null ? null : alt.trim() || null
  const res = await deps.db.updateTable('media').set({ default_alt: value }).where('id', '=', id).executeTakeFirst()
  if (Number(res.numUpdatedRows) === 0) throw new InlayError('not_found', 'error.mediaNotFound')
  const media = await getMedia(deps, id)
  if (!media) throw new InlayError('not_found', 'error.mediaNotFound')
  return media
}

export async function lookupMedia(deps: CoreDeps, ids: string[]): Promise<Map<string, MediaStatus>> {
  const out = new Map<string, MediaStatus>()
  const unique = [...new Set(ids)]
  if (unique.length === 0) return out
  const present = await deps.db.selectFrom('media').selectAll().where('id', 'in', unique).execute()
  for (const row of present) out.set(row.id, { status: 'present', media: toInfo(row) })
  const missing = unique.filter((id) => !out.has(id))
  if (missing.length > 0) {
    const dels = await deps.db
      .selectFrom('media_deletions')
      .selectAll()
      .where('media_id', 'in', missing)
      .orderBy('id', 'desc')
      .execute()
    for (const d of dels) {
      if (!out.has(d.media_id)) out.set(d.media_id, { status: 'deleted', filename: d.filename, deletedAt: d.deleted_at })
    }
  }
  for (const id of unique) if (!out.has(id)) out.set(id, { status: 'unknown' })
  return out
}

export async function mediaFile(
  deps: CoreDeps,
  id: string,
): Promise<{ path: string; mime: string; filename: string; size: number }> {
  const store = requireStore(deps)
  const media = await getMedia(deps, id)
  if (!media || !(await store.has(id))) throw new InlayError('not_found', 'error.mediaNotFound')
  return { path: store.path(id), mime: media.mime, filename: media.filename, size: media.size }
}

export async function deleteMedia(deps: CoreDeps, id: string, ctx: Ctx): Promise<void> {
  assertCan(ctx, 'media.write')
  const store = deps.media
  if (store) await withMediaLock(store, id, () => removeMedia(deps, store, id, ctx))
  else await removeMedia(deps, null, id, ctx)
}

async function removeMedia(deps: CoreDeps, store: MediaStore | null, id: string, ctx: Ctx): Promise<void> {
  await withTransaction(deps, async ({ db: trx }) => {
    const row = await trx.selectFrom('media').selectAll().where('id', '=', id).executeTakeFirst()
    if (!row) throw new InlayError('not_found', 'error.mediaNotFound')
    const usages = await findUsages({ ...deps, db: trx }, { kind: 'media', id })
    if (usages.length > 0) {
      throw new InlayError('in_use', 'error.mediaInUse', { filename: row.filename, count: usages.length }, { usages })
    }
    await trx.deleteFrom('media').where('id', '=', id).execute()
    await trx
      .insertInto('media_deletions')
      .values({
        media_id: id,
        filename: row.filename,
        deleted_at: deps.now().toISOString(),
        deleted_by_id: ctx.actor.id,
        deleted_by_name: ctx.actor.name,
      })
      .execute()
  })
  if (store) await store.remove(id)
}

export async function mediaStats(deps: CoreDeps): Promise<{ count: number; totalBytes: number; imagesWithoutAlt: number }> {
  const row = await deps.db
    .selectFrom('media')
    .select([
      sql<number>`count(*)`.as('count'),
      sql<number>`coalesce(sum(size), 0)`.as('total_bytes'),
      sql<number>`coalesce(sum(case when mime like 'image/%' and default_alt is null then 1 else 0 end), 0)`.as('without_alt'),
    ])
    .executeTakeFirst()
  return {
    count: Number(row?.count ?? 0),
    totalBytes: Number(row?.total_bytes ?? 0),
    imagesWithoutAlt: Number(row?.without_alt ?? 0),
  }
}
