import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  AUTH_BASE_PATH,
  bootInlay,
  createCore,
  defineField,
  defineSite,
  dryRunImport,
  EXPORT_FORMAT_VERSION,
  formatImportReport,
  listBackups,
  inlay,
  IMAGE_WIDTHS,
  markdownToRichText,
  migrateSystem,
  openDatabase,
  restoreBackup,
  richTextToMarkdown,
  z,
  type Activity,
  type AdminTheme,
  type AdminWidget,
  type AuthInfo,
  type Ctx,
  type ExportSummary,
  type CustomTheme,
  type FormValues,
  type AdminHostHooks,
  type ContentDiff,
  type ContentDiffResult,
  type Gap,
  type GapFilter,
  type GapSummary,
  type HiddenDocuments,
  type ImportLocaleReport,
  type ImportReport,
  type ImportResult,
  type ImportTypeReport,
  type Manifest,
  type ReleaseDiff,
  type ReleaseRow,
  type RestoreBackupResult,
  type SiteInput,
  type StructuralDiff,
  type ThemeColor,
  type WidgetProps,
} from '../src/index.js'
import { postSummarySite } from './fixtures/evolve.js'
import { png } from './fixtures/media.js'
import { site } from './fixtures/site.js'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inlay-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

it('runs the draft to publish flow through the public exports only', async () => {
  const db = openDatabase(path.join(dir, 'inlay.db'))
  try {
    await migrateSystem(db)
    const core = createCore({ site, db })
    const ctx: Ctx = { actor: { id: 'u1', name: 'Owner', role: 'owner' }, source: 'admin' }

    await core.applyShippedContent()
    const home = await core.findSingleton('home', 'en')
    expect(home).not.toBeNull()

    const saved = await core.patchDraft(
      home!.id,
      { baseRevisionId: home!.headRev, ops: [{ path: ['slots', 'hero', 'data', 'headline'], value: 'Hello world' }] },
      ctx,
    )
    expect(saved.changed).toBe(true)

    const pending = await core.listPendingChanges()
    expect(pending.map((d) => d.id)).toContain(home!.id)

    const result = await core.publish([home!.id], ctx)
    expect(result.items).toHaveLength(1)

    const published = await core.getDocument(home!.id, { state: 'published' })
    expect(JSON.stringify(published?.data)).toContain('Hello world')

    expect(await core.listRevisions(home!.id)).toHaveLength(2)
    expect((await core.countEntries()).posts).toEqual({ total: 0, changed: 0 })
  } finally {
    await db.destroy()
  }
})

it('exports, dry-runs and imports content through the public exports only', async () => {
  const ctx: Ctx = { actor: { id: 'u1', name: 'Owner', role: 'owner' }, source: 'admin' }
  const a = await bootInlay({ site, db: path.join(dir, 'a.db'), backups: path.join(dir, 'a-backups') })
  const b = await bootInlay({ site, db: path.join(dir, 'b.db'), backups: path.join(dir, 'b-backups') })
  try {
    const home = await a.core.findSingleton('home', 'en')
    await a.core.patchDraft(
      home!.id,
      { baseRevisionId: home!.headRev, ops: [{ path: ['slots', 'hero', 'data', 'headline'], value: 'Exported headline' }] },
      ctx,
    )
    await a.core.publish([home!.id], ctx)

    const archive = path.join(dir, 'export.tar.gz')
    const summary: ExportSummary = await a.core.exportContent(archive, ctx)
    expect(summary.counts.documents).toBeGreaterThan(0)
    expect(EXPORT_FORMAT_VERSION).toBe(1)

    const report: ImportReport = await dryRunImport(site, archive)
    expect(report.ok).toBe(true)
    const types: ImportTypeReport[] = report.types
    const locales: ImportLocaleReport[] = report.locales
    expect(types.length).toBeGreaterThan(0)
    expect(locales.length).toBeGreaterThan(0)
    expect(formatImportReport(report).length).toBeGreaterThan(0)

    const result: ImportResult = await b.core.importContent(archive, ctx)
    expect(result.report.ok).toBe(true)
    const backups = await listBackups(path.join(dir, 'b-backups'))
    expect(backups.map((x) => x.reason)).toContain('pre-import')

    const imported = await b.core.findSingleton('home', 'en')
    const published = await b.core.getDocument(imported!.id, { state: 'published' })
    expect(JSON.stringify(published?.data)).toContain('Exported headline')
  } finally {
    await a.db.destroy()
    await b.db.destroy()
  }
  expect(typeof restoreBackup).toBe('function')
  const types: [Manifest?, RestoreBackupResult?] = []
  expect(types).toHaveLength(0)
})

