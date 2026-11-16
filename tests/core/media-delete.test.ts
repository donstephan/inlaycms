import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/core/db/connection.js'
import { migrateSystem } from '../../src/core/db/migrate.js'
import { DEFAULT_MAX_BYTES, DEFAULT_UPLOAD_TYPES } from '../../src/core/media/detect.js'
import { addMedia, deleteMedia, getMedia, missingMediaLabel } from '../../src/core/media/library.js'
import { fileMediaStore, type MediaStore } from '../../src/core/media/store.js'
import { buildRegistry } from '../../src/core/registry/registry.js'
import type { CoreDeps, Ctx } from '../../src/core/types.js'
import { png } from '../fixtures/media.js'
import { site } from '../fixtures/site.js'
import { makeCore } from '../helpers/core.js'

async function setup() {
  const ctx = await makeCore({ media: true })
  await ctx.core.applyShippedContent()
  const bytes = await png(40, 20)
  const { media } = await ctx.core.addMedia({ data: bytes, filename: 'photo.png' }, ctx.owner)
  const home = (await ctx.core.findSingleton('home'))!
  const es = (await ctx.core.findTranslation(home.groupId, 'es'))!
  return { ...ctx, bytes, media, es }
}

async function setHeroImage(
  core: Awaited<ReturnType<typeof setup>>['core'],
  docId: string,
  value: unknown,
  ctx: Awaited<ReturnType<typeof setup>>['owner'],
) {
  const doc = (await core.getDocument(docId))!
  return core.patchDraft(
    docId,
    { baseRevisionId: doc.headRev, ops: [{ path: ['slots', 'hero', 'data', 'image'], value }] },
    ctx,
  )
}

async function exists(path: string) {
  return access(path).then(() => true, () => false)
}

describe('deleting media', () => {
  it('refuses while an unpublished draft in another locale uses it', async () => {
    const { core, owner, media, es } = await setup()
    await setHeroImage(core, es.id, { media: media.id }, owner)
    const err = await core.deleteMedia(media.id, owner).then(() => null, (e) => e)
    expect(err).toMatchObject({ code: 'in_use', messageId: 'error.mediaInUse' })
    expect(err.message).toBe('The file "photo.png" is still used in 1 place. Remove it from there before deleting it.')
    expect(err.details.usages).toMatchObject([{ type: 'home', locale: 'es', in: 'draft' }])
    expect(err.details.usages).toHaveLength(1)
    expect(await core.getMedia(media.id)).not.toBeNull()
    expect(await exists((await core.mediaFile(media.id)).path)).toBe(true)
  })

  it('refuses while the published version uses it', async () => {
    const { core, owner, media, es } = await setup()
    await setHeroImage(core, es.id, { media: media.id }, owner)
    await core.publish([es.id], owner)
    await setHeroImage(core, es.id, undefined, owner)
    const err = await core.deleteMedia(media.id, owner).then(() => null, (e) => e)
    expect(err).toMatchObject({ code: 'in_use' })
    expect(err.details.usages).toMatchObject([{ in: 'published' }])
  })

  it('allows deleting an image used only by a deleted post', async () => {
    const { core, owner, media } = await setup()
    const post = await core.createEntry(
      'posts',
      { fields: { title: 'T', date: '2026-02-01', body: 'Hello', photo: { media: media.id } } },
      owner,
    )
    await core.deleteEntry(post.groupId, owner)
    await core.deleteMedia(media.id, owner)
    expect(await core.getMedia(media.id)).toBeNull()
  })

  it('removes the row, the file and the cache, and leaves a placeholder', async () => {
    const { core, owner, media, mediaDir, bytes } = await setup()
    const cacheDir = `${mediaDir}/cache/${media.id}`
    await mkdir(cacheDir, { recursive: true })
    await writeFile(`${cacheDir}/320.webp`, 'x')
    const { path } = await core.mediaFile(media.id)
    await core.deleteMedia(media.id, owner)
    expect(await core.getMedia(media.id)).toBeNull()
    expect(await exists(path)).toBe(false)
    expect(await exists(cacheDir)).toBe(false)
    const status = (await core.lookupMedia([media.id])).get(media.id)!
    expect(status).toMatchObject({ status: 'deleted', filename: 'photo.png' })
    if (status.status !== 'deleted') throw new Error('unreachable')
    expect(missingMediaLabel(status)).toBe('Missing: photo.png (deleted Jan 1, 2026)')

    const again = await core.addMedia({ data: bytes, filename: 'photo.png' }, owner)
    expect(again.reused).toBe(false)
    expect((await core.lookupMedia([media.id])).get(media.id)!.status).toBe('present')
  })

  it('keeps the file when the same bytes are added while they are being deleted', async () => {
    const files = fileMediaStore(await mkdtemp(join(tmpdir(), 'inlay-media-race-')))
    let removeStarted!: () => void
    const removing = new Promise<void>((resolve) => (removeStarted = resolve))
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    // Deleting holds here, after its transaction has committed and before the file goes.
    const store: MediaStore = {
      ...files,
      async remove(id) {
        removeStarted()
        await gate
        await files.remove(id)
      },
    }
    const db = openDatabase(':memory:')
    await migrateSystem(db)
    const deps: CoreDeps = {
      db,
      registry: buildRegistry(site),
      now: () => new Date('2026-01-01T00:00:00Z'),
      media: store,
      uploads: { maxBytes: DEFAULT_MAX_BYTES, types: DEFAULT_UPLOAD_TYPES },
    }
    const owner: Ctx = { actor: { id: 'u1', name: 'Owner', role: 'owner' }, source: 'admin' }
    const bytes = await png(30, 30)
    const { media } = await addMedia(deps, { data: bytes, filename: 'a.png' }, owner)

    const deleting = deleteMedia(deps, media.id, owner)
    await removing
    const adding = addMedia(deps, { data: bytes, filename: 'a.png' }, owner)
    await Promise.race([adding, new Promise((resolve) => setTimeout(resolve, 100))])
    release()
    await Promise.all([deleting, adding])

    expect(await getMedia(deps, media.id)).not.toBeNull()
    expect(await store.has(media.id)).toBe(true)
    await db.destroy()
  })

  it('reports an unknown id as not found', async () => {
    const { core, owner } = await setup()
    await expect(core.deleteMedia('0'.repeat(64), owner)).rejects.toMatchObject({ code: 'not_found' })
  })
})
