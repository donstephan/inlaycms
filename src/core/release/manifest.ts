import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { z } from 'zod'
import { shippedFiles } from '../content/shipped-input.js'
import { typeSchemas } from '../export/schema.js'
import type { Registry } from '../registry/registry.js'
import { inlayVersion } from '../version.js'

export const MANIFEST_FORMAT = 1

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
  /** Each shipped image or file as the site names it, to where the release keeps it (`content/<sha256><ext>`). */
  content: Array<{ source: string; path: string }>
  /** The JSON Schema of each type's stored data, by type name, as the export manifest has it. */
  schema: Record<string, unknown>
  /**
   * Each shipped document with its edition and, per locale, the sha256 (hex) of the canonical JSON of its content
   * as written, with each file named by where the release keeps it.
   */
  shipped: Array<{ type: string; key: string; edition: number; locales: Record<string, string> }>
  /** Names of the site's migration functions, in order. */
  migrations: string[]
  routes: Array<{ method: string; path: string }>
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
  content: z.array(z.strictObject({ source: z.string(), path: z.string() })),
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
  routes: z.array(z.strictObject({ method: z.string(), path: z.string() })),
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
  if (Array.isArray(value)) return value.map((v) => withReleaseFiles(v, paths))
  if (value === null || typeof value !== 'object' || value instanceof URL || value instanceof Date) return value
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) {
    const source = key === 'file' ? (v instanceof URL ? v.href : typeof v === 'string' ? v : null) : null
    const path = source === null ? undefined : paths.get(source)
    out[key] = path ?? withReleaseFiles(v, paths)
  }
  return out
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
    for (const { source, path } of shippedFiles(registry)) {
      try {
        paths.set(source, contentPath(path, readFileSync(path)))
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
            sha256Hex(Buffer.from(canonicalJson(withReleaseFiles(input, paths)))),
          ]),
        ),
      })),
    ),
    migrations: site.migrations.map((m) => m.name),
    routes: site.routes.map(({ method, path }) => ({ method, path })),
    locales: [...registry.locales],
    types: Object.fromEntries(
      [...registry.types].map(([name, def]) => [name, { kind: def.kind, slots: Object.keys(def.template.slots) }]),
    ),
  }
}
