import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import * as tar from 'tar'
import { loadConfig } from '../../config.js'
import { shippedFiles } from '../content/shipped-input.js'
import { realInsideSync } from '../content/shipped-images.js'
import { InlayError } from '../errors.js'
import { buildRegistry } from '../registry/registry.js'
import { bundleSite } from './bundle.js'
import { publicClashes, publicClashError } from './public-files.js'
import { sign } from './keys.js'
import { contentPath, manifestOfRegistry, sha256Hex, type ReleaseManifest } from './manifest.js'

/** Every regular file under `dir`, as `/`-separated paths relative to it. Dotfiles and symlinks are left out. */
export async function listFiles(dir: string, skipDotfiles = false): Promise<string[]> {
  const out: string[] = []
  const walk = async (at: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      if (skipDotfiles && entry.name.startsWith('.')) continue
      const full = join(at, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push(relative(dir, full).split(sep).join(posix.sep))
    }
  }
  await walk(dir)
  return out.sort()
}

/** `<short commit>-<YYYYMMDD>` when `dir` is in a git checkout, else the date. */
export async function releaseName(dir: string, now: Date): Promise<string> {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '')
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir })
    const commit = stdout.trim()
    return commit === '' ? date : `${commit}-${date}`
  } catch {
    return date
  }
}

/**
 * Turns the site at `configFile` into a signed release file at `out`: the bundled site code, the files its
 * shipped content names, the `public/` folder beside the config, and a manifest of them signed with `privateKey`.
 * Never runs the bundle.
 */
export async function packRelease(opts: {
  configFile: string
  privateKey: string
  out: string
  name?: string
  now?: () => Date
}): Promise<{ manifest: ReleaseManifest; out: string }> {
  const now = (opts.now ?? (() => new Date()))()
  const { config, file, dir } = await loadConfig(opts.configFile)
  const registry = buildRegistry(config.site)
  const tmp = await mkdtemp(join(tmpdir(), 'inlay-pack-'))
  try {
    const bundled = await bundleSite(file, join(tmp, 'site.js'))

    const content: ReleaseManifest['content'] = []
    const codeImages = new Set(bundled.codeImages)
    const sources = shippedFiles(registry)
    const known = new Set(sources.map((s) => s.source))
    const siteDir = pathToFileURL(dir).href + '/'
    for (const source of bundled.codeImages) {
      if (known.has(source)) continue
      const path = fileURLToPath(source)
      sources.push({ source, path, read: realInsideSync(path, siteDir) ?? path })
    }
    if (sources.length > 0) await mkdir(join(tmp, 'content'))
    for (const { source, path, read } of sources) {
      let bytes: Buffer
      try {
        bytes = await readFile(read)
      } catch {
        throw new InlayError('release', 'error.packFile', { path })
      }
      const target = contentPath(path, bytes)
      await writeFile(join(tmp, target), bytes)
      content.push({ source, path: target, ...(codeImages.has(source) && { code: true as const }) })
    }

    const publicDir = join(dir, 'public')
    if (existsSync(publicDir)) {
      const [clash] = await publicClashes(publicDir, registry)
      if (clash) throw publicClashError(clash)
      for (const path of await listFiles(publicDir, true)) {
        await mkdir(dirname(join(tmp, 'public', path)), { recursive: true })
        await copyFile(join(publicDir, path), join(tmp, 'public', path))
      }
    }

    const files: Record<string, string> = {}
    for (const path of await listFiles(tmp)) files[path] = sha256Hex(await readFile(join(tmp, path)))

    const manifest: ReleaseManifest = {
      ...manifestOfRegistry(registry, { name: opts.name ?? (await releaseName(dir, now)), now, content }),
      files,
    }
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
    await writeFile(join(tmp, 'manifest.json'), bytes)
    await writeFile(join(tmp, 'manifest.sig'), sign(opts.privateKey, bytes))

    const entries = ['manifest.json', 'manifest.sig', 'site.js', 'content', 'public'].filter((e) => existsSync(join(tmp, e)))
    await mkdir(dirname(opts.out), { recursive: true })
    await tar.c({ gzip: true, cwd: tmp, portable: true, file: opts.out }, entries)
    return { manifest, out: opts.out }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}
