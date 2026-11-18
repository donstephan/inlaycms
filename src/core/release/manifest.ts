import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { z } from 'zod'
import { imageTarget } from '../content/shipped-images.js'
import { mapRichText, shippedFiles } from '../content/shipped-input.js'
import { typeSchemas } from '../export/schema.js'
import { CONSENT_CATEGORIES } from '../registry/integration.js'
import type { Registry } from '../registry/registry.js'
import { markdownImages } from '../richtext/markdown.js'
import { inlayVersion } from '../version.js'
import { replaceImageTargets } from './markdown-file.js'

export const MANIFEST_FORMAT = 1

export type ManifestRedirect = { from: string; to: string; status: 301 | 302 }
export type ManifestCsp = Record<string, string[]>
export type ManifestIntegration = {
  name: string
  label: string
  consent?: (typeof CONSENT_CATEGORIES)[number]
  csp?: ManifestCsp
}

/** What `manifest.json` in a release says; `manifest.sig` signs its bytes. */
export interface ReleaseManifest {
  format: 1
  name: string
  createdAt: string
  inlay: { version: string; range: string }
  /** Names of the secrets the site needs; never their values. */
  secrets: string[]
  /** Every file in the release except the manifest and its signature, to its sha256 (hex). */
  files: Record<string, string>
  /**
   * Each shipped image or file as the site names it, to where the release keeps it (`content/<sha256><ext>`).
   * `code` marks an image site code names (a `.md` file it imports, or an image it imports): only those are served at `/media/files/`.
   */
  content: Array<{ source: string; path: string; code?: true }>
  /** The JSON Schema of each type's stored data, by type name, as the export manifest has it. */
  schema: Record<string, unknown>
  /**
   * Each shipped document with its edition and, per locale, the sha256 (hex) of the canonical JSON of its content
   * as written, with each file named by where the release keeps it.
   */
  shipped: Array<{ type: string; key: string; edition: number; locales: Record<string, string> }>
  /** Names of the site's migration functions, in order. */
  migrations: string[]
  routes: Array<{ method: string; path: string; sitemap?: true }>
  /** The site's code redirects in stored form; absent in manifests made before 0.3, which means none. */
  redirects?: ManifestRedirect[]
  /** The site's integrations; absent when it has none, and in manifests made before integrations. */
  integrations?: ManifestIntegration[]
  /** The sources the site's own `csp` adds, by directive; absent when empty. */
  csp?: ManifestCsp
  locales: string[]
  /** Each type's kind and slot names, by type name. */
  types: Record<string, { kind: 'singleton' | 'collection' | 'global'; slots: string[] }>
}

const SHA256 = /^[0-9a-f]{64}$/

export const manifestSchema = z.strictObject({
  format: z.literal(MANIFEST_FORMAT),
  name: z.string().min(1),
  createdAt: z.string(),
  inlay: z.strictObject({ version: z.string(), range: z.string() }),
  secrets: z.array(z.string()),
  files: z.record(z.string(), z.string().regex(SHA256)),
  content: z.array(z.strictObject({ source: z.string(), path: z.string(), code: z.literal(true).optional() })),
  schema: z.record(z.string(), z.record(z.string(), z.unknown())),
  shipped: z.array(
    z.strictObject({
      type: z.string(),
      key: z.string(),
      edition: z.number().int(),
      locales: z.record(z.string(), z.string().regex(SHA256)),
    }),
  ),
  migrations: z.array(z.string()),
  routes: z.array(z.strictObject({ method: z.string(), path: z.string(), sitemap: z.literal(true).optional() })),
  redirects: z
    .array(z.strictObject({ from: z.string(), to: z.string(), status: z.union([z.literal(301), z.literal(302)]) }))
    .optional(),
  integrations: z
    .array(
      z.strictObject({
        name: z.string(),
        label: z.string(),
        consent: z.enum(CONSENT_CATEGORIES).optional(),
        csp: z.record(z.string(), z.array(z.string())).optional(),
      }),
    )
    .optional(),
  csp: z.record(z.string(), z.array(z.string())).optional(),
  locales: z.array(z.string()),
  types: z.record(
    z.string(),
    z.strictObject({ kind: z.enum(['singleton', 'collection', 'global']), slots: z.array(z.string()) }),
  ),
}) satisfies z.ZodType<ReleaseManifest>

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/

