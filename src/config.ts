import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { InlayError } from './core/errors.js'
import type { SiteDefinition } from './core/registry/define.js'
import { siteDirUrl } from './core/release/site-dir.js'

export interface InlayConfig {
  site: SiteDefinition
  /** The database file. Only the commands that work on a database need it; `--db` can give it instead. */
  db?: string
  backups?: string
  media?: string
}

export function defineConfig(c: InlayConfig): InlayConfig {
  return c
}

/** A loaded config, with the absolute path of its file and that file's directory. */
export interface LoadedConfig {
  config: InlayConfig
  file: string
  dir: string
}

/**
 * Imports the config module at `file` through a bundle of it and everything it imports, so TypeScript and JSX load
 * without tsx, and the site's `inlaycms` is the running copy.
 */
async function importConfig(file: string): Promise<{ default?: InlayConfig }> {
  // Imported here, not at the top: `inlaycms/site` re-exports `defineConfig` and shouldn't pull in esbuild.
  const { bundleConfig } = await import('./core/release/bundle.js')
  const dir = await mkdtemp(join(tmpdir(), 'inlay-config-'))
  try {
    const out = join(dir, 'config.js')
    await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
    await bundleConfig(file, out)
    return (await import(pathToFileURL(out).href)) as { default?: InlayConfig }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Loads a config file. Relative paths in it resolve against the file's
 * directory; `backups` defaults to `<dir of db>/backups` and `media` to
 * `<dir of db>/media` when there is a database.
 */
export async function loadConfig(file: string): Promise<LoadedConfig> {
  const abs = resolve(file)
  if (!existsSync(abs)) throw new InlayError('not_found', 'error.configMissing', { path: abs })
  const mod = await importConfig(abs)
  const config = mod.default
  if (!config || typeof config !== 'object' || !config.site || (config.db !== undefined && typeof config.db !== 'string')) {
    throw new InlayError('not_found', 'error.configMissing', { path: abs })
  }
  const dir = dirname(abs)
  const fromBase = (p: string) => (isAbsolute(p) ? p : join(dir, p))
  const db = config.db !== undefined ? fromBase(config.db) : undefined
  const near = (name: string) => (db !== undefined ? join(dirname(db), name) : undefined)
  const backups = config.backups !== undefined ? fromBase(config.backups) : near('backups')
  const media = config.media !== undefined ? fromBase(config.media) : near('media')
  return {
    config: {
      site: { ...config.site, siteDir: siteDirUrl(realpathSync(dir)) },
      ...(db !== undefined && { db }),
      ...(backups !== undefined && { backups }),
      ...(media !== undefined && { media }),
    },
    file: abs,
    dir,
  }
}