it('manages media and rich text through the public exports only', async () => {
  const ctx: Ctx = { actor: { id: 'u1', name: 'Owner', role: 'owner' }, source: 'admin' }
  const booted = await bootInlay({
    site,
    db: path.join(dir, 'media.db'),
    backups: path.join(dir, 'backups'),
    media: path.join(dir, 'media'),
  })
  try {
    const { core } = booted
    const { media } = await core.addMedia({ data: await png(1000, 500), filename: 'photo.png' }, ctx)
    const home = await core.findSingleton('home', 'en')
    await core.patchDraft(
      home!.id,
      { baseRevisionId: home!.headRev, ops: [{ path: ['slots', 'hero', 'data', 'image'], value: { media: media.id } }] },
      ctx,
    )
    await core.publish([home!.id], ctx)

    await expect(core.deleteMedia(media.id, ctx)).rejects.toMatchObject({ code: 'in_use' })

    expect(IMAGE_WIDTHS).toContain(320)
    const variant = await core.mediaVariant(media.id, { width: 320, format: 'webp' })
    expect(fs.existsSync(variant.path)).toBe(true)
  } finally {
    await booted.db.destroy()
  }

  const parsed = markdownToRichText('Hello **world**')
  if (!parsed.ok) throw new Error('markdown did not parse')
  expect(richTextToMarkdown(parsed.doc).trim()).toBe('Hello **world**')
})

it('serves pages and redirects through the plugin exports only', async () => {
  const app = Fastify()
  await app.register(inlay, {
    site,
    db: ':memory:',
    baseUrl: 'https://example.com',
    secret: 's'.repeat(32),
    media: path.join(dir, 'media'),
    backups: path.join(dir, 'backups'),
  })
  try {
    const ctx: Ctx = { actor: { id: 'u1', name: 'Owner', role: 'owner' }, source: 'admin' }
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(200)

    await app.inlay.core.createRedirect({ from: '/old', to: '/about' }, ctx)
    expect((await app.inject({ method: 'GET', url: '/old' })).statusCode).toBe(301)

    expect(app.inlay.previewUrl()).toMatch(/^https:\/\/example\.com/)
  } finally {
    await app.close()
  }
})