function parts(version: string): [number, number, number] | null {
  const m = VERSION.exec(version)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/**
 * Whether `version` falls in `range`, which is `^MAJOR.MINOR.PATCH`: for major 0, the same minor and a patch at
 * least as high; otherwise the same major and a minor and patch at least as high.
 */
export function satisfies(version: string, range: string): boolean {
  if (!range.startsWith('^')) return false
  const want = parts(range.slice(1))
  const have = parts(version)
  if (!want || !have) return false
  const [major, minor, patch] = want
  const [hMajor, hMinor, hPatch] = have
  if (hMajor !== major) return false
  if (major === 0) return hMinor === minor && hPatch >= patch
  return hMinor > minor || (hMinor === minor && hPatch >= patch)
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Where a release keeps a shipped file: named by its sha256, keeping its extension. */
export function contentPath(file: string, bytes: Uint8Array): string {
  return `content/${sha256Hex(bytes)}${extname(file).toLowerCase()}`
}

/** `value` as JSON with every object's keys sorted, so equal values give equal text. */
export function canonicalJson(value: unknown): string {
  const sorted = (v: unknown): unknown => {
    if (v !== null && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
      return sorted((v as { toJSON: () => unknown }).toJSON())
    }
    if (Array.isArray(v)) return v.map(sorted)
    if (v === null || typeof v !== 'object') return v
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(v).sort()) out[key] = sorted((v as Record<string, unknown>)[key])
    return out
  }
  return JSON.stringify(sorted(value)) ?? 'null'
}

/** `value` with each `{ file }` whose source `paths` knows naming the release's copy instead. */
function withReleaseFiles(value: unknown, paths: ReadonlyMap<string, string>): unknown {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (value === null || typeof value !== 'object' || value instanceof URL || value instanceof Date) return value
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value)) {
      const source = key === 'file' ? (v instanceof URL ? v.href : typeof v === 'string' ? v : null) : null
      const path = source === null ? undefined : paths.get(source)
      out[key] = path ?? walk(v)
    }
    return out
  }
  return walk(value)
}

/**
 * Rich-text Markdown with each image naming a file `paths` knows (by a relative path or a `file:` URL) naming the
 * release's copy instead, so its hash follows the file's bytes and not where the site sits. An image whose place in
 * the text can't be found is listed after the text by where the release keeps it.
 */
function withReleaseImages(markdown: string, siteDir: string | null, paths: ReadonlyMap<string, string>): unknown {
  const releaseCopy = (src: string): string | null => {
    const target = imageTarget(src, siteDir)
    return target.kind === 'file' ? (paths.get(target.url) ?? null) : null
  }
  const { text, complete } = replaceImageTargets(markdown, releaseCopy)
  if (complete) return text
  return { markdown: text, images: markdownImages(markdown).map(({ src }) => releaseCopy(src) ?? src) }
}

/** `csp` as a manifest keeps it, or `undefined` when it adds no source. */
function cspOf(csp: Partial<Record<string, readonly string[]>>): ManifestCsp | undefined {
  const out: ManifestCsp = {}
  for (const [directive, sources] of Object.entries(csp)) if (sources && sources.length > 0) out[directive] = [...sources]
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * The manifest of the site `registry` describes, without its files: what `packRelease` writes, given the shipped
 * files it packed as `content`. Without `content`, shipped files are read here to name them the way a release
 * would, so a site running from source has a manifest to compare a release with; a file that can't be read is
 * named by its source.
 */
export function manifestOfRegistry(
  registry: Registry,
  opts: { name: string; now: Date; content?: ReleaseManifest['content'] },
): ReleaseManifest {
  const paths = new Map<string, string>()
  if (opts.content) {
    for (const { source, path } of opts.content) paths.set(source, path)
  } else {
    for (const { source, path, read } of shippedFiles(registry)) {
      try {
        paths.set(source, contentPath(path, readFileSync(read)))
      } catch {
        // Left as its source; applying the content reports it.
      }
    }
  }
  const { site } = registry
  return {
    format: MANIFEST_FORMAT,
    name: opts.name,
    createdAt: opts.now.toISOString(),
    inlay: { version: inlayVersion(), range: '^' + inlayVersion() },
    secrets: [...site.secrets],
    files: {},
    content: opts.content ?? [],
    schema: typeSchemas(registry),
    shipped: [...registry.content].flatMap(([type, documents]) =>
      documents.map((doc) => ({
        type,
        key: doc.key,
        edition: doc.edition,
        locales: Object.fromEntries(
          Object.entries(doc.content).map(([locale, input]) => [
            locale,
            sha256Hex(
              Buffer.from(
                canonicalJson(
                  withReleaseFiles(
                    mapRichText(registry, type, input, (markdown) => withReleaseImages(markdown, registry.siteDir, paths)),
                    paths,
                  ),
                ),
              ),
            ),
          ]),
        ),
      })),
    ),
    migrations: site.migrations.map((m) => m.name),
    routes: site.routes.map((r) => ({ method: r.method, path: r.path, ...(r.sitemap === true && { sitemap: true as const }) })),
    redirects: registry.redirects.map(({ from, to, status }) => ({ from, to, status })),
    ...(site.integrations.length > 0 && {
      integrations: site.integrations.map(({ name, label, consent, csp }) => {
        const sources = cspOf(csp)
        return { name, label, ...(consent !== undefined && { consent }), ...(sources && { csp: sources }) }
      }),
    }),
    ...(cspOf(site.csp) && { csp: cspOf(site.csp) }),
    locales: [...registry.locales],
    types: Object.fromEntries(
      [...registry.types].map(([name, def]) => [name, { kind: def.kind, slots: Object.keys(def.template.slots) }]),
    ),
  }
}
