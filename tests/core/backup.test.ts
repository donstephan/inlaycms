import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { createBackup } from '../../src/core/backup/backup.js'
import { openDatabase } from '../../src/core/db/connection.js'
import { migrateSystem } from '../../src/core/db/migrate.js'
import { createCore } from '../../src/core/core.js'
import { inlayVersion } from '../../src/core/version.js'
import type { Ctx } from '../../src/core/types.js'
import { site } from '../fixtures/site.js'
import { systemCtx } from '../../src/core/auth/roles.js'

describe('createBackup', () => {
  let dir: string
  let db: ReturnType<typeof openDatabase>
  const fixedNow = () => new Date('2026-02-03T04:05:06.789Z')

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inlay-backup-'))
    db = openDatabase(join(dir, 'site.db'))
    await migrateSystem(db)
    await createCore({ site, db }).applyShippedContent()
  })

  afterEach(async () => {
    await db.destroy()
    await rm(dir, { recursive: true, force: true })
  })

  async function extract(file: string): Promise<string> {
    const out = join(dir, `out-${Math.random().toString(36).slice(2)}`)
    await mkdir(out)
    await tar.x({ file, cwd: out })
    return out
  }

  it('writes an archive with backup.json and a database snapshot', async () => {
    const info = await createBackup({
      db, backups: join(dir, 'backups'), reason: 'manual', ctx: systemCtx('system'), now: fixedNow,
    })
    expect(info.path.endsWith('-manual.tar.gz')).toBe(true)
    expect(info.path).toContain('2026-02-03T04-05-06-789Z')
    expect(info.size).toBeGreaterThan(0)
    expect(await readdir(join(dir, 'backups'))).toEqual([info.path.split('/').pop()])

    const out = await extract(info.path)
    const meta = JSON.parse(await readFile(join(out, 'backup.json'), 'utf8'))
    expect(meta).toEqual({
      format: 1, inlayVersion: inlayVersion(), createdAt: '2026-02-03T04:05:06.789Z', reason: 'manual',
    })
    const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'))
    expect(meta.inlayVersion).toBe(pkg.version)

    const copy = openDatabase(join(out, 'inlay.db'), { readonly: true })
    const count = async (d: typeof db) =>
      Number((await d.selectFrom('documents').select((e) => e.fn.countAll().as('n')).executeTakeFirstOrThrow()).n)
    expect(await count(copy)).toBe(await count(db))
    expect(await count(copy)).toBeGreaterThan(0)
    await copy.destroy()
  })

  it('leaves the release out when nothing is live or the live release file is gone', async () => {
    const backups = join(dir, 'backups')
    const plain = await createBackup({ db, backups, reason: 'manual', ctx: systemCtx('system'), now: fixedNow })
    expect((await readdir(await extract(plain.path))).sort()).toEqual(['backup.json', 'inlay.db'])

    await db.insertInto('releases').values({
      id: 'r-1', name: 'gone', state: 'current', file: 'r-1.tgz', checksum: 'x', signed_by: 'k', inlay_range: '*',
      secrets: '[]', schema: '{}', pushed_by: null, pushed_at: '2026-01-01T00:00:00.000Z', activated_at: '2026-01-01T00:00:00.000Z',
      deactivated_at: null,
    }).execute()
    await mkdir(join(dir, 'releases'))
    const missing = await createBackup({ db, backups, reason: 'manual', ctx: systemCtx('system'), now: fixedNow })
    expect((await readdir(await extract(missing.path))).sort()).toEqual(['backup.json', 'inlay.db'])

    await writeFile(join(dir, 'releases', 'r-1.tgz'), 'release bytes')
    const kept = await createBackup({ db, backups, reason: 'manual', ctx: systemCtx('system'), now: fixedNow })
    const out = await extract(kept.path)
    expect((await readdir(out)).sort()).toEqual(['backup.json', 'inlay.db', 'release.json', 'release.tgz'])
    expect(JSON.parse(await readFile(join(out, 'release.json'), 'utf8'))).toEqual({ id: 'r-1', name: 'gone' })
    expect(await readFile(join(out, 'release.tgz'), 'utf8')).toBe('release bytes')
  })

  it('reads the release from the folder given', async () => {
    await db.insertInto('releases').values({
      id: 'r-2', name: 'elsewhere', state: 'current', file: 'r-2.tgz', checksum: 'x', signed_by: 'k', inlay_range: '*',
      secrets: '[]', schema: '{}', pushed_by: null, pushed_at: '2026-01-01T00:00:00.000Z', activated_at: null, deactivated_at: null,
    }).execute()
    await mkdir(join(dir, 'other'))
    await writeFile(join(dir, 'other', 'r-2.tgz'), 'x')
    const info = await createBackup({
      db, backups: join(dir, 'backups'), releases: join(dir, 'other'), reason: 'manual', ctx: systemCtx('system'),
    })
    expect(await readdir(await extract(info.path))).toContain('release.tgz')
  })

  it('leaves the variant cache and temp files out of the media copy', async () => {
    const media = join(dir, 'media')
    await mkdir(join(media, 'cache', 'abc'), { recursive: true })
    await writeFile(join(media, 'abc'), 'orig')
    await writeFile(join(media, 'cache', 'abc', '320.webp'), 'v')
    await writeFile(join(media, '.tmp-x'), 't')
    const info = await createBackup({ db, backups: join(dir, 'b'), media, reason: 'manual', ctx: systemCtx('system') })
    const out = await extract(info.path)
    expect(await readdir(join(out, 'media'))).toEqual(['abc'])
  })

  it('includes the media directory', async () => {
    const media = join(dir, 'media')
    await mkdir(media)
    await writeFile(join(media, 'a.bin'), 'abc')
    const info = await createBackup({ db, backups: join(dir, 'b'), media, reason: 'scheduled', ctx: systemCtx('system') })
    const out = await extract(info.path)
    expect(await readFile(join(out, 'media', 'a.bin'), 'utf8')).toBe('abc')
  })

  it('gives backups made in the same millisecond different names', async () => {
    const args = { db, backups: join(dir, 'b'), reason: 'manual' as const, ctx: systemCtx('system'), now: fixedNow }
    const a = await createBackup(args)
    const b = await createBackup(args)
    expect(a.path).not.toBe(b.path)
    expect(b.path).toContain('-2-manual')
    expect((await readdir(join(dir, 'b'))).sort()).toHaveLength(2)
  })

  it('gives concurrent backups in the same millisecond different names', async () => {
    const args = { db, backups: join(dir, 'b'), reason: 'manual' as const, ctx: systemCtx('system'), now: fixedNow }
    const infos = await Promise.all([createBackup(args), createBackup(args), createBackup(args)])
    expect(new Set(infos.map((i) => i.path)).size).toBe(3)
    expect(await readdir(join(dir, 'b'))).toHaveLength(3)
  })

  it('leaves nothing behind when the backup fails', async () => {
    const media = join(dir, 'media')
    await mkdir(media)
    await writeFile(join(media, 'secret.bin'), 'x')
    await chmod(join(media, 'secret.bin'), 0o000)
    try {
      if (process.getuid?.() === 0) return
      await expect(
        createBackup({ db, backups: join(dir, 'b'), media, reason: 'manual', ctx: systemCtx('system') }),
      ).rejects.toThrow()
      expect(await readdir(join(dir, 'b'))).toEqual([])
    } finally {
      await chmod(join(media, 'secret.bin'), 0o644)
    }
  })

  it('refuses editors and writes nothing', async () => {
    const editor: Ctx = { actor: { id: 'e', name: 'Ed', role: 'editor' }, source: 'admin' }
    await expect(
      createBackup({ db, backups: join(dir, 'b'), reason: 'manual', ctx: editor }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(readdir(join(dir, 'b'))).rejects.toThrow()
  })
})
