import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { t } from '../../src/core/messages/index.js'
import { png } from '../fixtures/media.js'
import { makeApp } from '../helpers/app.js'
import { parseHtml, signIn, type AdminClient } from '../helpers/admin.js'

describe('read-only admin (a preview worker)', () => {
  let app: FastifyInstance
  let client: AdminClient
  let homeId: string
  let dataDir: string
  const banner = t('admin.readOnly', { name: 'Spring' })

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'inlay-read-only-'))
    const made = await makeApp({
      withOwner: true,
      readOnly: true,
      release: { id: 'rel-1', name: 'Spring' },
      db: join(dataDir, 'inlay.db'),
      releasesDir: join(dataDir, 'releases'),
    })
    app = made.app
    await app.ready()
    client = await signIn(app, 'owner@example.com')
    homeId = (await made.core.findSingleton('home', 'en'))!.id
  })
  afterEach(async () => {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('every admin write is refused', async () => {
    const form = { title: 'x' }
    const responses = [
      await client.post(`/admin/documents/${homeId}`, form),
      await client.upload('/admin/media', [{ filename: 'a.png', data: await png(8, 8), type: 'image/png' }]),
      await client.post('/admin/redirects', { from: '/a', to_path: '/b' }),
      await client.post('/admin/users', { email: 'new@example.com', name: 'New', role: 'editor' }),
      await client.post('/admin/backups', {}),
      await client.post('/admin/releases/upload', {}),
    ]
    for (const res of responses) expect(res.statusCode).toBe(403)
  })

  it('the pages render with the banner naming the release', async () => {
    for (const url of [`/admin/documents/${homeId}`, '/admin', '/admin/media', '/admin/redirects', '/admin/users', '/admin/backups', '/admin/releases']) {
      const res = await client.get(url)
      expect(res.statusCode, url).toBe(200)
      expect(res.body, url).toContain(banner)
    }
  })

  it('the editor controls are disabled or read-only', async () => {
    const doc = parseHtml((await client.get(`/admin/documents/${homeId}`)).body)
    const controls = [...doc.querySelectorAll('#editor-form input:not([type="hidden"]), #editor-form textarea, #editor-form select')]
    expect(controls.length).toBeGreaterThan(0)
    for (const el of controls) {
      const name = el.getAttribute('name') ?? el.getAttribute('id')
      expect(el.hasAttribute('disabled') || el.hasAttribute('readonly'), String(name)).toBe(true)
    }
  })
})
