import { access } from 'node:fs/promises'
import { basename } from 'node:path'
import sharp from 'sharp'
import { InlayError } from '../errors.js'
import type { CoreDeps } from '../types.js'
import { isRasterImage } from './detect.js'
import { getMedia, withMediaLock } from './library.js'
import type { MediaStore } from './store.js'

export const IMAGE_WIDTHS = [320, 640, 960, 1280, 1920, 2560] as const

export type VariantFormat = 'webp' | 'avif' | 'jpeg' | 'png'

const MIME: Record<VariantFormat, string> = {
  webp: 'image/webp',
  avif: 'image/avif',
  jpeg: 'image/jpeg',
  png: 'image/png',
}

const inFlight = new WeakMap<MediaStore, Map<string, Promise<string>>>()

function notFound(): InlayError {
  return new InlayError('not_found', 'error.mediaNotFound')
}

export async function mediaVariant(
  deps: CoreDeps,
  id: string,
  opts: { width: number; format: VariantFormat },
): Promise<{ path: string; mime: string }> {
  const store = deps.media
  if (!store) throw new InlayError('invalid_operation', 'error.mediaNotConfigured')
  const { width, format } = opts
  if (!(IMAGE_WIDTHS as readonly number[]).includes(width) || !Object.hasOwn(MIME, format)) throw notFound()
  const media = await getMedia(deps, id)
  if (!media || !isRasterImage(media.mime) || !(await store.has(id))) throw notFound()

  const path = store.variantPath(id, width, format)
  const mime = MIME[format]
  if (await store.hasVariant(id, width, format)) return { path, mime }

  let pending = inFlight.get(store)
  if (!pending) inFlight.set(store, (pending = new Map()))
  const key = `${id}/${width}.${format}`
  let job = pending.get(key)
  if (!job) {
    const jobs = pending
    // Under the media lock, so a variant can't be written after its image was deleted.
    job = withMediaLock(store, id, async () => {
      if (!(await getMedia(deps, id)) || !(await store.has(id))) throw notFound()
      let bytes: Buffer
      try {
        bytes = await sharp(store.path(id))
          .rotate()
          .resize({ width, withoutEnlargement: true })
          .toFormat(format)
          .toBuffer()
      } catch {
        throw new InlayError('invalid_operation', 'error.mediaUnreadable', { filename: media.filename })
      }
      await store.putVariant(id, width, format, bytes)
      return path
    }).finally(() => jobs.delete(key))
    pending.set(key, job)
  }
  await job
  return { path, mime }
}

const SHA = /^[0-9a-f]{64}$/

/**
 * A resized variant of an image site code names (an import or a Markdown image), made from the file at `file.path`
 * and cached in the media store under `code-<sha>`. The caller vouches for the file; there is no media-library lookup.
 */
export async function codeImageVariant(
  deps: CoreDeps,
  file: { sha: string; path: string },
  opts: { width: number; format: VariantFormat },
): Promise<{ path: string; mime: string }> {
  const store = deps.media
  if (!store) throw new InlayError('invalid_operation', 'error.mediaNotConfigured')
  const { width, format } = opts
  if (!(IMAGE_WIDTHS as readonly number[]).includes(width) || !Object.hasOwn(MIME, format)) throw notFound()
  if (!SHA.test(file.sha)) throw notFound()

  const id = `code-${file.sha}`
  const path = store.variantPath(id, width, format)
  const mime = MIME[format]
  if (await store.hasVariant(id, width, format)) return { path, mime }

  let pending = inFlight.get(store)
  if (!pending) inFlight.set(store, (pending = new Map()))
  const key = `${id}/${width}.${format}`
  let job = pending.get(key)
  if (!job) {
    const jobs = pending
    job = (async () => {
      try {
        await access(file.path)
      } catch {
        throw notFound()
      }
      let bytes: Buffer
      try {
        bytes = await sharp(file.path)
          .rotate()
          .resize({ width, withoutEnlargement: true })
          .toFormat(format)
          .toBuffer()
      } catch {
        throw new InlayError('invalid_operation', 'error.mediaUnreadable', { filename: basename(file.path) })
      }
      await store.putVariant(id, width, format, bytes)
      return path
    })().finally(() => jobs.delete(key))
    pending.set(key, job)
  }
  await job
  return { path, mime }
}