it('sets up the owner and guards /mcp through the plugin exports only', async () => {
  const baseUrl = 'https://example.com'
  const app = Fastify()
  await app.register(inlay, {
    site,
    db: ':memory:',
    baseUrl,
    secret: 's'.repeat(32),
    media: path.join(dir, 'media'),
    backups: path.join(dir, 'backups'),
    rateLimit: false,
  })
  try {
    const form = (url: string, fields: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: baseUrl },
        payload: new URLSearchParams(fields).toString(),
      })
    const cookieOf = (res: { headers: Record<string, unknown> }) => {
      const header = res.headers['set-cookie']
      const lines = header === undefined ? [] : Array.isArray(header) ? header : [String(header)]
      return lines.map((line: string) => line.split(';')[0]).join('; ')
    }

    expect((await app.inject({ method: 'GET', url: '/admin' })).headers.location).toBe('/admin/setup')
    const password = 'a long enough password'
    const setup = await form('/admin/setup', { name: 'Olivia Owner', email: 'olivia@example.com', password, confirm: password })
    expect(setup.statusCode).toBe(302)
    expect(setup.headers.location).toBe('/admin')

    const login = await form('/admin/login', { email: 'olivia@example.com', password })
    expect(login.statusCode).toBe(302)
    expect(login.headers.location).toBe('/admin')
    const cookie = cookieOf(login)
    expect((await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })).statusCode).toBe(200)
    const session = await app.inject({ method: 'GET', url: `${AUTH_BASE_PATH}/get-session`, headers: { cookie } })
    expect(session.json()).toMatchObject({ user: { email: 'olivia@example.com' } })

    const metadata = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' })
    expect(metadata.statusCode).toBe(200)
    expect(metadata.json()).toMatchObject({ resource: `${baseUrl}/mcp` })

    const mcp = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect(mcp.statusCode).toBe(401)
    expect(mcp.headers['www-authenticate']).toBe(
      `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
    )

    const actor = { id: null, name: 'Script', role: 'editor' as const }
    const info: AuthInfo = { token: 't', clientId: 'api-key', scopes: [], extra: { actor } }
    expect(info.extra.actor.role).toBe('editor')
  } finally {
    await app.close()
  }
})

it('brands the admin and types custom widgets through the public exports only', async () => {
  const color: ThemeColor = 'primary'
  const theme: CustomTheme = { base: 'corporate', scheme: 'light', colors: { [color]: '#0b5fff' } }
  const builtIn: AdminTheme = 'dracula'
  const admin: SiteInput['admin'] = { name: 'Example Studio', theme }
  expect(builtIn).toBe('dracula')

  const widget: AdminWidget = {
    render: (props: WidgetProps) => `${props.name}=${String(props.value)}`,
    parse: (form: FormValues, name) => form.get(name),
  }
  const colorField = defineField(z.string(), { kind: 'color', label: 'Color', admin: widget })
  expect(colorField.parse('#fff')).toBe('#fff')
  const form: FormValues = { get: (name) => (name === 'c' ? 'red' : undefined), all: () => [], names: () => ['c'] }
  expect(widget.parse(form, 'c', { kind: 'color', label: 'Color' }, false)).toBe('red')

  const app = Fastify()
  await app.register(inlay, {
    site: defineSite({ ...site, admin }),
    db: ':memory:',
    baseUrl: 'https://example.com',
    secret: 's'.repeat(32),
    media: path.join(dir, 'media'),
    backups: path.join(dir, 'backups'),
  })
  try {
    const login = await app.inject({ method: 'GET', url: '/admin/login' })
    expect(login.body).toContain('Example Studio')
    expect(login.body).toContain('--color-primary:#0b5fff')

    const activity: Activity[] = await app.inlay.core.recentActivity()
    expect(activity.every((a) => typeof a.at === 'string')).toBe(true)
  } finally {
    await app.close()
  }
})

it('lists gaps after a schema adds a required field through the public exports only', async () => {
  const db = openDatabase(path.join(dir, 'inlay.db'))
  try {
    await migrateSystem(db)
    const ctx: Ctx = { actor: { id: 'u1', name: 'Owner', role: 'owner' }, source: 'admin' }
    const core = createCore({ site, db })
    await core.applyShippedContent()
    const post = await core.createEntry('posts', { slug: 'a', fields: { title: 'A', date: '2026-01-01', body: 'x' } }, ctx)
    await core.publish([post.id], ctx)

    const next = createCore({ site: postSummarySite, db })
    const gaps: Gap[] = await next.listGaps()
    expect(gaps.map((g) => g.document.id)).toEqual([post.id])
    const rows: GapSummary[] = await next.gapSummary()
    expect(rows).toEqual([{ type: 'posts', label: 'Posts', documents: 1, locales: { en: 1 } }])
    const filter: GapFilter = { ids: [post.id] }
    expect((await next.listGaps(filter)).map((g) => g.document.id)).toEqual([post.id])
    const hidden: HiddenDocuments = await next.hiddenDocuments()
    expect(hidden).toEqual({ types: [], locales: [] })
  } finally {
    await db.destroy()
  }
})

it('exports the types the admin host hooks are written with', async () => {
  const structural: StructuralDiff = {
    types: { added: [], removed: [], changed: [] },
    slots: { added: [], removed: [], optional: [], required: [] },
    locales: { added: [], removed: [] },
    fields: [],
    routes: { added: [], removed: [] },
    secrets: [],
    migrations: [],
    shipped: { stale: [] },
  }
  const content: ContentDiff = {
    gaps: [{ type: 'posts', label: 'Posts', documents: 1 }],
    shipped: { created: [], replaced: [], skipped: [], deletedRefs: [], warnings: [] },
    hidden: { types: [], locales: [] },
  }
  const diff: ReleaseDiff = { structural, content }
  const found: ContentDiffResult = { content, warnings: [] }
  const release = { id: 'r-1', name: 'Spring update' } as ReleaseRow
  const hooks: AdminHostHooks = {
    requestActivation: async () => ({ shipped: { created: 0, replaced: 0, skipped: 0 }, migrations: [], backup: null, noop: false, warnings: 0 }),
    contentDiff: async () => found,
    pushFile: async () => ({ release, diff, previewUrl: 'https://example.com/' }),
  }
  expect((await hooks.contentDiff('r-1')).content?.gaps).toHaveLength(1)
  expect((await hooks.pushFile('release.tgz', { pushedBy: null })).release.name).toBe('Spring update')
})

it('inlaycms/site exports what a site needs and nothing of the host', async () => {
  const siteApi = await import('../src/site.js')
  for (const name of ['defineSite', 'defineSingleton', 'defineCollection', 'defineGlobal', 'defineTemplate', 'defineBlock']) {
    expect(siteApi, name).toHaveProperty(name)
  }
  for (const name of ['defineContent', 'defineEntries', 'defineRoute', 'defineMigration', 'defineConfig', 'f', 'z']) {
    expect(siteApi, name).toHaveProperty(name)
  }
  for (const name of ['inlay', 'createCore', 'openDatabase', 'migrateSystem', 'packRelease', 'readRelease', 'sign', 'bootInlay']) {
    expect(siteApi, name).not.toHaveProperty(name)
  }
})

it('exports what a host needs to run a site, not the host internals', async () => {
  const api = await import('../src/index.js')
  for (const name of ['createSiteApp', 'EMPTY_SITE', 'readHostConfig', 'ensureDataDir']) {
    expect(api, name).toHaveProperty(name)
  }
  for (const name of [
    'createSupervisor',
    'storeRelease',
    'activateRelease',
    'writeCurrentPointer',
    'readCurrentPointer',
    'openCurrentRelease',
    'listReleases',
    'getRelease',
    'currentRelease',
    'deleteRelease',
  ]) {
    expect(api, name).not.toHaveProperty(name)
  }
})
