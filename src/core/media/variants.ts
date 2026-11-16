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
