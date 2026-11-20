import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type { InlayConfig } from '../../config.js'
import { extractArchive } from '../archive.js'
import { InlayError } from '../errors.js'
import type { SiteDefinition } from '../registry/define.js'
import { buildRegistry } from '../registry/registry.js'
import { inlayVersion as currentVersion } from '../version.js'
import { fingerprint, verify } from './keys.js'
import { manifestSchema, sha256Hex, type ReleaseManifest } from './manifest.js'
import { SITE_DIR_EXPORT } from './site-dir.js'
import { releaseFit, runningWindow } from './window.js'

export interface LoadedRelease {
  manifest: ReleaseManifest
  site: SiteDefinition
  dir: string
  /** Each shipped file's source as the site names it, to the release's copy. */
  shippedFiles: Map<string, string>
  /** As `shippedFiles`, only the images `.md` files the site imports name: what `/media/files/` serves. */
  codeFiles: Map<string, string>
  publicDir: string | null
}

const SIGNED = new Set(['manifest.json', 'manifest.sig'])

/** `.ts` when running from `src/` (tsx, vitest), `.js` from `dist/`. */
const EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
const entry = (path: string) => fileURLToPath(new URL(`../../${path}${EXT}`, import.meta.url))

/**
 * The running copy of each `inlaycms` entry point. Site code must import these files, not another copy of the
 * package (from `src/` the package's own `exports` name `dist/`): field definitions are checked by identity.
 */
export const INLAY_ENTRIES: Readonly<Record<string, string>> = {
  inlaycms: entry('index'),
  'inlaycms/site': entry('site'),
  'inlaycms/jsx-runtime': entry('jsx/jsx-runtime'),
  'inlaycms/jsx-dev-runtime': entry('jsx/jsx-dev-runtime'),
  'inlaycms/testing': entry('testing'),
}

