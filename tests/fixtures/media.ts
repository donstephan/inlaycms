import { createHash } from 'node:crypto'
import sharp from 'sharp'

export function png(width: number, height: number, color = '#3366cc'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer()
}

export function jpeg(width: number, height: number, opts: { orientation?: number } = {}): Promise<Buffer> {
  let img = sharp({ create: { width, height, channels: 3, background: '#cc6633' } })
  if (opts.orientation) img = img.withMetadata({ orientation: opts.orientation })
  return img.jpeg().toBuffer()
}

export function pdf(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')
}

export function html(): Buffer {
  return Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>')
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
