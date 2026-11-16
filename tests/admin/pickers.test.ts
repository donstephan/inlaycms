import type { FastifyInstance } from 'fastify'
import type { Core } from '../../src/core/core.js'
import type { Ctx } from '../../src/core/types.js'
import { jpeg, pdf } from '../fixtures/media.js'
import { makeApp } from '../helpers/app.js'
import { parseHtml, signIn, type AdminClient } from '../helpers/admin.js'

const HX = { 'hx-request': 'true' }

interface Pick {
  value: string
  label: string
  thumb?: string
}

const picksOf = (html: string): Pick[] =>
  [...parseHtml(html).querySelectorAll('[data-pick]')].map((el) => JSON.parse(el.getAttribute('data-pick')!) as Pick)

describe('admin pickers', () => {
  let app: FastifyInstance
  let core: Core
  let owner: Ctx
  let eddie: AdminClient

  beforeEach(async () => {
    ;({ app, core, owner } = await makeApp({ withOwner: true }))
    await app.ready()
    eddie = await signIn(app, 'editor@example.com')
  })
  afterEach(() => app.close())

  it('lists entries of a collection, with the groupId as the value', async () => {
    const maria = await core.createEntry('testimonials', { fields: { author: 'María López', quote: 'Great work' } }, owner)
    await core.createEntry('posts', { fields: { title: 'A post about María', date: '2026-01-01' } }, owner)
    const res = await eddie.get('/admin/pick/entries?collection=testimonials&locale=en', HX)
    expect(res.statusCode).toBe(200)
    const picks = picksOf(res.body)
    expect(picks).toEqual([{ value: maria.groupId, label: 'María López' }])
    expect(res.body).not.toContain('A post about')

    const doc = parseHtml(res.body)
    const search = doc.querySelector('input[type="search"]')!
    expect(doc.querySelector(`label[for="${search.id}"]`)).not.toBeNull()
    expect(search.getAttribute('hx-get')).toContain('/admin/pick/entries?collection=testimonials')
    expect(search.getAttribute('hx-trigger')).toBe('input changed delay:300ms, search')
    expect(doc.querySelector('[aria-live="polite"]')).not.toBeNull()
    for (const button of doc.querySelectorAll('[data-pick]')) expect(button.getAttribute('type')).toBe('button')

    const sam = await core.createEntry('testimonials', { fields: { author: 'Sam Smith', quote: 'Lovely' } }, owner)
    const found = picksOf((await eddie.get('/admin/pick/entries?collection=testimonials&locale=en&q=sam', HX)).body)
    expect(found.map((p) => p.value)).toEqual([sam.groupId])

    await core.deleteEntry(sam.groupId, owner)
    const after = picksOf((await eddie.get('/admin/pick/entries?collection=testimonials&locale=en', HX)).body)
    expect(after.map((p) => p.value)).toEqual([maria.groupId])
  })

  it('answers 404 for a collection that does not exist', async () => {
    expect((await eddie.get('/admin/pick/entries?collection=nope', HX)).statusCode).toBe(404)
    expect((await eddie.get('/admin/pick/entries?collection=about', HX)).statusCode).toBe(404)
  })

  it('lists pages and routed entries to link to, with their address', async () => {
    await core.createEntry('testimonials', { fields: { author: 'Ann', quote: 'All about the team' } }, owner)
    const post = await core.createEntry('posts', { fields: { title: 'About our launch', date: '2026-01-01' } }, owner)
    const res = await eddie.get('/admin/pick/documents?locale=en&q=about', HX)
    expect(res.statusCode).toBe(200)
    const picks = picksOf(res.body)
    const about = (await core.findSingleton('about'))!
    expect(picks).toContainEqual({ value: about.groupId, label: 'About — /about' })
    expect(picks.find((p) => p.value === post.groupId)?.label).toMatch(/^About our launch — \/blog\//)
    expect(res.body).not.toContain('Navigation')
    expect(res.body).not.toContain('Ann')
    expect(picks.map((p) => p.label)).not.toContainEqual(expect.stringContaining('Home'))

    const es = picksOf((await eddie.get('/admin/pick/documents?locale=es&q=acerca', HX)).body)
    expect(es.map((p) => p.value)).toEqual([about.groupId])
    expect(es[0]!.label).toContain('/es/acerca')
  })

  it('lists only images in the image picker, with thumbnails', async () => {
    const image = await core.addMedia({ data: await jpeg(20, 20), filename: 'photo.jpg' }, owner)
    const file = await core.addMedia({ data: pdf(), filename: 'report.pdf' }, owner)
    const images = picksOf((await eddie.get('/admin/pick/media?kind=image', HX)).body)
    expect(images).toEqual([{ value: image.media.id, label: 'photo.jpg', thumb: `/media/${image.media.id}/320.webp` }])
    const files = picksOf((await eddie.get('/admin/pick/media?kind=file', HX)).body)
    expect(files.map((p) => p.value)).toContain(file.media.id)
    const found = picksOf((await eddie.get('/admin/pick/media?kind=file&q=report', HX)).body)
    expect(found.map((p) => p.value)).toEqual([file.media.id])
  })

  it('offers an upload form that returns the picker with the new file first', async () => {
    await core.addMedia({ data: await jpeg(30, 30), filename: 'older.jpg' }, owner)
    const page = parseHtml((await eddie.get('/admin/pick/media?kind=image', HX)).body)
    const form = page.querySelector('form[hx-post]')!
    expect(form.getAttribute('hx-post')).toBe('/admin/media?pick=image')
    expect(form.getAttribute('hx-encoding')).toBe('multipart/form-data')
    const input = form.querySelector('input[type="file"]')!
    expect(page.querySelector(`label[for="${input.id}"]`)).not.toBeNull()

    const data = await jpeg(40, 30)
    const res = await eddie.upload('/admin/media?pick=image', [{ filename: 'new.jpg', data, type: 'image/jpeg' }])
    expect(res.statusCode).toBe(200)
    const listed = (await core.listMedia()).find((m) => m.filename === 'new.jpg')!
    expect(picksOf(res.body)[0]!.value).toBe(listed.id)
    expect(res.body).not.toContain('<html')
  })

  it('does not offer a file that is not an image in the image picker after uploading it', async () => {
    const res = await eddie.upload('/admin/media?pick=image', [{ filename: 'report.pdf', data: pdf(), type: 'application/pdf' }])
    expect(res.statusCode).toBe(200)
    expect(picksOf(res.body)).toEqual([])
    expect(parseHtml(res.body).body.textContent).toContain('report.pdf')
  })

  it('sends an htmx request without a session to log in', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/pick/media?kind=image', headers: HX })
    expect(res.statusCode).toBe(401)
    expect(res.headers['hx-redirect']).toBe('/admin/login')
  })

  it('escapes hostile titles inside data-pick', async () => {
    const hostile = '"><img src=x onerror=alert(1)>'
    await core.createEntry('testimonials', { fields: { author: hostile, quote: 'Hi' } }, owner)
    const res = await eddie.get('/admin/pick/entries?collection=testimonials', HX)
    expect(res.body).toContain('&quot;')
    expect(res.body).not.toContain('<img src=x')
    expect(parseHtml(res.body).querySelector('[onerror]')).toBeNull()
    expect(picksOf(res.body)[0]!.label).toBe(hostile)
  })
})
