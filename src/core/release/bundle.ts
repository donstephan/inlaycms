import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build, transform, type BuildOptions, type Loader, type OnLoadResult, type Plugin } from 'esbuild'
import { InlayError } from '../errors.js'
import { INLAY_ENTRIES } from './read.js'

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
  const resolving = Symbol('resolving')
  const plugin: Plugin = {
    name: 'inlay-config',
    setup(b) {
      b.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === 'entry-point' || args.pluginData === resolving) return undefined
        const running = INLAY_ENTRIES[args.path]
        if (running !== undefined) return { path: pathToFileURL(running).href, external: true }
        const url = fileUrlPath(args.path)
        const found = await b.resolve(url?.path ?? args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: resolving,
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
 * imports left in the bundle.
 */
export async function bundleSite(configFile: string, outFile: string): Promise<{ imports: string[] }> {
  const base = dirname(resolve(configFile))
  const shown = (file: string) => {
    const rel = relative(base, file)
    return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? file : rel
  }
  const refused: Array<{ file: string; specifier: string }> = []
  const forbidden: Array<{ file: string; what: string }> = []
  const tsconfigFor = tsconfigs()
  const guard: Plugin = {
    name: 'inlay-release',
    setup(b) {
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
  return { imports: [...imports] }
}
