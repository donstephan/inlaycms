import { existsSync } from 'node:fs'
import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import * as tar from 'tar'
import { stagingDir } from '../../src/adapters/admin/screens/backups.js'
import type { Core } from '../../src/core/core.js'
import type { Ctx } from '../../src/core/types.js'
import { writeArchive } from '../fixtures/archives.js'
import { makeApp } from '../helpers/app.js'
import { makeCore } from '../helpers/core.js'
import { mcpClient } from '../helpers/mcp.js'
import { parseHtml, signIn, submittedForm, type AdminClient } from '../helpers/admin.js'

const TOKEN = /\/admin\/backups\/import\/([0-9a-f-]{36})$/

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function temp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'inlay-admin-import-'))
  dirs.push(d)
  return d
}

const staged = async (): Promise<string[]> => (await readdir(await stagingDir()).catch(() => [])).sort()
const exports = async (): Promise<string[]> => (await readdir(tmpdir())).filter((n) => /^inlay-export-.*\.tar\.gz$/.test(n)).sort()

const gz = (data: Uint8Array | Buffer) => ({ name: 'archive', filename: 'export.tar.gz', data, type: 'application/gzip' })

describe('admin export and import', () => {
  let app: FastifyInstance
  let core: Core
  let owner: Ctx
  let olivia: AdminClient
  let eddie: AdminClient

  beforeEach(async () => {
    ;({ app, core, owner } = await makeApp({ withOwner: true }))
    await app.ready()
    olivia = await signIn(app, 'owner@example.com')
    eddie = await signIn(app, 'editor@example.com')
  })
  afterEach(() => app.close())

  async function download(client = olivia): Promise<Buffer> {
    const res = await client.get('/admin/backups/export')
    expect(res.statusCode).toBe(200)
    return res.rawPayload
  }

  async function extracted(bytes: Buffer): Promise<string> {
    const dir = await temp()
    const file = join(dir, 'x.tar.gz')
    await writeFile(file, bytes)
    await tar.x({ file, cwd: dir })
    return dir
  }

  it('removes its staging folder when the app closes', async () => {
    const dir = await stagingDir()
    expect(existsSync(dir)).toBe(true)
    await app.close()
    expect(existsSync(dir)).toBe(false)
  })

  it('offers the export and the upload on the Backups & export page', async () => {
    const page = parseHtml((await olivia.get('/admin/backups')).body)
    expect(page.querySelector('h1')!.textContent).toContain('Backups & export')
    expect(page.querySelector('a[href="/admin/backups/export"]')).not.toBeNull()
    const form = page.querySelector('form[action="/admin/backups/import"]')!
    expect(form.getAttribute('enctype')).toBe('multipart/form-data')
    const input = form.querySelector('input#import-archive')!
    expect(input.getAttribute('name')).toBe('archive')
    expect(input.getAttribute('type')).toBe('file')
    expect(form.querySelector('label[for="import-archive"]')).not.toBeNull()
  })

  it('downloads an export and leaves no temp file behind', async () => {
    const before = await exports()
    const res = await olivia.get('/admin/backups/export')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/gzip')
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="inlay-export-.+\.tar\.gz"$/)
    expect(Number(res.headers['content-length'])).toBe(res.rawPayload.length)
    const dir = await extracted(res.rawPayload)
    expect(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')).format).toBe('inlay-export')
    for (let i = 0; i < 50 && (await exports()).join() !== before.join(); i++) await new Promise((r) => setTimeout(r, 20))
    expect(await exports()).toEqual(before)
  })

  it('reports a compatible upload as ready, with no force checkbox', async () => {
    const res = await olivia.upload('/admin/backups/import', [gz(await download())])
    expect(res.statusCode).toBe(200)
    const page = parseHtml(res.body)
    expect(page.querySelector('h1')!.textContent).toContain('Review the export')
    const rows = [...page.querySelectorAll('tbody tr')].map((r) => r.textContent ?? '')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.includes('Ready'))).toBe(true)
    expect(page.body.textContent).toContain('Restore content')
    expect(page.querySelector('input[name="force"]')).toBeNull()
    expect(page.querySelector('form[action^="/admin/backups/import/"]')).not.toBeNull()
  })

  it('tells the editor an import will make the site private', async () => {
    const w = await makeCore({ media: true })
    dirs.push(w.mediaDir!)
    await w.core.setSitePassword('letmein123', w.owner)
    await w.core.setSiteLock(true, w.owner)
    const file = join(await temp(), 'locked.tar.gz')
    await w.core.exportContent(file, w.owner)
    const res = await olivia.upload('/admin/backups/import', [gz(await readFile(file))])
    expect(res.statusCode).toBe(200)
    expect(parseHtml(res.body).body.textContent).toContain('This will make the site private, so visitors need a password.')
  })

  it('restores on confirm and keeps the users', async () => {
    const before = await staged()
    const upload = await olivia.upload('/admin/backups/import', [gz(await download())])
    expect(upload.statusCode).toBe(200)
    expect((await staged()).length).toBe(before.length + 1)
    const action = parseHtml(upload.body).querySelector('form[action^="/admin/backups/import/"]')!.getAttribute('action')!
    expect(action).toMatch(TOKEN)

    const done = await olivia.post(action, submittedForm(upload.body, { form: `form[action="${action}"]` }))
    expect(done.statusCode).toBe(303)
    expect(done.headers.location).toMatch(/^\/admin\/backups\?notice=contentImported&documents=\d+$/)

    expect((await olivia.get('/admin')).statusCode).toBe(200)
    expect((await signIn(app, 'editor@example.com')).cookie).not.toBe('')

    const page = await olivia.get(done.headers.location as string)
    expect(page.body).toContain('Before restoring content')
    expect(page.body).toContain('Content restored')
    expect(await staged()).toEqual(before)
  })

  it('rejects bad uploads with a plain message', async () => {
    const junk = await olivia.upload('/admin/backups/import', [gz(Buffer.from('this is not an archive'))])
    expect(junk.statusCode).toBe(400)
    expect(parseHtml(junk.body).querySelector('[role="alert"]')!.textContent).toContain("That file couldn't be read")
    const none = await olivia.upload('/admin/backups/import', [], { note: 'x' })
    expect(none.statusCode).toBe(400)
    expect(parseHtml(none.body).querySelector('[role="alert"]')!.textContent).toContain('Choose')
    const empty = await olivia.upload('/admin/backups/import', [gz(Buffer.alloc(0))])
    expect(empty.statusCode).toBe(400)
    expect(parseHtml(empty.body).querySelector('[role="alert"]')!.textContent).toContain('Choose')
  })

  it('cleans up after a rejected archive', async () => {
    const before = await staged()
    await olivia.upload('/admin/backups/import', [gz(Buffer.from('nope'))])
    expect(await staged()).toEqual(before)
  })

  it('404s on bad tokens', async () => {
    expect((await olivia.post('/admin/backups/import/not-a-token', {})).statusCode).toBe(404)
    expect((await olivia.post('/admin/backups/import/00000000-0000-0000-0000-000000000000', {})).statusCode).toBe(404)
  })

  it('keeps the editor out of every route', async () => {
    expect((await eddie.get('/admin/backups/export')).statusCode).toBe(403)
    const before = await staged()
    expect((await eddie.upload('/admin/backups/import', [gz(await download())])).statusCode).toBe(403)
    expect(await staged()).toEqual(before)

    const upload = await olivia.upload('/admin/backups/import', [gz(await download())])
    const action = parseHtml(upload.body).querySelector('form[action^="/admin/backups/import/"]')!.getAttribute('action')!
    const documents = await core.listPendingChanges()
    expect((await eddie.post(action, {})).statusCode).toBe(403)
    expect(await core.listPendingChanges()).toEqual(documents)
    expect(existsSync(join(await stagingDir(), `${action.match(TOKEN)![1]}.tar.gz`))).toBe(true)
    await olivia.post(action, {})
  })

  it('offers no export, import or backup tool over MCP', async () => {
    const mcp = await mcpClient({ core, actor: owner.actor })
    try {
      const { tools } = await mcp.client.listTools()
      expect(tools.length).toBeGreaterThan(0)
      expect(tools.filter((tool) => /export|import|backup/.test(tool.name))).toEqual([])
    } finally {
      await mcp.close()
    }
  })

  it('stages uploads in a private folder of its own', async () => {
    const dir = await stagingDir()
    expect(basename(dir)).toMatch(/^inlay-imports-.+/)
    expect((await lstat(dir)).mode & 0o777).toBe(0o700)
    expect(await stagingDir()).toBe(dir)
    await rm(dir, { recursive: true })
    const target = await temp()
    await symlink(target, dir)
    const next = await stagingDir()
    expect(next).not.toBe(dir)
    expect((await lstat(next)).isDirectory()).toBe(true)
    await rm(dir)
  })

  it('escapes hostile names in the report', async () => {
    const dir = await extracted(await download())
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    const hostile = 'x<script>alert(1)</script>'
    manifest.types.push({ ...manifest.types[0], kind: 'collection', name: hostile, label: hostile })
    const record = { record: 'document', id: 'd-hostile', kind: 'entry', type: hostile, groupId: 'g-hostile', locale: 'en', headRevision: null, publishedRevision: null, deletedAt: null, createdAt: '2026-01-01T00:00:00.000Z' }
    const content = (await readFile(join(dir, 'content.ndjson'), 'utf8')) + `${JSON.stringify(record)}\n`
    manifest.counts.documents += 1
    const out = join(await temp(), 'hostile.tar.gz')
    await writeArchive(out, [
      { path: 'manifest.json', body: JSON.stringify(manifest) },
      { path: 'content.ndjson', body: content },
      { path: 'redirects.json', body: await readFile(join(dir, 'redirects.json'), 'utf8') },
      { path: 'media.json', body: await readFile(join(dir, 'media.json'), 'utf8') },
    ])
    const res = await olivia.upload('/admin/backups/import', [gz(await readFile(out))])
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('<script>alert(1)')
    expect(res.body).toContain('x&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})
