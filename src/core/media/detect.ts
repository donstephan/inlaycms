export const DEFAULT_UPLOAD_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
]

export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024

const RASTER = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'])

const BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
}

const LABELS: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/gif': 'GIF',
  'image/webp': 'WebP',
  'image/avif': 'AVIF',
  'application/pdf': 'PDF',
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  return sig.every((b, i) => bytes[offset + i] === b)
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

export function detectType(bytes: Uint8Array, filename: string): string {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  const head6 = ascii(bytes, 0, 6)
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp'
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12)
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
  }
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf'

  const text = new TextDecoder('utf-8').decode(bytes.subarray(0, 2048)).replace(/^﻿/, '').trimStart().toLowerCase()
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) return 'image/svg+xml'
  if (text.startsWith('<!doctype html') || text.startsWith('<html')) return 'text/html'

  const dot = filename.lastIndexOf('.')
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : ''
  return BY_EXTENSION[ext] ?? 'application/octet-stream'
}

export function isRasterImage(mime: string): boolean {
  return RASTER.has(mime)
}

export function typeLabel(mime: string): string {
  return LABELS[mime] ?? mime
}
