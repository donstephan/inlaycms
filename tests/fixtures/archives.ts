import { writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import * as tar from 'tar'

export interface ArchiveEntry {
  path: string
  type?: 'File' | 'SymbolicLink' | 'Link' | 'Directory'
  body?: string | Uint8Array
  linkpath?: string
}

/** Writes a .tar.gz with exactly these entries, headers as given (no path sanitizing), so hostile archives can be built. */
export async function writeArchive(file: string, entries: ArchiveEntry[]): Promise<void> {
  const blocks: Buffer[] = []
  for (const e of entries) {
    const type = e.type ?? 'File'
    const body = type === 'File' ? Buffer.from(e.body ?? '') : Buffer.alloc(0)
    const header = Buffer.alloc(512)
    new tar.Header({
      path: e.path,
      type,
      size: body.length,
      mode: type === 'Directory' ? 0o755 : 0o644,
      mtime: new Date(0),
      ...(e.linkpath === undefined ? {} : { linkpath: e.linkpath }),
    }).encode(header, 0)
    blocks.push(header)
    if (body.length > 0) {
      blocks.push(body)
      const pad = (512 - (body.length % 512)) % 512
      if (pad > 0) blocks.push(Buffer.alloc(pad))
    }
  }
  blocks.push(Buffer.alloc(1024))
  await writeFile(file, gzipSync(Buffer.concat(blocks)))
}
