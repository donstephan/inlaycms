import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listBackups } from '../../src/core/backup/backup.js'
import { publishBackupDue, pruneBackups, scheduledBackupDue } from '../../src/core/backup/schedule.js'
import { InlayError } from '../../src/core/errors.js'
import { makeCore } from '../helpers/core.js'

const DAY = 86_400_000
const HOUR = 3_600_000
const START = Date.parse('2026-01-01T00:00:00.000Z')

function clock() {
  const state = { time: START }
  return { state, now: () => new Date(state.time) }
}

describe('scheduledBackup', () => {
  it('backs up once, then reports not due', async () => {
    const { core, backupsDir } = await makeCore({ backups: true })
    const first = await core.scheduledBackup(14)
    expect(first?.reason).toBe('scheduled')
    expect(await listBackups(backupsDir!)).toHaveLength(1)
    expect(await core.scheduledBackup(14)).toBeNull()
  })

  it('is due again 24 hours later', async () => {
    const c = clock()
    const { core } = await makeCore({ backups: true, now: c.now })
    expect(await core.scheduledBackup(14)).not.toBeNull()
    c.state.time += DAY - 1000
    expect(await core.scheduledBackup(14)).toBeNull()
    c.state.time += DAY
    expect(await core.scheduledBackup(14)).not.toBeNull()
  })

  it('prunes after a backup', async () => {
    const c = clock()
    const { core, backupsDir } = await makeCore({ backups: true, now: c.now })
    for (let i = 0; i < 3; i++) {
      await core.scheduledBackup(2)
      c.state.time += DAY
    }
    expect(await listBackups(backupsDir!)).toHaveLength(2)
  })

  it('backs up after a publish, at most once per check', async () => {
    const c = clock()
    const { core, editor, owner } = await makeCore({ backups: true, now: c.now })
    expect((await core.scheduledBackup(14))?.reason).toBe('scheduled')
    c.state.time += HOUR
    expect(await core.scheduledBackup(14)).toBeNull()
    const a = await core.createEntry('posts', { slug: 'a', fields: { title: 'A', date: '2026-01-01', body: 'x' } }, editor)
    expect(await core.scheduledBackup(14)).toBeNull()
    await core.publish([a.id], owner)
    c.state.time += HOUR
    expect((await core.scheduledBackup(14))?.reason).toBe('post-publish')
    c.state.time += HOUR
    expect(await core.scheduledBackup(14)).toBeNull()
    await core.unpublish([a.id], owner)
    c.state.time += HOUR
    expect((await core.scheduledBackup(14))?.reason).toBe('post-publish')
  })

  it('makes only the daily backup when both are due', async () => {
    const c = clock()
    const { core, editor, owner } = await makeCore({ backups: true, now: c.now })
    const a = await core.createEntry('posts', { slug: 'a', fields: { title: 'A', date: '2026-01-01', body: 'x' } }, editor)
    await core.publish([a.id], owner)
    c.state.time += HOUR
    expect((await core.scheduledBackup(14))?.reason).toBe('scheduled')
    expect(await core.scheduledBackup(14)).toBeNull()
  })

  it('needs a backups directory', async () => {
    const { core } = await makeCore()
    await expect(core.scheduledBackup(14)).rejects.toMatchObject({ code: 'config', messageId: 'config.backupsMissing' })
    await expect(core.scheduledBackup(14)).rejects.toBeInstanceOf(InlayError)
  })
})

describe('scheduledBackupDue', () => {
  it('ignores other reasons', () => {
    const now = new Date(START)
    const manual = { path: 'x', createdAt: now.toISOString(), reason: 'manual' as const, size: 1 }
    expect(scheduledBackupDue([manual], now)).toBe(true)
    expect(scheduledBackupDue([{ ...manual, reason: 'scheduled' }], now)).toBe(false)
  })
})

describe('publishBackupDue', () => {
  const backup = (ms: number) => ({ path: 'x', createdAt: new Date(ms).toISOString(), reason: 'manual' as const, size: 1 })

  it('is due when the newest publish is after the newest backup of any kind', () => {
    const at = new Date(START).toISOString()
    expect(publishBackupDue([], null)).toBe(false)
    expect(publishBackupDue([], at)).toBe(true)
    expect(publishBackupDue([backup(START - 1)], at)).toBe(true)
    expect(publishBackupDue([backup(START)], at)).toBe(false)
    expect(publishBackupDue([backup(START + 1), backup(START - 1)], at)).toBe(false)
  })
})

describe('pruneBackups', () => {
  const name = (ms: number, reason: string) =>
    `inlay-backup-${new Date(ms).toISOString().replace(/[:.]/g, '-')}-${reason}.tar.gz`

  it('removes only the oldest scheduled backups beyond keep', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inlay-prune-'))
    const scheduled: string[] = []
    for (let i = 0; i < 16; i++) {
      const n = name(START + i * DAY, 'scheduled')
      scheduled.push(n)
      await writeFile(join(dir, n), 'x')
    }
    const manual = name(START, 'manual')
    const migration = name(START - DAY, 'pre-migration')
    await writeFile(join(dir, manual), 'x')
    await writeFile(join(dir, migration), 'x')
    await writeFile(join(dir, '.tmp-abc'), 'x')
    await writeFile(join(dir, 'notes.txt'), 'x')

    const removed = await pruneBackups(dir, 14)
    expect(removed.map((b) => b.path.split('/').pop()).sort()).toEqual([scheduled[0], scheduled[1]])
    const left = await readdir(dir)
    expect(left).not.toContain(scheduled[0])
    expect(left).not.toContain(scheduled[1])
    expect(left).toEqual(expect.arrayContaining([scheduled[2], manual, migration, '.tmp-abc', 'notes.txt']))
    expect(left).toHaveLength(16 - 2 + 4)
  })
})

describe('pruneBackups post-publish', () => {
  const name = (ms: number, reason: string) =>
    `inlay-backup-${new Date(ms).toISOString().replace(/[:.]/g, '-')}-${reason}.tar.gz`

  it('keeps the newest keep of each pruned kind separately', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inlay-prune-'))
    for (let i = 0; i < 3; i++) {
      await writeFile(join(dir, name(START + i * DAY, 'scheduled')), 'x')
      await writeFile(join(dir, name(START + i * DAY + 1000, 'post-publish')), 'x')
    }
    const removed = await pruneBackups(dir, 2)
    expect(removed.map((b) => b.reason).sort()).toEqual(['post-publish', 'scheduled'])
    expect(removed.map((b) => b.createdAt).sort()).toEqual([
      new Date(START).toISOString(),
      new Date(START + 1000).toISOString(),
    ])
    expect(await listBackups(dir)).toHaveLength(4)
  })
})