/** The files of the `inlaycms` shim package, by name. */
function shimFiles(): Map<string, string> {
  const files = new Map<string, string>()
  const exports: Record<string, string> = {}
  for (const [specifier, file] of Object.entries(INLAY_ENTRIES)) {
    const name = specifier === 'inlaycms' ? 'index' : specifier.slice('inlaycms/'.length)
    const url = JSON.stringify(pathToFileURL(file).href)
    files.set(`${name}.js`, `export * from ${url}\n${name === 'index' ? `export { default } from ${url}\n` : ''}`)
    exports[name === 'index' ? '.' : `./${name}`] = `./${name}.js`
  }
  files.set('package.json', JSON.stringify({ name: 'inlaycms', type: 'module', exports }, null, 2) + '\n')
  return files
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/** Writes `text` to `file` through a temporary file and a rename, unless the file already holds it. */
async function writeIfChanged(file: string, text: string): Promise<void> {
  if ((await readText(file)) === text) return
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(tmp, text)
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}

/**
 * Writes `<dir>/node_modules/inlaycms` as a package of one-line modules that re-export the running copy, so a
 * release's `site.js` resolves `inlaycms` to the code that loads it. (A package's `exports` can't name files
 * outside it, so these are modules, not a map.) `<dir>/package.json` marks `site.js` as a module: without it, tsx
 * would load it as CommonJS, and with it a second copy of `inlaycms`. Each file is replaced on its own through a
 * temporary file and a rename, and left alone when it is already right, so a worker loading the release at the
 * same time never finds a file missing or half written, and two writers at once end with the same files.
 */
async function writeInlayShim(dir: string): Promise<void> {
  const shim = join(dir, 'node_modules', 'inlaycms')
  await mkdir(shim, { recursive: true })
  // The modules first and the shim's package.json last, so it never names a module that isn't there yet.
  for (const [name, text] of shimFiles()) await writeIfChanged(join(shim, name), text)
  await writeIfChanged(join(dir, 'package.json'), '{ "type": "module" }\n')
}

function invalid(): InlayError {
  return new InlayError('release', 'error.releaseInvalid')
}

/** Whether a manifest path names something a release may hold. */
function releasePath(path: string): boolean {
  return path === 'site.js' || path.startsWith('content/') || path.startsWith('public/')
}

/** Throws `error.releaseTooOld` or `error.releaseTooNew` when a release packed with Inlay `packed` doesn't run on Inlay `version` (default: the running one). */
export function checkInlayVersion(packed: string, version: string = currentVersion()): void {
  const window = { ...runningWindow(), version }
  const fit = releaseFit(packed, window)
  if (fit === 'tooOld') throw new InlayError('release', 'error.releaseTooOld', { packed, version, oldest: window.oldest })
  if (fit === 'tooNew') throw new InlayError('release', 'error.releaseTooNew', { packed, version })
}

/** The manifest and signature are small; anything bigger is refused before the signature is checked. */
const SIGNED_MAX_BYTES = 1024 ** 2

/**
 * Opens the release file at `file` into the empty folder `opts.dir` without running any of it. The signature is
 * checked against `opts.trustedKeys` before anything but the manifest is read, the Inlay version range next, and
 * every file's checksum last. On a failure `dir` is left empty again.
 */
export async function openRelease(
  file: string,
  opts: { dir: string; trustedKeys: readonly string[]; inlayVersion?: string },
): Promise<{ manifest: ReleaseManifest; signedBy: string }> {
  const { dir } = opts
  await mustBeEmpty(dir)
  try {
    const { manifest, signedBy } = await checkRelease(file, dir, opts)
    return { manifest, signedBy: signedBy! }
  } catch (e) {
    await emptyDir(dir)
    throw e
  }
}

/**
 * Opens a release file from the operator's own backup into the empty folder `opts.dir`, trusting its manifest:
 * the signature isn't checked (the release was accepted when it was pushed, and the keys may have changed since),
 * but the release must suit this version of Inlay and the files must be the ones the manifest lists, with its
 * checksums. On a failure `dir` is left empty again.
 */
export async function extractRelease(
  file: string,
  opts: { dir: string; inlayVersion?: string },
): Promise<{ manifest: ReleaseManifest }> {
  await mustBeEmpty(opts.dir)
  try {
    const { manifest } = await checkRelease(file, opts.dir, { ...opts, trustedKeys: null })
    return { manifest }
  } catch (e) {
    await emptyDir(opts.dir)
    throw e
  }
}

async function mustBeEmpty(dir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new InlayError('release', 'error.releaseDirMissing', { dir })
    throw e
  }
  if (entries.length > 0) throw new InlayError('release', 'error.releaseDirNotEmpty', { dir })
}

/** Removes everything in `dir`, leaving the folder itself. */
async function emptyDir(dir: string): Promise<void> {
  for (const entry of await readdir(dir)) await rm(join(dir, entry), { recursive: true, force: true })
}

