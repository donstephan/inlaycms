import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { z } from 'zod'
import { f } from '../../src/core/fields/builtins.js'
import { formatImportReport, integrationLines } from '../../src/core/export/report.js'
import { readIntegrationRows } from '../../src/core/integrations/integrations.js'
import { defineIntegration } from '../../src/core/registry/integration.js'
import { site as fixtureSite } from '../fixtures/site.js'
import { writeArchive } from '../fixtures/archives.js'
import { makeCore } from '../helpers/core.js'

const gtm = defineIntegration({
  name: 'gtm',
  label: 'Tag manager',
  fields: z.object({ id: f.text({ label: 'Container ID' }) }),
  head: () => '',
})
const chat = defineIntegration({ name: 'chat', label: 'Chat', head: () => '' })
const site = { ...fixtureSite, integrations: [gtm, chat] }

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function temp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'inlay-integrations-'))
  dirs.push(d)
  return d
}

async function world(s = site) {
  const w = await makeCore({ site: s, media: true, backups: true })
  dirs.push(w.mediaDir!, w.backupsDir!)
  return w
}
type World = Awaited<ReturnType<typeof world>>

async function exportOf(w: World): Promise<string> {
  const file = join(await temp(), 'export.tar.gz')
  await w.core.exportContent(file, w.owner)
  return file
}

async function withManifest(w: World, edit: (manifest: Record<string, unknown>) => void): Promise<string> {
  const dir = await temp()
  await tar.x({ file: await exportOf(w), cwd: dir })
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  edit(manifest)
  const entries = [
    { path: 'manifest.json', body: JSON.stringify(manifest) },
    ...(await Promise.all(
      (['content.ndjson', 'redirects.json', 'media.json'] as const).map(async (n) => ({ path: n, body: await readFile(join(dir, n), 'utf8') })),
    )),
  ]
  const archive = join(await temp(), 'edited.tar.gz')
  await writeArchive(archive, entries)
  return archive
}

async function configured(w: World) {
  await w.core.saveIntegration('gtm', { enabled: true, values: { id: 'GTM-A1' } }, w.owner)
  await w.core.saveIntegration('chat', { enabled: false, values: {} }, w.owner)
}

const rows = async (w: World) => (await readIntegrationRows(w.db)).map(({ name, enabled, values }) => ({ name, enabled, values }))

describe('integrations in export and import', () => {
  it('an export carries every saved row', async () => {
    const source = await world()
    await configured(source)
    const dir = await temp()
    await tar.x({ file: await exportOf(source), cwd: dir })
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    expect(manifest.formatVersion).toBe(2)
    expect(manifest.integrations).toEqual([
      { name: 'chat', enabled: false, values: {} },
      { name: 'gtm', enabled: true, values: { id: 'GTM-A1' } },
    ])
  })

  it('import replaces the settings', async () => {
    const target = await world()
    await configured(target)
    const archive = await exportOf(target)
    const exported = await rows(target)
    await target.core.saveIntegration('gtm', { enabled: true, values: { id: 'GTM-B2' } }, target.owner)
    await target.core.saveIntegration('chat', { enabled: true, values: {} }, target.owner)
    await target.core.importContent(archive, target.owner)
    expect(await rows(target)).toEqual(exported)
    expect((await target.core.activeIntegrations()).map((a) => [a.def.name, a.values])).toEqual([['gtm', { id: 'GTM-A1' }]])
  })

  it('import into a site that has rows the export lacks removes them', async () => {
    const source = await world()
    const target = await world()
    await configured(target)
    await target.core.importContent(await exportOf(source), target.owner)
    expect(await rows(target)).toEqual([])
  })

  it('an export from before this feature leaves the settings alone', async () => {
    const source = await world()
    const target = await world()
    await configured(target)
    const before = await rows(target)
    const archive = await withManifest(source, (manifest) => {
      delete manifest.integrations
    })
    const dry = await target.core.importDryRun(archive, target.owner)
    expect(dry.integrations).toBeNull()
    expect(integrationLines(dry)).toEqual([])
    await target.core.importContent(archive, target.owner)
    expect(await rows(target)).toEqual(before)
  })

  it('the dry run reports them and changes nothing', async () => {
    const source = await world()
    await configured(source)
    const target = await world()
    const dry = await target.core.importDryRun(await exportOf(source), target.owner)
    expect(dry.integrations).toEqual([
      { name: 'chat', enabled: false },
      { name: 'gtm', enabled: true },
    ])
    expect(integrationLines(dry)).toEqual(['Integration settings will be replaced: chat (off), gtm (on)'])
    expect(formatImportReport(dry)).toContain('Integration settings will be replaced: chat (off), gtm (on)')
    expect(await rows(target)).toEqual([])
  })

  it('a row for an integration this site does not define is imported and stays dormant', async () => {
    const source = await world()
    const target = await world(fixtureSite)
    const archive = await withManifest(source, (manifest) => {
      manifest.integrations = [{ name: 'other', enabled: true, values: { x: 1 } }]
    })
    await target.core.importContent(archive, target.owner)
    expect(await rows(target)).toEqual([{ name: 'other', enabled: true, values: { x: 1 } }])
    expect(await target.core.activeIntegrations()).toEqual([])
  })

  it('an export naming one integration twice is refused as invalid and changes nothing', async () => {
    const source = await world()
    const target = await world()
    await configured(target)
    const before = await rows(target)
    const archive = await withManifest(source, (manifest) => {
      manifest.integrations = [
        { name: 'gtm', enabled: true, values: { id: 'GTM-A1' } },
        { name: 'gtm', enabled: false, values: {} },
      ]
    })
    await expect(target.core.importDryRun(archive, target.owner)).rejects.toMatchObject({ messageId: 'error.exportInvalid' })
    await expect(target.core.importContent(archive, target.owner)).rejects.toMatchObject({ messageId: 'error.exportInvalid' })
    expect(await rows(target)).toEqual(before)
  })

  it('an import is a live change', async () => {
    const source = await world()
    await configured(source)
    const target = await world()
    let fired = 0
    target.core.onLiveChange(() => {
      fired++
    })
    await target.core.importContent(await exportOf(source), target.owner)
    expect(fired).toBe(1)
  })
})
