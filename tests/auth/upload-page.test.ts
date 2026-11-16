import type { FastifyInstance } from 'fastify'
import { createUploadToken, UPLOAD_TTL_MS } from '../../src/core/auth/upload-token.js'
import { t } from '../../src/core/messages/index.js'
import { escapeHtml } from '../../src/jsx/html.js'
import { jpeg } from '../fixtures/media.js'
import { makeApp } from '../helpers/app.js'

const ORIGIN = 'https://example.com'
const SECRET = 's'.repeat(32)

const open: FastifyInstance[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(open.splice(0).map((app) => app.close()))
})

async function setup(opts: { maxBytes?: number } = {}) {
  const made = await makeApp({ withOwner: true, ...(opts.maxBytes !== undefined && { uploads: { maxBytes: opts.maxBytes } }) })
  open.push(made.app)
  const token = createUploadToken(SECRET, made.editor.actor.id!, new Date())
  return { ...made, token }
}

/** A multipart body with `file` (and `alt`, when given), as a browser sends it. */
async function multipart(file: { data: Uint8Array; name: string; type: string }, alt?: string) {
  const form = new FormData()
  if (alt !== undefined) form.append('alt', alt)
  form.append('file', new Blob([new Uint8Array(file.data)], { type: file.type }), file.name)
  const request = new Request('https://example.com/', { method: 'POST', body: form })
  return { payload: Buffer.from(await request.arrayBuffer()), contentType: request.headers.get('content-type')! }
}

async function upload(
  app: FastifyInstance,
  token: string,
  file: { data: Uint8Array; name: string; type: string },
  opts: { alt?: string; origin?: string | null } = {},
) {
  const { payload, contentType } = await multipart(file, opts.alt)
  const origin = opts.origin === undefined ? ORIGIN : opts.origin
  return app.inject({
    method: 'POST',
    url: `/admin/upload?token=${encodeURIComponent(token)}`,
    headers: { 'content-type': contentType, ...(origin !== null && { origin }) },
    payload,
  })
}

describe('GET /admin/upload', () => {
  it('shows a form with a labeled file input that accepts the allowed types', async () => {
    const { app, token } = await setup()
    const res = await app.inject({ method: 'GET', url: `/admin/upload?token=${encodeURIComponent(token)}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-robots-tag']).toBe('noindex')
    expect(res.body).toContain('enctype="multipart/form-data"')
    expect(res.body).toContain('<label for="file">')
    expect(res.body).toContain('<label for="alt">')
    expect(res.body).toMatch(/<input id="file" name="file" type="file" accept="image\/jpeg,image\/png,[^"]*application\/pdf"/)
  })

  it('refuses a missing or tampered token', async () => {
    const { app, token } = await setup()
    for (const url of ['/admin/upload', `/admin/upload?token=${encodeURIComponent(token.slice(0, -2))}xx`]) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(403)
      expect(res.body).toContain(escapeHtml(t('admin.upload.expired')))
    }
  })

  it('refuses an expired token', async () => {
    const { app, token } = await setup()
    vi.setSystemTime(Date.now() + UPLOAD_TTL_MS + 1000)
    const res = await app.inject({ method: 'GET', url: `/admin/upload?token=${encodeURIComponent(token)}` })
    expect(res.statusCode).toBe(403)
    expect(res.body).toContain(escapeHtml(t('admin.upload.expired')))
  })

  it("refuses a token for a user who doesn't exist any more", async () => {
    const { app } = await setup()
    const token = createUploadToken(SECRET, 'deleted-user', new Date())
    const res = await app.inject({ method: 'GET', url: `/admin/upload?token=${encodeURIComponent(token)}` })
    expect(res.statusCode).toBe(403)
    expect(res.body).toContain(escapeHtml(t('admin.upload.expired')))
  })
})

describe('POST /admin/upload', () => {
  it('stores the file as the token’s user and says so', async () => {
    const { app, core, editor, token } = await setup()
    const data = await jpeg(20, 10)
    const res = await upload(app, token, { data, name: 'team photo.jpg', type: 'image/jpeg' }, { alt: 'The team' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('team photo.jpg')
    expect(res.body).toContain(escapeHtml(t('admin.upload.done')))
    const [media] = await core.listMedia()
    expect(media).toMatchObject({ filename: 'team photo.jpg', mime: 'image/jpeg', defaultAlt: 'The team' })
    expect(media?.createdBy).toBe(editor.actor.name)
  })

  it('refuses another origin and stores nothing', async () => {
    const { app, core, token } = await setup()
    const res = await upload(app, token, { data: await jpeg(20, 10), name: 'a.jpg', type: 'image/jpeg' }, { origin: 'https://evil.example' })
    expect(res.statusCode).toBe(403)
    expect(await core.listMedia()).toEqual([])
  })

  it('refuses an expired token and stores nothing', async () => {
    const { app, core, token } = await setup()
    vi.setSystemTime(Date.now() + UPLOAD_TTL_MS + 1000)
    const res = await upload(app, token, { data: await jpeg(20, 10), name: 'a.jpg', type: 'image/jpeg' })
    expect(res.statusCode).toBe(403)
    expect(res.body).toContain(escapeHtml(t('admin.upload.expired')))
    expect(await core.listMedia()).toEqual([])
  })

  it('refuses a token for a deleted user and stores nothing', async () => {
    const { app, core } = await setup()
    const token = createUploadToken(SECRET, 'deleted-user', new Date())
    const res = await upload(app, token, { data: await jpeg(20, 10), name: 'a.jpg', type: 'image/jpeg' })
    expect(res.statusCode).toBe(403)
    expect(await core.listMedia()).toEqual([])
  })

  it('shows the type message for a file of the wrong type', async () => {
    const { app, core, token } = await setup()
    const data = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)])
    const res = await upload(app, token, { data, name: 'setup.exe', type: 'application/octet-stream' })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain(escapeHtml(t('error.mediaTypeNotAllowed', { filename: 'setup.exe', types: 'JPEG, PNG, GIF, WebP, AVIF, PDF' })))
    expect(res.body).toContain('<input id="file" name="file" type="file"')
    expect(await core.listMedia()).toEqual([])
  })

  it('shows the size message for a file over the limit', async () => {
    const { app, core, token } = await setup({ maxBytes: 1024 })
    const data = await jpeg(400, 400)
    expect(data.length).toBeGreaterThan(1024)
    const res = await upload(app, token, { data, name: 'big.jpg', type: 'image/jpeg' })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain(escapeHtml(t('error.mediaTooLarge', { filename: 'big.jpg', max: t('size.kb', { n: 1 }) })))
    expect(await core.listMedia()).toEqual([])
  })

  it('asks for a single file when the form carries two, and stores nothing', async () => {
    const { app, core, token } = await setup()
    const form = new FormData()
    for (const name of ['a.jpg', 'b.jpg']) form.append('file', new Blob([new Uint8Array(await jpeg(20, 10))], { type: 'image/jpeg' }), name)
    const request = new Request('https://example.com/', { method: 'POST', body: form })
    const res = await app.inject({
      method: 'POST',
      url: `/admin/upload?token=${encodeURIComponent(token)}`,
      headers: { 'content-type': request.headers.get('content-type')!, origin: ORIGIN },
      payload: Buffer.from(await request.arrayBuffer()),
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain(escapeHtml(t('admin.upload.oneFile')))
    expect(res.body).toContain('<input id="file" name="file" type="file"')
    expect(await core.listMedia()).toEqual([])
  })
})
