import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { Migrator } from 'kysely/migration'
import { listBackups } from '../../src/core/backup/backup.js'
import { bootInlay } from '../../src/core/boot.js'
import { openDatabase } from '../../src/core/db/connection.js'
import * as m0001 from '../../src/core/db/migrations/0001_content.js'
import { makeApp } from '../helpers/app.js'
import { parseHtml, signIn, type AdminClient } from '../helpers/admin.js'
import { site } from '../fixtures/site.js'

describe('admin backups', () => {
  let app: FastifyInstance
  let olivia: AdminClient
  let eddie: AdminClient

  beforeEach(async () => {
    ;({ app } = await makeApp({ withOwner: true }))
    await app.ready()
    olivia = await signIn(app, 'owner@example.com')
    eddie = await signIn(app, 'editor@example.com')
  })
  afterEach(() => app.close())

  it('lets the owner back up and download', async () => {
    const res = await olivia.post('/admin/backups', {})
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/backups?notice=backedUp')
    const page = parseHtml((await olivia.get(res.headers.location as string)).body)
    const rows = page.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('Made by hand')
    expect(rows[0]!.textContent).toMatch(/\d\s?(B|KB|MB)/)
    const href = rows[0]!.querySelector('a')!.getAttribute('href')!
    const file = await olivia.get(href)
    expect(file.statusCode).toBe(200)
    expect(file.headers['content-type']).toContain('application/gzip')
    expect(file.headers['content-disposition']).toContain('attachment; filename="inlay-backup-')
    expect([...file.rawPayload.subarray(0, 2)]).toEqual([0x1f, 0x8b])
  })

  it('refuses the editor', async () => {
    expect((await eddie.get('/admin/backups')).statusCode).toBe(403)
    expect((await eddie.post('/admin/backups', {})).statusCode).toBe(403)
    expect((await olivia.get('/admin/backups')).body).toContain('There are no backups yet.')
    expect((await eddie.get('/admin/backups/inlay-backup-x.tar.gz')).statusCode).toBe(403)
  })

  it('404s on names that are not backups', async () => {
    expect((await olivia.get('/admin/backups/..%2Finlay.db')).statusCode).toBe(404)
    expect((await olivia.get('/admin/backups/nope.tar.gz')).statusCode).toBe(404)
  })
})

describe('listBackups', () => {
  it('lists a pre-migration backup and ignores other files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inlay-list-'))
    const dir2 = join(dir, 'backups')
    const opts = { site, db: join(dir, 'site.db'), backups: dir2 }
    expect(await listBackups(dir2)).toEqual([])
    expect(await listBackups(join(dir, 'missing'))).toEqual([])
    // Only the first system migration has run, so boot has the rest to run and backs up first.
    const db = openDatabase(opts.db)
    await new Migrator({ db, provider: { getMigrations: async () => ({ '0001_content': m0001 }) } }).migrateToLatest()
    await db.destroy()
    await (await bootInlay(opts)).db.destroy()
    const booted = await listBackups(dir2)
    expect(booted.map((b) => b.reason)).toEqual(['pre-migration'])
    await writeFile(join(dir2, '.tmp-x'), 'x')
    await writeFile(join(dir2, 'notes.txt'), 'x')
    await writeFile(join(dir2, 'inlay-backup-2026-01-02T03-04-05-678Z-pre-migration.tar.gz'), 'abc')
    await writeFile(join(dir2, 'inlay-backup-2026-02-02T03-04-05-678Z-manual.tar.gz'), 'abcd')
    const list = await listBackups(dir2)
    expect(list.map((b) => [b.reason, b.createdAt])).toEqual([
      ['manual', '2026-02-02T03:04:05.678Z'],
      ['pre-migration', '2026-01-02T03:04:05.678Z'],
      ['pre-migration', booted[0]!.createdAt],
    ].sort((x, y) => (x[1]! < y[1]! ? 1 : -1)))
    expect(list).toHaveLength(3)
  })
})
