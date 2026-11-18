import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  build,
  transform,
  type BuildOptions,
  type Loader,
  type OnLoadResult,
  type OnResolveArgs,
  type OnResolveResult,
  type Plugin,
  type PluginBuild,
} from 'esbuild'
import sharp, { type Metadata } from 'sharp'
import { imageTarget, realInsideSync } from '../content/shipped-images.js'
import { InlayError } from '../errors.js'
import { detectType } from '../media/detect.js'
import { t, type MessageId } from '../messages/index.js'
import type { CodeImage } from '../registry/code-image.js'
import { markdownImages } from '../richtext/markdown.js'
import { isMediaTarget, MARKDOWN_IMAGE_TYPES, parseMarkdownText } from '../richtext/markdown-text.js'
import { rewriteImageTargets } from './markdown-file.js'
import { INLAY_ENTRIES } from './read.js'
import { SITE_DIR_EXPORT, siteDirUrl } from './site-dir.js'

/** What a release's `site.js` may import; everything else is bundled into it or refused. */
export const RELEASE_IMPORTS: readonly string[] = ['inlaycms/site', 'inlaycms/jsx-runtime', 'inlaycms/jsx-dev-runtime']

/** Free names site code may not use: they reach the server's process or run code from text. */
const FORBIDDEN = [
  'process',
  'require',
  'eval',
  'Function',
  'globalThis.process',
  'global.process',
  'globalThis.eval',
  'global.eval',
  'globalThis.Function',
  'global.Function',
]

/** Values pinned at bundle time instead of read from the server's process. */
const DEFINES: Record<string, string> = { 'process.env.NODE_ENV': JSON.stringify('production') }

const BUILTINS: ReadonlySet<string> = new Set(builtinModules)

const LOADERS: Record<string, Loader> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.jsx': 'jsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
}

function isInlay(specifier: string): boolean {
  return specifier === 'inlaycms' || specifier.startsWith('inlaycms/')
}

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || BUILTINS.has(specifier) || BUILTINS.has(specifier.split('/')[0] ?? '')
}

/** Whether `file` is part of an installed package rather than the site's own code. */
function isPackage(file: string): boolean {
  return file.split(/[\\/]/).includes('node_modules')
}

/** The text of the `tsconfig.json` nearest above each folder, looked up once per folder. */
function tsconfigs(): (dir: string) => Promise<string | undefined> {
  const found = new Map<string, Promise<string | undefined>>()
  const lookup = (dir: string): Promise<string | undefined> => {
    let text = found.get(dir)
    if (text === undefined) {
      const file = join(dir, 'tsconfig.json')
      const parent = dirname(dir)
      text = existsSync(file) ? readFile(file, 'utf8') : parent === dir ? Promise.resolve(undefined) : lookup(parent)
      found.set(dir, text)
    }
    return text
  }
  return lookup
}

/**
 * What the site's own module `text` uses that a release refuses: a free `process`, `require`, `eval` or
 * `Function` (or one of those read off `globalThis` or `global`), or an `import()` of a computed name; null when
 * nothing. esbuild only replaces free names through `define`, so a local variable, a property or a string of the
 * same name passes; and with dynamic imports turned into `__toESM(require(...))` calls, a computed one is a call
 * whose argument is neither a plain string nor a template starting `./` or `../`, which esbuild bundles as a glob.
 */
