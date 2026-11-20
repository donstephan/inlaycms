import type { FastifyInstance } from 'fastify'
import type { Core } from '../../src/core/core.js'
import { t } from '../../src/core/messages/index.js'
import type { Ctx } from '../../src/core/types.js'
import { jpeg, pdf } from '../fixtures/media.js'
import { makeApp } from '../helpers/app.js'
import { parseHtml, signIn, type AdminClient } from '../helpers/admin.js'

const textOf = (html: string) => parseHtml(html).body.textContent.replace(/\s+/g, ' ')

describe('admin media library', () => {
  let app: FastifyInstance
  let core: Core
  let owner: Ctx
  let eddie: AdminClient

  beforeEach(async () => {
    ;({ app, core, owner } = await makeApp({ withOwner: true, uploads: { maxBytes: 20_000 } }))
    await app.ready()
    eddie = await signIn(app, 'editor@example.com')
  })
  afterEach(() => app.close())

  const upload = async (filename: string, data?: Uint8Array, type = 'image/jpeg') =>
    eddie.upload('/admin/media', [{ filename, data: data ?? (await jpeg(40, 30)), type }])

  const setHero = async (value: unknown) => {
    const home = (await core.findSingleton('home'))!
    await core.patchDraft(
      home.id,
      { baseRevisionId: home.headRev, ops: [{ path: ['slots', 'hero', 'data', 'image'], value }] },
      owner,
    )
  }

  it('uploads a file, then reuses identical bytes', async () => {
    const res = await upload('hero.jpg')
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/media?notice=uploaded')
    const grid = await eddie.get('/admin/media?notice=uploaded')
    expect(textOf(grid.body)).toContain('Your files are uploaded')
    expect(textOf(grid.body)).toContain('hero.jpg')
    expect(parseHtml(grid.body).querySelector('img[loading="lazy"]')?.getAttribute('src')).toMatch(/^\/media\/[^/]+\/320\.webp$/)

    const again = await upload('hero.jpg')
    expect(again.headers.location).toBe('/admin/media?notice=reused')
  })

  it('accepts several files at once', async () => {
    const res = await eddie.upload('/admin/media', [
      { filename: 'a.jpg', data: await jpeg(10, 10), type: 'image/jpeg' },
      { filename: 'b.pdf', data: pdf(), type: 'application/pdf' },
    ])
    expect(res.headers.location).toBe('/admin/media?notice=uploaded')
    expect(await core.listMedia()).toHaveLength(2)
    const text = textOf((await eddie.get('/admin/media')).body)
    expect(text).toContain('a.jpg')
    expect(text).toContain('b.pdf')
  })

  it('puts Upload files beside the heading, in a sheet', async () => {
    const doc = parseHtml((await eddie.get('/admin/media')).body)
    const open = doc.querySelector('button[data-sheet-open="upload-media"]')
    expect(open?.classList.contains('btn-primary')).toBe(true)
    expect(open?.textContent.trim()).toBe('Upload files')
    const dialog = doc.querySelector('dialog#upload-media')
    expect(dialog?.hasAttribute('data-sheet-autoopen')).toBe(false)
    expect(dialog?.querySelector('h2')?.textContent.trim()).toBe('Upload files')
    const form = dialog?.querySelector('form[method="post"][action="/admin/media"][enctype="multipart/form-data"]')
    expect(form?.querySelector('input#files[type="file"][multiple]')).not.toBeNull()
    expect(form?.querySelector('#files-hint')).not.toBeNull()
    expect(doc.querySelector('#upload-heading')).toBeNull()
  })

  it('opens the upload sheet from ?sheet=upload only', async () => {
    const asked = parseHtml((await eddie.get('/admin/media?sheet=upload')).body)
    expect(asked.querySelector('dialog#upload-media[data-sheet-autoopen]')).not.toBeNull()
    const other = parseHtml((await eddie.get('/admin/media?sheet=nope')).body)
    expect(other.querySelector('[data-sheet-autoopen]')).toBeNull()
  })

  it('answers the picker upload with the picker, not the library', async () => {
    const res = await eddie.upload('/admin/media?pick=image', [{ filename: 'run.exe', data: Buffer.from('MZ\x90\x00\x03'), type: 'application/octet-stream' }])
    expect(res.statusCode).toBe(200)
    const picked = parseHtml(res.body)
    expect(picked.querySelector('dialog#upload-media')).toBeNull()
    expect(picked.querySelector('form[hx-post^="/admin/media?pick="]')).not.toBeNull()
  })

  it('refuses a file over the limit and one of the wrong type, storing nothing', async () => {
    const big = await upload('big.pdf', Buffer.concat([pdf(), Buffer.alloc(30_000, 32)]), 'application/pdf')
    expect(big.statusCode).toBe(400)
    expect(textOf(big.body)).toContain('The file "big.pdf" is too large. Files can be at most')
    const bigDoc = parseHtml(big.body)
    expect(bigDoc.querySelector('dialog#upload-media[data-sheet-autoopen]')).not.toBeNull()
    expect(bigDoc.querySelector('dialog#upload-media #upload-problems')).not.toBeNull()

    const exe = await upload('run.exe', Buffer.from('MZ\x90\x00\x03'), 'application/octet-stream')
    expect(exe.statusCode).toBe(400)
    expect(textOf(exe.body)).toContain('The file "run.exe" is not a type that can be uploaded')
    expect(await core.listMedia()).toHaveLength(0)
  })

  it('keeps the files stored before a failure', async () => {
    const res = await eddie.upload('/admin/media', [
      { filename: 'ok.jpg', data: await jpeg(10, 10), type: 'image/jpeg' },
      { filename: 'run.exe', data: Buffer.from('MZ\x90\x00\x03'), type: 'application/octet-stream' },
    ])
    expect(res.statusCode).toBe(400)
    expect(textOf(res.body)).toContain('run.exe')
    expect(textOf(res.body)).toContain('ok.jpg')
    const doc = parseHtml(res.body)
    expect(doc.querySelector('dialog#upload-media #upload-problems')).not.toBeNull()
    expect(doc.querySelector('dialog#upload-media #stored-heading')).not.toBeNull()
    const card = [...doc.querySelectorAll('a[href^="/admin/media/"]')].find((a) => !a.closest('dialog') && a.textContent.includes('ok.jpg'))
    expect(card).toBeDefined()
    expect(await core.listMedia()).toHaveLength(1)
  })

  it('shows the file address with a copy button', async () => {
    const { media } = await core.addMedia({ data: await jpeg(40, 30), filename: 'photo.jpg' }, owner)
    const doc = parseHtml((await eddie.get(`/admin/media/${media.id}`)).body)
    const input = doc.querySelector('input#media-address')
    expect(input?.getAttribute('value')).toBe(`https://example.com/media/${media.id}`)
    expect(input?.hasAttribute('readonly')).toBe(true)
    expect(input?.getAttribute('aria-describedby')).toBe('media-address-hint')
    const button = doc.querySelector('button[data-copy="media-address"]')
    expect(button?.textContent.trim()).toBe('Copy')
    expect(button?.getAttribute('data-copied')).toBe('Copied')
  })

  describe('friendly addresses', () => {
    const fileWithRedirect = async () => {
      const { media } = await core.addMedia({ data: await jpeg(40, 30), filename: 'photo.jpg' }, owner)
      await core.createRedirect({ from: '/privacy-policy.pdf', to: `/media/${media.id}` }, owner)
      await core.createRedirect({ from: '/other', to: '/' }, owner)
      return media
    }

    it('lists the redirects that point at the file', async () => {
      const media = await fileWithRedirect()
      const doc = parseHtml((await eddie.get(`/admin/media/${media.id}`)).body)
      const section = doc.querySelector('section[aria-labelledby="redirects-heading"]')
      expect(section?.textContent).toContain('Friendly addresses')
      expect(section?.textContent).toContain('/privacy-policy.pdf')
      expect(section?.textContent).not.toContain('/other')
      expect(section?.querySelector('li a')?.getAttribute('href')).toBe('/admin/redirects')
    })

    it('lists a redirect written as the file\'s full address', async () => {
      const { media } = await core.addMedia({ data: await jpeg(40, 30), filename: 'photo.jpg' }, owner)
      await core.createRedirect({ from: '/privacy-policy.pdf', to: `https://example.com/media/${media.id}` }, owner)
      const detail = parseHtml((await eddie.get(`/admin/media/${media.id}`)).body)
      expect(detail.querySelector('section[aria-labelledby="redirects-heading"]')?.textContent).toContain('/privacy-policy.pdf')
      const del = parseHtml((await eddie.get(`/admin/media/${media.id}/delete`)).body)
      expect(del.querySelector('#delete-redirects')?.textContent).toContain('/privacy-policy.pdf')
    })

    it('says when no redirect points at the file', async () => {
      const { media } = await core.addMedia({ data: await jpeg(40, 30), filename: 'photo.jpg' }, owner)
      expect(textOf((await eddie.get(`/admin/media/${media.id}`)).body)).toContain('No friendly addresses point to this file yet.')
    })

    it('links to a redirect form filled in for the file', async () => {
      const { media } = await core.addMedia({ data: await jpeg(40, 30), filename: 'photo.jpg' }, owner)
      const doc = parseHtml((await eddie.get(`/admin/media/${media.id}`)).body)
      const link = [...doc.querySelectorAll('a')].find((a) => a.getAttribute('href')?.startsWith('/admin/redirects?'))
      const url = new URL(link?.getAttribute('href') ?? '', 'http://x')
      expect(url.pathname).toBe('/admin/redirects')
      expect(url.searchParams.get('sheet')).toBe('add')
      expect(url.searchParams.get('to_path')).toBe(`/media/${media.id}`)
      expect(url.searchParams.get('status')).toBe('302')
    })

    it('warns on delete about addresses that point at the file', async () => {
      const media = await fileWithRedirect()
      const text = textOf((await eddie.get(`/admin/media/${media.id}/delete`)).body)
      expect(text).toContain('These addresses point to this file and will stop working:')
      expect(text).toContain('/privacy-policy.pdf')
      expect(text).not.toContain('/other')
    })
  })

  it('says so when no file was chosen', async () => {
    const res = await eddie.upload('/admin/media', [], { x: 'y' })
    expect(res.statusCode).toBe(400)
    expect(textOf(res.body)).toContain('Choose at least one file')
  })

  it('shows a file, its usage, and refuses to delete it while used', async () => {
    const { media } = await core.addMedia({ data: await jpeg(40, 30), filename: 'photo.jpg' }, owner)
    await setHero({ media: media.id })

    const detail = await eddie.get(`/admin/media/${media.id}`)
    expect(detail.statusCode).toBe(200)
    expect(textOf(detail.body)).toContain('photo.jpg')
    expect(textOf(detail.body)).toContain('40 x 30')
    expect(textOf(detail.body)).toContain('Used in')
    expect(textOf(detail.body)).toContain('Home')
    expect(parseHtml(detail.body).querySelector('img')?.getAttribute('src')).toBe(`/media/${media.id}/960.webp`)

    const confirm = await eddie.get(`/admin/media/${media.id}/delete`)
    expect(confirm.statusCode).toBe(200)
    expect(parseHtml(confirm.body).querySelector(`form[action="/admin/media/${media.id}/delete"]`)).not.toBeNull()

    const refused = await eddie.post(`/admin/media/${media.id}/delete`, {})
    expect(refused.statusCode).toBe(409)
    expect(textOf(refused.body)).toContain('still used')
    expect(textOf(refused.body)).toContain('Home')
    expect(await core.getMedia(media.id)).not.toBeNull()

    await setHero(undefined)
    const gone = await eddie.post(`/admin/media/${media.id}/delete`, {})
    expect(gone.statusCode).toBe(303)
    expect(gone.headers.location).toBe('/admin/media?notice=deleted')
    expect(await core.getMedia(media.id)).toBeNull()
  })

  it('saves and clears the default alt text', async () => {
    const { media } = await core.addMedia({ data: await jpeg(40, 30), filename: 'photo.jpg' }, owner)
    const saved = await eddie.post(`/admin/media/${media.id}/alt`, { alt: 'A red door' })
    expect(saved.statusCode).toBe(303)
    expect(saved.headers.location).toBe(`/admin/media/${media.id}?notice=altSaved`)
    const detail = await eddie.get(saved.headers.location as string)
    expect(parseHtml(detail.body).querySelector('input[name="alt"]')?.getAttribute('value')).toBe('A red door')
    expect(detail.body).toContain(t('admin.notice.altSaved'))
    expect((await core.getMedia(media.id))?.defaultAlt).toBe('A red door')

    await eddie.post(`/admin/media/${media.id}/alt`, { alt: '' })
    expect((await core.getMedia(media.id))?.defaultAlt).toBeNull()
  })

  it('searches by file name', async () => {
    await core.addMedia({ data: await jpeg(10, 10), filename: 'hero-banner.jpg' }, owner)
    await core.addMedia({ data: await jpeg(11, 11), filename: 'team.jpg' }, owner)
    const text = textOf((await eddie.get('/admin/media?q=hero')).body)
    expect(text).toContain('hero-banner.jpg')
    expect(text).not.toContain('team.jpg')
    const files = textOf((await eddie.get('/admin/media?kind=file')).body)
    expect(files).not.toContain('team.jpg')
  })

  it('does not let a hostile file name through as markup', async () => {
    const name = '<img src=x onerror=alert(1)>.jpg'
    const { media } = await core.addMedia({ data: await jpeg(10, 10), filename: name }, owner)
    for (const url of ['/admin/media', `/admin/media/${media.id}`, `/admin/media/${media.id}/delete`]) {
      const res = await eddie.get(url)
      expect(parseHtml(res.body).querySelector('[onerror]')).toBeNull()
      expect(res.body).not.toContain('<img src=x')
    }
  })

  it('answers 404 for an unknown file, and sends the signed-out to log in', async () => {
    expect((await eddie.get('/admin/media/nope')).statusCode).toBe(404)
    expect((await eddie.get('/admin/media/nope/delete')).statusCode).toBe(404)
    expect((await eddie.post('/admin/media/nope/delete', {})).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/admin/media' })).statusCode).toBe(302)
  })
})
