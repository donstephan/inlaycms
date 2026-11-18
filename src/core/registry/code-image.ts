/**
 * An image site code imports (`import hero from './hero.jpg'`), measured when the site is bundled: `source` is the
 * file's `file:` URL, `sha` the sha256 hex of its bytes, `ext` its lowercase extension, and `width` and `height` its
 * displayed size in pixels (after EXIF rotation).
 */
export interface CodeImage {
  readonly kind: 'codeImage'
  source: string
  sha: string
  ext: string
  mime: string
  width: number
  height: number
}

/** True if `v` has the shape of a `CodeImage`. */
export function isCodeImage(v: unknown): v is CodeImage {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    o.kind === 'codeImage' &&
    typeof o.source === 'string' &&
    typeof o.sha === 'string' &&
    typeof o.ext === 'string' &&
    typeof o.mime === 'string' &&
    typeof o.width === 'number' &&
    typeof o.height === 'number'
  )
}