async function forbiddenUse(text: string, loader: Loader, file: string, tsconfigRaw: string | undefined): Promise<string | null> {
  const marker = `__inlay_forbidden_${randomBytes(6).toString('hex')}_`
  const define = Object.fromEntries(FORBIDDEN.map((name, i) => [name, `${marker}${i}`]))
  const { code } = await transform(text, {
    loader,
    sourcefile: file,
    format: 'esm',
    jsx: 'preserve',
    tsconfigRaw,
    supported: { 'dynamic-import': false },
    define: { ...DEFINES, ...define, 'import.meta.url': '""' },
    logLevel: 'silent',
  })
  const found = new RegExp(`${marker}(\\d+)`).exec(code)
  if (found) return FORBIDDEN[Number(found[1])] ?? null
  return /__toESM\d*\(require\(\s*(?!"|`\.\.?\/)\S/.test(code) ? 'import()' : null
}

/** A `file:` URL import as the path esbuild reads, or undefined to leave it to esbuild. */
function fileUrlPath(specifier: string): { path: string } | undefined {
  if (!specifier.startsWith('file:')) return undefined
  try {
    return { path: fileURLToPath(specifier) }
  } catch {
    return undefined
  }
}

/** Module `text` at `file` with `import.meta.url` naming `file` itself; undefined when it doesn't use it. */
async function withOwnUrl(text: string, file: string, loader: Loader, tsconfigRaw: string | undefined): Promise<OnLoadResult | undefined> {
  if (!text.includes('import.meta.url')) return undefined
  const out = await transform(text, {
    loader,
    sourcefile: file,
    format: 'esm',
    jsx: 'preserve',
    tsconfigRaw,
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(file).href) },
    logLevel: 'silent',
  })
  return { contents: out.code, loader: loader === 'tsx' || loader === 'jsx' ? 'jsx' : 'js' }
}

/** `file` relative to the site's folder `base`, or as it is when it isn't inside it. */
function shownPath(base: string, file: string): string {
  const rel = relative(base, file)
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? file : rel
}

/** The extensions a `.md` image's file may have, for messages: ".png, .jpg, …". */
const IMAGE_EXTENSIONS = Object.keys(MARKDOWN_IMAGE_TYPES).join(', ')

/**
 * The first reason the image target `src` (on `line` of the `.md` file shown as `shown`, its relative targets already
 * rewritten to `file:` URLs) can't be used, or null when it is a media library image or a picture file inside the
 * site's folder (`siteDir`, a `file:` URL ending in `/`) whose extension is in `MARKDOWN_IMAGE_TYPES` and matches
 * what it holds. An SVG file is refused.
 */
function markdownImageProblem(src: string, line: number, shown: string, siteDir: string): string | null {
  const refuse = (id: MessageId, extra: Record<string, string> = {}) => t(id, { file: shown, line, src, ...extra })
  const target = imageTarget(src, siteDir)
  if (target.kind === 'library') return isMediaTarget(src) ? null : refuse('error.markdownImageOther')
  if (target.kind === 'remote') return refuse('error.markdownImageRemote')
  if (target.kind === 'rooted') return refuse('error.markdownImageRooted')
  if (!/^file:/i.test(src)) return refuse('error.markdownImageOther')
  let path: string
  try {
    path = fileURLToPath(src)
  } catch {
    return refuse('error.markdownImageOutside')
  }
  if (!existsSync(path)) return refuse('error.markdownImageMissing')
  const real = realInsideSync(path, siteDir)
  if (real === null) return refuse('error.markdownImageOutside')
  let bytes: Buffer
  try {
    bytes = readFileSync(real)
  } catch {
    return refuse('error.markdownImageMissing')
  }
  const ext = extname(path).toLowerCase()
  const mime = detectType(bytes, path)
  if (mime === 'image/svg+xml' || ext === '.svg') return refuse('error.markdownImageSvg')
  if (!mime.startsWith('image/')) return refuse('error.markdownImageNotImage')
  const expected = MARKDOWN_IMAGE_TYPES[ext]
  if (expected === undefined) return refuse('error.markdownImageExtension', { extensions: IMAGE_EXTENSIONS })
  if (mime !== expected) return refuse('error.markdownImageMismatch', { ext })
  return null
}

/**
 * A `.md` file at `file` as a module whose default export is its text, with its images' targets rewritten from
 * the file's own folder; a reference-style image is refused with `error.markdownImageReference`, and one whose
 * place in the file can't be found with `error.markdownImageUnplaced`. Then the first thing `parseMarkdownText`
 * refuses is, and then the first image `markdownImageProblem` refuses. `images` is given the `file:` targets of a
 * file that passes.
 */
async function loadMarkdown(file: string, base: string, images?: Set<string>): Promise<OnLoadResult> {
  const result = rewriteImageTargets(await readFile(file, 'utf8'), file)
  const line = result.references[0]
  if (line !== undefined) return { errors: [{ text: t('error.markdownImageReference', { file: shownPath(base, file), line }) }] }
  const unplaced = result.unplaced[0]
  if (unplaced !== undefined) {
    return { errors: [{ text: t('error.markdownImageUnplaced', { file: shownPath(base, file), line: unplaced }) }] }
  }
  const shown = shownPath(base, file)
  const problem = parseMarkdownText(result.text)
  if (!problem.ok) {
    const first = problem.problems[0]
    if (first) return { errors: [{ text: t('error.markdownProblem', { file: shown, problem: first.message }) }] }
  }
  const siteDir = pathToFileURL(base).href + '/'
  const targets: string[] = []
  for (const { src, line } of markdownImages(result.text)) {
    const refused = markdownImageProblem(src, line, shown, siteDir)
    if (refused !== null) return { errors: [{ text: refused }] }
    if (/^file:/i.test(src)) targets.push(src)
  }
  for (const target of targets) images?.add(target)
  return { contents: result.text, loader: 'text' }
}

/** The files an image import may name, and an SVG, which the loader refuses with a message of its own. */
const IMAGE_FILTER = new RegExp(`\\.(${[...Object.keys(MARKDOWN_IMAGE_TYPES), '.svg'].map((e) => e.slice(1)).join('|')})$`, 'i')

/** The `pluginData` of a plugin's own `b.resolve` call, so no plugin callback resolves its own lookup again. */
const RESOLVING = Symbol('resolving')

/** What an image import resolved through `imageResolver` carries to its loader: the file that imports it. */
interface ImageImport {
  importer: string
}

/**
 * An `onResolve` callback for image imports that resolves them as esbuild would, and remembers the importing file
 * so `loadImage` can name it. Anything it can't resolve is left to the other callbacks and esbuild's own error.
 */
function imageResolver(b: PluginBuild): (args: OnResolveArgs) => Promise<OnResolveResult | undefined> {
  return async (args) => {
    if (args.kind === 'entry-point' || args.pluginData === RESOLVING) return undefined
    const found = await b.resolve(fileUrlPath(args.path)?.path ?? args.path, {
      kind: args.kind,
      importer: args.importer,
      resolveDir: args.resolveDir,
      pluginData: RESOLVING,
    })
    if (found.errors.length > 0 || found.external || found.namespace !== 'file') return undefined
    const pluginData: ImageImport = { importer: args.importer }
    return { path: found.path, pluginData }
  }
}

/**
 * An image file at `file`, imported by `importer`, as a JSON module whose default export is its `CodeImage`, measured
 * here so render never reads it. Refuses an image whose real path isn't inside the site's folder `base` with
 * `error.imageImportOutside`, an SVG (by its name or its bytes) with `error.imageImportSvg`, bytes that aren't
 * the picture its extension names with `error.imageImportMismatch`, and a picture sharp can't measure with
 * `error.imageImportUnreadable`. `images` is given the `source` of an image that passes.
 */
async function loadImage(file: string, base: string, importer: string | undefined, images?: Set<string>): Promise<OnLoadResult> {
  const params = { file: shownPath(base, importer ?? file), image: relative(realpathSync(base), file) }
  const refuse = (id: MessageId): OnLoadResult => ({ errors: [{ text: t(id, params) }] })
  const real = realInsideSync(file, pathToFileURL(base).href + '/')
  if (real === null) return refuse('error.imageImportOutside')
  const ext = extname(file).toLowerCase()
  if (ext === '.svg') return refuse('error.imageImportSvg')
  const bytes = await readFile(real)
  const mime = detectType(bytes, file)
  if (mime === 'image/svg+xml') return refuse('error.imageImportSvg')
  const expected = MARKDOWN_IMAGE_TYPES[ext]
  if (expected === undefined || mime !== expected) return refuse('error.imageImportMismatch')
  let meta: Metadata
  try {
    meta = await sharp(bytes).metadata()
  } catch {
    return refuse('error.imageImportUnreadable')
  }
  if (!meta.width || !meta.height) return refuse('error.imageImportUnreadable')
  const turned = meta.orientation !== undefined && meta.orientation >= 5 && meta.orientation <= 8
  const image: CodeImage = {
    kind: 'codeImage',
    source: pathToFileURL(file).href,
    sha: createHash('sha256').update(bytes).digest('hex'),
    ext,
    mime,
    width: turned ? meta.height : meta.width,
    height: turned ? meta.width : meta.height,
  }
  images?.add(image.source)
  return { contents: JSON.stringify(image), loader: 'json' }
}

/** The `onLoad` callback for image imports, for the site's folder `base`; `images` collects their sources. */
function imageLoader(base: string, images?: Set<string>): Parameters<PluginBuild['onLoad']>[1] {
  return (args) => {
    if (args.namespace !== 'file') return undefined
    return loadImage(args.path, base, (args.pluginData as ImageImport | undefined)?.importer, images)
  }
}

/** The esbuild options `bundleSite` and `bundleConfig` share. */
function buildOptions(configFile: string, outFile: string, plugin: Plugin): BuildOptions {
  return {
    entryPoints: [configFile],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    outfile: outFile,
    jsx: 'automatic',
    jsxImportSource: 'inlaycms',
    define: { ...DEFINES, 'import.meta.url': JSON.stringify(pathToFileURL(resolve(configFile)).href) },
    logLevel: 'silent',
    footer: { js: `export const ${SITE_DIR_EXPORT} = ${JSON.stringify(siteDirUrl(realpathSync(dirname(resolve(configFile)))))};` },
    plugins: [plugin],
  }
}

/**
 * Bundles the config module at `configFile` and everything it imports into one ESM file at `outFile` for the CLI
 * to import, so loading a site's TypeScript and JSX needs nothing but Inlay. `inlaycms` imports point at the running
 * copy, as a release's do; nothing is refused, since `bundleSite` is what holds a release to its boundary. A build
 * failure is `cli.configFailed`.
 */
export async function bundleConfig(configFile: string, outFile: string): Promise<void> {
  const tsconfigFor = tsconfigs()
  // The running copy's own folder (`src/` or `dist/`): a file in it is imported, never bundled as a second copy.
  const inlayDir = dirname(INLAY_ENTRIES.inlaycms ?? '')
  const base = dirname(resolve(configFile))
  const plugin: Plugin = {
    name: 'inlay-config',
    setup(b) {
      b.onResolve({ filter: IMAGE_FILTER }, imageResolver(b))
      b.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === 'entry-point' || args.pluginData === RESOLVING) return undefined
        const running = INLAY_ENTRIES[args.path]
        if (running !== undefined) return { path: pathToFileURL(running).href, external: true }
        const url = fileUrlPath(args.path)
        const found = await b.resolve(url?.path ?? args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: RESOLVING,
        })
        if (found.errors.length > 0) return url
        const rel = relative(inlayDir, found.path)
        if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return { path: pathToFileURL(found.path).href, external: true }
        return { path: found.path, namespace: found.namespace, external: found.external, sideEffects: found.sideEffects }
      })
      b.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
        const loader = LOADERS[extname(args.path)]
        if (loader === undefined || args.namespace !== 'file') return undefined
        return withOwnUrl(await readFile(args.path, 'utf8'), args.path, loader, await tsconfigFor(dirname(args.path)))
      })
      b.onLoad({ filter: /\.md$/ }, (args) => (args.namespace === 'file' ? loadMarkdown(args.path, base) : undefined))
      b.onLoad({ filter: IMAGE_FILTER }, imageLoader(base))
    },
  }
  try {
    await build(buildOptions(configFile, outFile, plugin))
  } catch (e) {
    const errors = (e as { errors?: Array<{ text: string }> }).errors
    throw new InlayError('config', 'cli.configFailed', { path: resolve(configFile), error: errors?.[0]?.text ?? String(e) })
  }
}

