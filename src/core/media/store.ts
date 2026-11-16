import { randomUUID } from 'node:crypto'
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface MediaStore {
  dir: string
  path(id: string): string
  variantPath(id: string, width: number, format: string): string
  has(id: string): Promise<boolean>
  hasVariant(id: string, width: number, format: string): Promise<boolean>
  put(id: string, bytes: Uint8Array): Promise<void>
  putVariant(id: string, width: number, format: string, bytes: Uint8Array): Promise<void>
  remove(id: string): Promise<void>
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function writeAtomic(dir: string, target: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const tmp = join(dir, `.tmp-${randomUUID()}`)
  try {
    await writeFile(tmp, bytes)
    await rename(tmp, target)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

export function fileMediaStore(dir: string): MediaStore {
  const path = (id: string) => join(dir, id)
  const variantPath = (id: string, width: number, format: string) => join(dir, 'cache', id, `${width}.${format}`)
  return {
    dir,
    path,
    variantPath,
    has: (id) => exists(path(id)),
    hasVariant: (id, width, format) => exists(variantPath(id, width, format)),
    async put(id, bytes) {
      if (await exists(path(id))) return
      await mkdir(dir, { recursive: true })
      await writeAtomic(dir, path(id), bytes)
    },
    async putVariant(id, width, format, bytes) {
      await mkdir(dir, { recursive: true })
      await writeAtomic(dir, variantPath(id, width, format), bytes)
    },
    async remove(id) {
      await rm(path(id), { force: true })
      await rm(join(dir, 'cache', id), { recursive: true, force: true })
    },
  }
}