/** With `trustedKeys: null`, the signature isn't checked and `signedBy` is null. */
async function checkRelease(
  file: string,
  dir: string,
  opts: { trustedKeys: readonly string[] | null; inlayVersion?: string },
): Promise<{ manifest: ReleaseManifest; signedBy: string | null }> {
  try {
    await extractArchive(file, dir, (path) => SIGNED.has(path), { maxBytes: SIGNED_MAX_BYTES })
  } catch (e) {
    if (e instanceof InlayError && e.messageId === 'error.archiveNoSpace') throw invalid()
    throw e
  }
  const manifestFile = join(dir, 'manifest.json')
  const sigFile = join(dir, 'manifest.sig')
  let signedBy: string | null = null
  if (opts.trustedKeys !== null) {
    if (!existsSync(manifestFile) || !existsSync(sigFile)) throw new InlayError('release', 'error.releaseSignature')
    const signature = (await readFile(sigFile, 'utf8')).trim()
    const bytes = await readFile(manifestFile)
    const key = opts.trustedKeys.find((k) => verify(k, bytes, signature))
    if (key === undefined) throw new InlayError('release', 'error.releaseSignature')
    signedBy = fingerprint(key)
  } else if (!existsSync(manifestFile)) {
    throw invalid()
  }
  const bytes = await readFile(manifestFile)

  let manifest: ReleaseManifest
  try {
    manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')))
  } catch {
    throw invalid()
  }
  checkInlayVersion(manifest.inlay.version, opts.inlayVersion)
  const listed = Object.keys(manifest.files)
  if (!Object.hasOwn(manifest.files, 'site.js') || !listed.every(releasePath)) throw invalid()
  if (!manifest.content.every((c) => Object.hasOwn(manifest.files, c.path) && c.path.startsWith('content/'))) {
    throw invalid()
  }

  const unlisted: string[] = []
  const extracted = await extractArchive(file, dir, (path) => {
    if (SIGNED.has(path)) return false
    if (Object.hasOwn(manifest.files, path)) return true
    unlisted.push(path)
    return false
  })
  const got = new Set(extracted)
  if (unlisted.length > 0 || got.size !== extracted.length || !listed.every((p) => got.has(p))) throw invalid()
  for (const path of listed) {
    if (sha256Hex(await readFile(join(dir, path))) !== manifest.files[path]) {
      throw new InlayError('release', 'error.releaseChecksum', { path })
    }
  }
  return { manifest, signedBy }
}

/**
 * Loads the site code of a release `openRelease` opened into `dir`. `site.js` imports the running `inlaycms`;
 * its default export must be a config with a site that passes `buildRegistry` and asks for the secrets the
 * signed manifest lists. Trusts what `openRelease` checked: call it only on a folder that `openRelease` filled.
 */
export async function loadRelease(
  dir: string,
  opts: { load?: (siteJs: string) => Promise<unknown> } = {},
): Promise<LoadedRelease> {
  let manifest: ReleaseManifest
  try {
    manifest = manifestSchema.parse(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')))
  } catch {
    throw invalid()
  }

  await writeInlayShim(dir)

  const load = opts.load ?? ((f: string) => import(pathToFileURL(f).href))
  let mod: ({ default?: Partial<InlayConfig> } & Record<string, unknown>) | null
  try {
    mod = (await load(join(dir, 'site.js'))) as ({ default?: Partial<InlayConfig> } & Record<string, unknown>) | null
  } catch (e) {
    throw new InlayError('release', 'error.releaseLoad', { problem: e instanceof Error ? e.message : String(e) })
  }
  const config = mod?.default
  if (!config || typeof config !== 'object' || !config.site || typeof config.site !== 'object') {
    throw new InlayError('release', 'error.releaseNoSite')
  }
  const dirUrl = mod?.[SITE_DIR_EXPORT]
  const site = typeof dirUrl === 'string' ? { ...config.site, siteDir: dirUrl } : config.site
  buildRegistry(site)
  if (!isDeepStrictEqual([...site.secrets].sort(), [...manifest.secrets].sort())) {
    throw new InlayError('release', 'error.releaseSecretsMismatch', {
      manifest: manifest.secrets.join(', ') || '-',
      site: site.secrets.join(', ') || '-',
    })
  }

  return {
    manifest,
    site,
    dir,
    shippedFiles: new Map(manifest.content.map((c) => [c.source, join(dir, c.path)])),
    codeFiles: new Map(manifest.content.filter((c) => c.code === true).map((c) => [c.source, join(dir, c.path)])),
    publicDir: existsSync(join(dir, 'public')) ? join(dir, 'public') : null,
  }
}

/** `openRelease` and then `loadRelease`: checks the release file and loads its site. */
export async function readRelease(
  file: string,
  opts: {
    dir: string
    trustedKeys: readonly string[]
    inlayVersion?: string
    load?: (siteJs: string) => Promise<unknown>
  },
): Promise<LoadedRelease & { signedBy: string }> {
  const { signedBy } = await openRelease(file, opts)
  return { ...(await loadRelease(opts.dir, opts)), signedBy }
}