/**
 * Bundles the config module at `configFile` and everything it imports into one ESM file at `outFile`, leaving
 * `inlaycms/site` and the JSX runtime to the host. `import.meta.url` in each module keeps naming its source file,
 * so `new URL('./x', import.meta.url)` in content means what it meant before bundling. Refuses Node built-ins and
 * any other import left outside the bundle (`inlaycms` itself included) with `error.packImport`, and site code
 * (not installed packages) that reaches for the server with `error.packForbidden`; other build failures are
 * `error.packBundle`. These checks catch mistakes: the release's signature is what makes it trusted. Returns the
 * imports left in the bundle, and the `file:` URLs of the images site code names: those its `.md` files name, and
 * those it imports.
 */
export async function bundleSite(configFile: string, outFile: string): Promise<{ imports: string[]; codeImages: string[] }> {
  const images = new Set<string>()
  const base = dirname(resolve(configFile))
  const shown = (file: string) => shownPath(base, file)
  const refused: Array<{ file: string; specifier: string }> = []
  const forbidden: Array<{ file: string; what: string }> = []
  const tsconfigFor = tsconfigs()
  const guard: Plugin = {
    name: 'inlay-release',
    setup(b) {
      b.onResolve({ filter: IMAGE_FILTER }, imageResolver(b))
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return undefined
        if (isBuiltin(args.path) || (isInlay(args.path) && !RELEASE_IMPORTS.includes(args.path))) {
          refused.push({ file: shown(args.importer), specifier: args.path })
          return { errors: [{ text: `refused import ${args.path}` }] }
        }
        return fileUrlPath(args.path)
      })
      b.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
        const loader = LOADERS[extname(args.path)]
        if (loader === undefined || args.namespace !== 'file') return undefined
        const text = await readFile(args.path, 'utf8')
        if (!isPackage(args.path)) {
          const what = await forbiddenUse(text, loader, args.path, await tsconfigFor(dirname(args.path)))
          if (what !== null) {
            forbidden.push({ file: shown(args.path), what })
            return { errors: [{ text: `refused ${what}` }] }
          }
        }
        return withOwnUrl(text, args.path, loader, await tsconfigFor(dirname(args.path)))
      })
      b.onLoad({ filter: /\.md$/ }, (args) => (args.namespace === 'file' ? loadMarkdown(args.path, base, images) : undefined))
      b.onLoad({ filter: IMAGE_FILTER }, imageLoader(base, images))
    },
  }
  let result
  try {
    result = await build({ ...buildOptions(configFile, outFile, guard), external: [...RELEASE_IMPORTS], metafile: true })
  } catch (e) {
    const first = refused[0]
    if (first) throw new InlayError('release', 'error.packImport', first)
    const use = forbidden[0]
    if (use) throw new InlayError('release', 'error.packForbidden', use)
    const errors = (e as { errors?: Array<{ text: string }> }).errors
    throw new InlayError('release', 'error.packBundle', { problem: errors?.[0]?.text ?? String(e) })
  }
  const imports = new Set<string>()
  for (const output of Object.values(result.metafile?.outputs ?? {})) {
    for (const imported of output.imports) if (imported.external) imports.add(imported.path)
  }
  for (const specifier of imports) {
    if (!RELEASE_IMPORTS.includes(specifier)) {
      throw new InlayError('release', 'error.packImport', { file: shown(resolve(configFile)), specifier })
    }
  }
  return { imports: [...imports], codeImages: [...images].sort() }
}
