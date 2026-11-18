import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { InlayError } from '../../src/core/errors.js'
import { IMAGE_WIDTHS } from '../../src/core/media/variants.js'
import type { CodeImage } from '../../src/core/registry/code-image.js'
import { bundleConfig } from '../../src/core/release/bundle.js'
import sharp from 'sharp'
import { jpeg, pdf, png, sha256 } from '../fixtures/media.js'
import { makeCore } from '../helpers/core.js'

async function rejects(p: Promise<unknown>, code: string, messageId?: string) {
  const err = await p.then(() => null, (e) => e)
  expect(err).toMatchObject({ code })
  if (messageId) expect(err).toMatchObject({ messageId })
}

describe('media variants', () => {
  it('resizes to the requested width and format', async () => {
    const { core, owner } = await makeCore({ media: true })
    const { media } = await core.addMedia({ data: await png(800, 400), filename: 'a.png' }, owner)
    const v = await core.mediaVariant(media.id, { width: 640, format: 'webp' })
    expect(v.mime).toBe('image/webp')
    const meta = await sharp(v.path).metadata()
    expect(meta).toMatchObject({ format: 'webp', width: 640, height: 320 })
  })

  it('never enlarges', async () => {
    const { core, owner } = await makeCore({ media: true })
    const { media } = await core.addMedia({ data: await png(100, 50), filename: 'a.png' }, owner)
    const v = await core.mediaVariant(media.id, { width: 320, format: 'png' })
    expect((await sharp(v.path).metadata()).width).toBe(100)
  })

  it('auto-rotates from EXIF', async () => {
    const { core, owner } = await makeCore({ media: true })
    const { media } = await core.addMedia({ data: await jpeg(80, 40, { orientation: 6 }), filename: 'a.jpg' }, owner)
    const v = await core.mediaVariant(media.id, { width: 320, format: 'jpeg' })
    const meta = await sharp(v.path).metadata()
    expect(meta.height!).toBeGreaterThan(meta.width!)
  })

  it('reuses an existing variant and shares concurrent work', async () => {
    const { core, owner } = await makeCore({ media: true })
    const { media } = await core.addMedia({ data: await png(800, 400), filename: 'a.png' }, owner)
    const [a, b] = await Promise.all([
      core.mediaVariant(media.id, { width: 320, format: 'webp' }),
      core.mediaVariant(media.id, { width: 320, format: 'webp' }),
    ])
    expect(a.path).toBe(b.path)
    const before = (await stat(a.path)).mtimeMs
    await new Promise((r) => setTimeout(r, 20))
    const c = await core.mediaVariant(media.id, { width: 320, format: 'webp' })
    expect(c.path).toBe(a.path)
    expect((await stat(c.path)).mtimeMs).toBe(before)
  })

  it('refuses bad widths, formats, non-images and deleted media', async () => {
    const { core, owner } = await makeCore({ media: true })
    const { media } = await core.addMedia({ data: await png(800, 400), filename: 'a.png' }, owner)
    const doc = await core.addMedia({ data: pdf(), filename: 'a.pdf' }, owner)
    await rejects(core.mediaVariant(media.id, { width: 333, format: 'webp' }), 'not_found', 'error.mediaNotFound')
    await rejects(core.mediaVariant(media.id, { width: 320, format: 'gif' as never }), 'not_found', 'error.mediaNotFound')
    await rejects(core.mediaVariant(doc.media.id, { width: 320, format: 'webp' }), 'not_found', 'error.mediaNotFound')
    await core.deleteMedia(media.id, owner)
    await rejects(core.mediaVariant(media.id, { width: 320, format: 'webp' }), 'not_found', 'error.mediaNotFound')
  })

  it('reports a damaged original as unreadable', async () => {
    const { core, owner } = await makeCore({ media: true })
    const { media } = await core.addMedia({ data: await png(800, 400), filename: 'a.png' }, owner)
    await writeFile((await core.mediaFile(media.id)).path, (await png(800, 400)).subarray(0, 60))
    const err = await core.mediaVariant(media.id, { width: 320, format: 'webp' }).then(() => null, (e) => e)
    expect(err).toBeInstanceOf(InlayError)
    expect(err).toMatchObject({ code: 'invalid_operation', messageId: 'error.mediaUnreadable' })
    expect(err.message).toContain('a.png')
  })

  it('leaves no cached variant behind when the image is deleted while one is being made', async () => {
    const { core, owner, mediaDir } = await makeCore({ media: true })
    const { media } = await core.addMedia({ data: await png(1600, 800), filename: 'a.png' }, owner)
    const making = core.mediaVariant(media.id, { width: 1280, format: 'avif' }).then(
      () => 'made',
      (e: { code: string }) => e.code,
    )
    await core.deleteMedia(media.id, owner)
    expect(['made', 'not_found']).toContain(await making)
    expect(existsSync(`${mediaDir}/cache/${media.id}`)).toBe(false)
  })

  it('needs a media store', async () => {
    const { core } = await makeCore()
    await rejects(core.mediaVariant('x', { width: 320, format: 'webp' }), 'invalid_operation', 'error.mediaNotConfigured')
  })
})

