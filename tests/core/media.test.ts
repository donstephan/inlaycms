import { access } from 'node:fs/promises'
import { html, jpeg, pdf, png, sha256 } from '../fixtures/media.js'
import { makeCore } from '../helpers/core.js'

async function rejects(p: Promise<unknown>, code: string, messageId?: string) {
  const err = await p.then(() => null, (e) => e)
  expect(err).toMatchObject({ code })
  if (messageId) expect(err).toMatchObject({ messageId })
}

describe('media library', () => {
  it('adds an image and records its details', async () => {
    const { core, owner, mediaDir } = await makeCore({ media: true })
    const bytes = await png(40, 20)
    const { media, reused } = await core.addMedia({ data: bytes, filename: 'photo.png' }, owner)
    expect(reused).toBe(false)
    expect(media).toMatchObject({
      id: sha256(bytes), mime: 'image/png', width: 40, height: 20, filename: 'photo.png',
      size: bytes.length, createdBy: 'Olivia Owner', defaultAlt: null,
    })
    await access(`${mediaDir}/${media.id}`)
    await access((await core.mediaFile(media.id)).path)
  })

  it('reuses identical bytes and keeps the first filename', async () => {
    const { core, owner } = await makeCore({ media: true })
    const bytes = await png(10, 10)
    await core.addMedia({ data: bytes, filename: 'photo.png' }, owner)
    const second = await core.addMedia({ data: bytes, filename: 'other.png' }, owner)
    expect(second.reused).toBe(true)
    expect(second.media.filename).toBe('photo.png')
    expect(await core.listMedia()).toHaveLength(1)
  })

  it('detects type from bytes, not name', async () => {
    const { core, owner } = await makeCore({ media: true })
    const p = await core.addMedia({ data: pdf(), filename: 'photo.jpg' }, owner)
    expect(p.media).toMatchObject({ mime: 'application/pdf', width: null, height: null })
    await rejects(core.addMedia({ data: html(), filename: 'x.png' }, owner), 'validation', 'error.mediaTypeNotAllowed')
    const trunc = (await png(40, 40)).subarray(0, 30)
    await rejects(core.addMedia({ data: trunc, filename: 't.png' }, owner), 'validation', 'error.mediaUnreadable')
  })

  it('reports dimensions after EXIF orientation', async () => {
    const { core, owner } = await makeCore({ media: true })
    const { media } = await core.addMedia({ data: await jpeg(40, 20, { orientation: 6 }), filename: 'r.jpg' }, owner)
    expect([media.width, media.height]).toEqual([20, 40])
  })

  it('enforces size limits and rejects empty files', async () => {
    const { core, owner } = await makeCore({ media: true, uploads: { maxBytes: 100 } })
    await rejects(core.addMedia({ data: await png(200, 200), filename: 'big.png' }, owner), 'validation', 'error.mediaTooLarge')
    await rejects(core.addMedia({ data: new Uint8Array(), filename: 'e.png' }, owner), 'validation', 'error.mediaEmpty')
  })

  it('states the size limit in a sensible unit', async () => {
    const big = new Uint8Array(3 * 1024 * 1024).fill(1)
    const limits: Array<[number, string]> = [
      [100, '100 bytes'],
      [50 * 1024, '50 KB'],
      [1536, '1.5 KB'],
      [2 * 1024 * 1024, '2 MB'],
    ]
    for (const [maxBytes, shown] of limits) {
      const { core, owner } = await makeCore({ media: true, uploads: { maxBytes } })
      const err = await core.addMedia({ data: big, filename: 'big.bin' }, owner).then(() => null, (e: Error) => e)
      expect(err?.message).toBe(`The file "big.bin" is too large. Files can be at most ${shown}.`)
    }
  })

  it('lets editors upload and requires a store', async () => {
    const { core, editor } = await makeCore({ media: true })
    await core.addMedia({ data: await png(5, 5), filename: 'a.png' }, editor)
    const none = await makeCore()
    await rejects(none.core.addMedia({ data: await png(5, 5), filename: 'a.png' }, none.owner), 'invalid_operation')
  })

  it('lists, filters and searches', async () => {
    const { core, owner } = await makeCore({ media: true })
    await core.addMedia({ data: await png(5, 5), filename: 'photo.png' }, owner)
    await core.addMedia({ data: pdf(), filename: 'doc.pdf' }, owner)
    expect((await core.listMedia({ kind: 'image' })).map((m) => m.filename)).toEqual(['photo.png'])
    expect((await core.listMedia({ kind: 'file' })).map((m) => m.filename)).toEqual(['doc.pdf'])
    expect((await core.listMedia())[0]?.filename).toBe('doc.pdf')
    expect((await core.listMedia({ search: 'PHO' })).map((m) => m.filename)).toEqual(['photo.png'])
    expect(await core.listMedia({ search: '%' })).toEqual([])
    expect(await core.listMedia({ limit: 1, offset: 1 })).toHaveLength(1)
  })

  it('sets alt text', async () => {
    const { core, owner } = await makeCore({ media: true })
    const { media } = await core.addMedia({ data: await png(5, 5), filename: 'a.png' }, owner)
    expect((await core.setMediaAlt(media.id, '  A cat  ', owner)).defaultAlt).toBe('A cat')
    expect((await core.setMediaAlt(media.id, '', owner)).defaultAlt).toBeNull()
    await rejects(core.setMediaAlt('f'.repeat(64), 'x', owner), 'not_found', 'error.mediaNotFound')
  })

  it('looks up statuses and files', async () => {
    const { core, owner } = await makeCore({ media: true })
    const { media } = await core.addMedia({ data: await png(5, 5), filename: 'a.png' }, owner)
    const found = await core.lookupMedia([media.id, '0'.repeat(64)])
    expect(found.get(media.id)).toMatchObject({ status: 'present' })
    expect(found.get('0'.repeat(64))).toEqual({ status: 'unknown' })
    expect(await core.getMedia('0'.repeat(64))).toBeNull()
    await rejects(core.mediaFile('0'.repeat(64)), 'not_found')
  })
})
