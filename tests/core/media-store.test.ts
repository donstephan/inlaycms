import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { detectType } from '../../src/core/media/detect.js'
import { fileMediaStore, type MediaStore } from '../../src/core/media/store.js'

describe('fileMediaStore', () => {
  let dir: string
  let store: MediaStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inlay-store-'))
    store = fileMediaStore(dir)
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('stores and reads back bytes', async () => {
    expect(await store.has('abc')).toBe(false)
    await store.put('abc', new Uint8Array([1, 2, 3]))
    expect(await store.has('abc')).toBe(true)
    expect([...(await readFile(store.path('abc')))]).toEqual([1, 2, 3])
  })

  it('keeps the first bytes when put again', async () => {
    await store.put('abc', new Uint8Array([1]))
    await store.put('abc', new Uint8Array([9]))
    expect([...(await readFile(store.path('abc')))]).toEqual([1])
  })

  it('tells whether a variant exists', async () => {
    expect(await store.hasVariant('abc', 320, 'webp')).toBe(false)
    await store.putVariant('abc', 320, 'webp', new Uint8Array([2]))
    expect(await store.hasVariant('abc', 320, 'webp')).toBe(true)
    expect(await store.hasVariant('abc', 640, 'webp')).toBe(false)
    expect(await store.hasVariant('abc', 320, 'avif')).toBe(false)
  })

  it('leaves no temp files behind', async () => {
    await store.put('abc', new Uint8Array([1]))
    await store.putVariant('abc', 320, 'webp', new Uint8Array([2]))
    expect((await readdir(dir)).filter((n) => n.startsWith('.tmp-'))).toEqual([])
    expect((await readdir(join(dir, 'cache', 'abc'))).sort()).toEqual(['320.webp'])
    expect(store.variantPath('abc', 320, 'webp')).toBe(join(dir, 'cache', 'abc', '320.webp'))
  })

  it('removes the original and its variants, and tolerates a missing id', async () => {
    await store.put('abc', new Uint8Array([1]))
    await store.putVariant('abc', 320, 'webp', new Uint8Array([2]))
    await store.remove('abc')
    expect(existsSync(store.path('abc'))).toBe(false)
    expect(existsSync(join(dir, 'cache', 'abc'))).toBe(false)
    await expect(store.remove('nope')).resolves.toBeUndefined()
  })

  it('works when the directory does not exist yet', async () => {
    const nested = fileMediaStore(join(dir, 'a', 'b'))
    await nested.put('x', new Uint8Array([1]))
    expect(await nested.has('x')).toBe(true)
    await mkdir(join(dir, 'c'), { recursive: true })
    await writeFile(join(dir, 'c', 'f'), '')
  })
})

describe('detectType', () => {
  const bytes = (...n: number[]) => new Uint8Array([...n, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  const text = (s: string) => new TextEncoder().encode(s)

  it('detects types from magic bytes', () => {
    expect(detectType(bytes(0xff, 0xd8, 0xff, 0xe0), 'a')).toBe('image/jpeg')
    expect(detectType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'a')).toBe('image/png')
    expect(detectType(text('GIF89a....'), 'a')).toBe('image/gif')
    expect(detectType(text('GIF87a....'), 'a')).toBe('image/gif')
    expect(detectType(text('RIFF\0\0\0\0WEBPVP8 '), 'a')).toBe('image/webp')
    expect(detectType(text('\0\0\0\x1cftypavif'), 'a')).toBe('image/avif')
    expect(detectType(text('\0\0\0\x1cftypavis'), 'a')).toBe('image/avif')
    expect(detectType(text('%PDF-1.7\n'), 'a')).toBe('application/pdf')
  })

  it('detects SVG and HTML text', () => {
    expect(detectType(text('﻿  <svg xmlns="x"></svg>'), 'a.png')).toBe('image/svg+xml')
    expect(detectType(text('<?xml version="1.0"?><svg/>'), 'a.png')).toBe('image/svg+xml')
    expect(detectType(text('<!DOCTYPE html><p>'), 'x.png')).toBe('text/html')
    expect(detectType(text('\n<HTML>'), 'x.png')).toBe('text/html')
  })

  it('ignores the extension for what the bytes say', () => {
    expect(detectType(text('%PDF-1.4'), 'photo.jpg')).toBe('application/pdf')
  })

  it('falls back to the extension only for non-image types', () => {
    expect(detectType(text('random'), 'x.png')).toBe('application/octet-stream')
    expect(detectType(text('random'), 'notes.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(detectType(text('a,b'), 'd.CSV')).toBe('text/csv')
  })
})
