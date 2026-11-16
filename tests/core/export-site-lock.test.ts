import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { dryRunImport } from '../../src/core/export/import.js'
import { formatImportReport, siteLockLines } from '../../src/core/export/report.js'
import { readSiteLock } from '../../src/core/site-lock/site-lock.js'
import { site } from '../fixtures/site.js'
import { writeArchive } from '../fixtures/archives.js'
import { makeCore } from '../helpers/core.js'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function temp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'inlay-site-lock-'))
  dirs.push(d)
  return d
}

async function world() {
  const w = await makeCore({ media: true, backups: true })
  dirs.push(w.mediaDir!, w.backupsDir!)
  return w
}
type World = Awaited<ReturnType<typeof world>>

async function exportOf(w: World): Promise<string> {
  const file = join(await temp(), 'export.tar.gz')
  await w.core.exportContent(file, w.owner)
  return file
}

async function unpack(archive: string): Promise<string> {
  const dir = await temp()
  await tar.x({ file: archive, cwd: dir })
  return dir
}

/** An export of `w` with its manifest changed by `edit`. */
async function withManifest(w: World, edit: (manifest: Record<string, unknown>) => void): Promise<string> {
  const dir = await unpack(await exportOf(w))
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  edit(manifest)
  const entries = [
    { path: 'manifest.json', body: JSON.stringify(manifest) },
    ...(['content.ndjson', 'redirects.json', 'media.json'] as const).map(async (n) => ({ path: n, body: await readFile(join(dir, n), 'utf8') })),
  ]
  const archive = join(await temp(), 'edited.tar.gz')
  await writeArchive(archive, await Promise.all(entries))
  return archive
}

describe('site lock in export and import', () => {
  it('exports the lock and the hash, never the password', async () => {
    const source = await world()
    await source.core.setSitePassword('letmein123', source.owner)
    await source.core.setSiteLock(true, source.owner)
    const dir = await unpack(await exportOf(source))
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    expect(manifest.siteLock.enabled).toBe(true)
    expect(manifest.siteLock.passwordHash).toBe((await readSiteLock(source.db)).passwordHash)
    for (const name of await readdir(dir, { recursive: true })) {
      const text = await readFile(join(dir, name)).catch(() => Buffer.alloc(0))
      expect(text.toString('utf8')).not.toContain('letmein123')
    }
  })

  it('import makes the target match the export', async () => {
    const source = await world()
    const target = await world()
    await target.core.setSitePassword('target-pass', target.owner)
    await target.core.setSiteLock(true, target.owner)
    await target.core.importContent(await exportOf(source), target.owner)
    expect(await target.core.siteLock()).toEqual({ enabled: false, hasPassword: false })
  })

  it('import brings the password from the export', async () => {
    const source = await world()
    const target = await world()
    await source.core.setSitePassword('letmein123', source.owner)
    await source.core.setSiteLock(true, source.owner)
    await target.core.importContent(await exportOf(source), target.owner)
    expect((await target.core.siteLock()).enabled).toBe(true)
    expect(await target.core.checkSitePassword('letmein123')).toBe(true)
  })

  it('leaves the lock alone for exports made before it existed', async () => {
    const source = await world()
    const target = await world()
    await target.core.setSitePassword('target-pass', target.owner)
    await target.core.setSiteLock(true, target.owner)
    const archive = await withManifest(source, (manifest) => {
      delete manifest.siteLock
    })
    const dry = await target.core.importDryRun(archive, target.owner)
    expect(dry.siteLock).toBeNull()
    await target.core.importContent(archive, target.owner)
    expect(await target.core.siteLock()).toEqual({ enabled: true, hasPassword: true })
    expect(await target.core.checkSitePassword('target-pass')).toBe(true)
  })

  it('refuses an export with a lock but no usable password', async () => {
    const source = await world()
    const target = await world()
    const states = [
      { enabled: true, passwordHash: null },
      { enabled: false, passwordHash: '' },
      { enabled: false, passwordHash: 'no-colon' },
      { enabled: true, passwordHash: 'a:b:c' },
      { enabled: true, passwordHash: 'salt: key' },
    ]
    for (const siteLock of states) {
      const archive = await withManifest(source, (manifest) => {
        manifest.siteLock = siteLock
      })
      await expect(target.core.importDryRun(archive, target.owner), JSON.stringify(siteLock)).rejects.toMatchObject({
        messageId: 'error.exportInvalid',
      })
    }
    const fine = await withManifest(source, (manifest) => {
      manifest.siteLock = { enabled: false, passwordHash: 'test-sha256:abc' }
    })
    expect((await target.core.importDryRun(fine, target.owner)).siteLock?.effects).toEqual(['set'])
  })

  it('says what the import will do to the lock', async () => {
    const locked = await world()
    await locked.core.setSitePassword('letmein123', locked.owner)
    await locked.core.setSiteLock(true, locked.owner)
    const lockedArchive = await exportOf(locked)
    const publicArchive = await exportOf(await world())

    const publicTarget = await world()
    const on = await publicTarget.core.importDryRun(lockedArchive, publicTarget.owner)
    expect(on.siteLock?.effects).toEqual(['on', 'set'])
    const lines = formatImportReport(on)
    expect(lines).toContain('This will make the site private, so visitors need a password.')
    expect(lines).toContain('This will set a site password.')

    const lockedTarget = await world()
    await lockedTarget.core.setSitePassword('other-pass1', lockedTarget.owner)
    await lockedTarget.core.setSiteLock(true, lockedTarget.owner)
    const off = await lockedTarget.core.importDryRun(publicArchive, lockedTarget.owner)
    expect(off.siteLock?.effects).toEqual(['off', 'removed'])

    const same = await publicTarget.core.importDryRun(publicArchive, publicTarget.owner)
    expect(same.siteLock?.effects).toEqual([])
  })

  it('describes the export when the receiving site is unknown', async () => {
    const report = await dryRunImport(site, await exportOf(await world()))
    expect(report.siteLock).toEqual({ enabled: false, hasPassword: false, effects: null })
    expect(siteLockLines(report.siteLock)).toEqual(['This export makes the site public.', 'This export has no site password.'])
  })

  it('clears the page cache on import', async () => {
    const source = await world()
    const target = await world()
    let fired = 0
    target.core.onLiveChange(() => {
      fired++
    })
    await target.core.importContent(await exportOf(source), target.owner)
    expect(fired).toBeGreaterThan(0)
  })
})