describe('code image variants', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inlay-code-variants-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function file(bytes: Buffer, name = 'a.png') {
    const path = join(dir, name)
    await writeFile(path, bytes)
    return { sha: sha256(bytes), path }
  }

  it('resizes into the media cache under code-<sha>, and reuses it', async () => {
    const { core, mediaDir } = await makeCore({ media: true })
    const f = await file(await png(2000, 1000))
    const v = await core.codeImageVariant(f, { width: 640, format: 'webp' })
    expect(v).toEqual({ path: join(mediaDir!, 'cache', `code-${f.sha}`, '640.webp'), mime: 'image/webp' })
    expect(await sharp(v.path).metadata()).toMatchObject({ format: 'webp', width: 640, height: 320 })
    const before = (await stat(v.path)).mtimeMs
    await new Promise((r) => setTimeout(r, 20))
    expect((await core.codeImageVariant(f, { width: 640, format: 'webp' })).path).toBe(v.path)
    expect((await stat(v.path)).mtimeMs).toBe(before)
  })

  it('auto-rotates from EXIF', async () => {
    const { core } = await makeCore({ media: true })
    const f = await file(await jpeg(80, 40, { orientation: 6 }), 'a.jpg')
    const v = await core.codeImageVariant(f, { width: 320, format: 'jpeg' })
    const meta = await sharp(v.path).metadata()
    expect(meta.height!).toBeGreaterThan(meta.width!)
  })

  it("gives a rotated JPEG the size the import loader measured, even when narrower than every width", async () => {
    const { core } = await makeCore({ media: true })
    const f = await file(await jpeg(30, 10, { orientation: 6 }), 'a.jpg')
    await writeFile(join(dir, 'entry.ts'), "import hero from './a.jpg'\nexport const image = hero\n")
    const outFile = join(dir, 'entry.mjs')
    await bundleConfig(join(dir, 'entry.ts'), outFile)
    const { image } = (await import(pathToFileURL(outFile).href)) as { image: CodeImage }
    const v = await core.codeImageVariant(f, { width: IMAGE_WIDTHS[0], format: 'webp' })
    const meta = await sharp(v.path).metadata()
    expect({ width: image.width, height: image.height }).toEqual({ width: meta.width, height: meta.height })
    expect(image).toMatchObject({ width: 10, height: 30 })
  })

  it('refuses bad widths, formats, a bad sha and a missing file', async () => {
    const { core } = await makeCore({ media: true })
    const f = await file(await png(800, 400))
    await rejects(core.codeImageVariant(f, { width: 333, format: 'webp' }), 'not_found', 'error.mediaNotFound')
    await rejects(core.codeImageVariant(f, { width: 320, format: 'gif' as never }), 'not_found', 'error.mediaNotFound')
    await rejects(core.codeImageVariant({ ...f, sha: '../x' }, { width: 320, format: 'webp' }), 'not_found', 'error.mediaNotFound')
    await rejects(core.codeImageVariant({ ...f, path: join(dir, 'gone.png') }, { width: 320, format: 'webp' }), 'not_found', 'error.mediaNotFound')
  })

  it('needs a media store', async () => {
    const { core } = await makeCore()
    const f = await file(await png(800, 400))
    await rejects(core.codeImageVariant(f, { width: 320, format: 'webp' }), 'invalid_operation', 'error.mediaNotConfigured')
  })
})
