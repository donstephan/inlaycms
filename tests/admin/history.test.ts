import type { FastifyInstance } from 'fastify'
import type { Core } from '../../src/core/core.js'
import { t } from '../../src/core/messages/index.js'
import type { Ctx, DocumentSummary } from '../../src/core/types.js'
import { jpeg } from '../fixtures/media.js'
import { makeApp } from '../helpers/app.js'
import { parseHtml, signIn, type AdminClient } from '../helpers/admin.js'

const textOf = (html: string) => parseHtml(html).body.textContent.replace(/\s+/g, ' ')
const url = (id: string, rest = '') => `/admin/documents/${id}/history${rest}`

describe('admin history', () => {
  let app: FastifyInstance
  let core: Core
  let owner: Ctx
  let eddie: AdminClient
  let home: DocumentSummary

  beforeEach(async () => {
    ;({ app, core, owner } = await makeApp({ withOwner: true }))
    await app.ready()
    eddie = await signIn(app, 'editor@example.com')
    home = (await core.findSingleton('home', 'en'))!
  })
  afterEach(() => app.close())

  const headline = async (value: string, source: 'admin' | 'mcp') => {
    const doc = (await core.getDocument(home.id))!
    await core.patchDraft(
      home.id,
      { baseRevisionId: doc.headRev, ops: [{ path: ['slots', 'hero', 'data', 'headline'], value }] },
      { ...owner, source },
    )
  }

  async function edited() {
    const first = (await core.getDocument(home.id))!
    await headline('Hello', 'admin')
    const hello = (await core.getDocument(home.id))!.headRev
    await headline('Hi', 'mcp')
    return { first, hello }
  }

  it('lists the versions newest first with their sources and badges', async () => {
    const { first } = await edited()
    const res = await eddie.get(url(home.id))
    expect(res.statusCode).toBe(200)
    const rows = [...parseHtml(res.body).querySelectorAll('tbody tr')]
    expect(rows.length).toBeGreaterThanOrEqual(3)
    const text = rows.map((r) => r.textContent.replace(/\s+/g, ' '))
    expect(text.some((r) => r.includes(t('source.admin')))).toBe(true)
    expect(text.some((r) => r.includes(t('source.mcp')))).toBe(true)
    expect(text[0]).toContain(t('admin.history.current'))
    const published = text.find((r) => r.includes(t('admin.history.published')))
    expect(published).toBeDefined()
    expect(first.publishedRev).not.toBeNull()
    expect(rows.at(-1)!.querySelector('a')!.getAttribute('href')).toContain(`/history/${first.publishedRev}`)
  })

  it('shows what changed in a version and since', async () => {
    const { hello } = await edited()
    const res = await eddie.get(url(home.id, `/${hello}`))
    expect(res.statusCode).toBe(200)
    const text = textOf(res.body)
    expect(text).toContain('Hero → Headline: “Welcome to Inlay” → “Hello”')
    expect(text).toContain('“Hello” → “Hi”')
  })

  it('restores a version as a new draft without publishing', async () => {
    const { hello } = await edited()
    const before = (await core.getDocument(home.id))!
    const res = await eddie.post(url(home.id, `/${hello}/restore`), {})
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe(`/admin/documents/${home.id}?notice=restored`)
    const after = (await core.getDocument(home.id))!
    expect(after.publishedRev).toBe(before.publishedRev)
    expect(after.headRev).not.toBe(before.headRev)
    expect(JSON.stringify(after.data)).toContain('Hello')
    expect(after.revision.source).toBe('restore')
  })

  it('shows deleted media by its filename', async () => {
    const media = (await core.addMedia({ filename: 'gone.jpg', data: await jpeg(20, 20) }, owner)).media
    const doc = (await core.getDocument(home.id))!
    await core.patchDraft(
      home.id,
      { baseRevisionId: doc.headRev, ops: [{ path: ['slots', 'hero', 'data', 'image'], value: { media: media.id } }] },
      owner,
    )
    const rev = (await core.getDocument(home.id))!.headRev
    await core.patchDraft(
      home.id,
      { baseRevisionId: rev, ops: [{ path: ['slots', 'hero', 'data', 'image'], value: undefined }] },
      owner,
    )
    await core.deleteMedia(media.id, owner)
    const res = await eddie.get(url(home.id, `/${rev}`))
    expect(res.statusCode).toBe(200)
    expect(textOf(res.body)).toContain('gone.jpg')
  })

  it('is read-only', async () => {
    const { hello } = await edited()
    const doc = parseHtml((await eddie.get(url(home.id, `/${hello}`))).body)
    const section = doc.querySelector('#version')!
    const controls = [...section.querySelectorAll('input, select, textarea')]
    expect(controls.length).toBeGreaterThan(0)
    expect(controls.filter((c) => !c.hasAttribute('disabled'))).toEqual([])
    expect(section.querySelector('button[name=_op]')).toBeNull()
  })

  it('loads the rich text editor on a version page only, so read-only rich text shows', async () => {
    const { hello } = await edited()
    const scripts = (html: string) => [...parseHtml(html).querySelectorAll('script[src]')].map((s) => s.getAttribute('src')!)
    expect(scripts((await eddie.get(url(home.id, `/${hello}`))).body).some((src) => src.startsWith('/admin/assets/editor.js'))).toBe(true)
    expect(scripts((await eddie.get(url(home.id))).body).some((src) => src.includes('editor.js'))).toBe(false)
  })

  it('answers 404 for bad ids', async () => {
    const other = (await core.findSingleton('home', 'es'))!
    const otherRev = (await core.getDocument(other.id))!.headRev
    expect((await eddie.get(url(home.id, `/${otherRev}`))).statusCode).toBe(404)
    expect((await eddie.post(url(home.id, `/${otherRev}/restore`), {})).statusCode).toBe(404)
    expect((await eddie.get(url(home.id, '/abc'))).statusCode).toBe(404)
    expect((await eddie.get(url(home.id, '/999999'))).statusCode).toBe(404)
    expect((await eddie.get(url('nope'))).statusCode).toBe(404)
  })
})
