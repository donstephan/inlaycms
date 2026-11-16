import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { InlayError } from '../core/errors.js'
import { parsePublicKeys } from '../core/release/keys.js'
import type { UploadLimits } from '../core/types.js'

export interface HostConfig {
  dataDir: string
  paths: { db: string; media: string; backups: string; releases: string }
  baseUrl: string
  secret: string
  trustedKeys: string[]
  port: number
  host: string
  rateLimit: boolean
  uploads?: UploadLimits
  backupKeep: number
  publicMaxAge: number
  cdn: { maxAge: number; staleIfError: number }
  /** The reverse proxies whose X-Forwarded-For is believed, for Fastify's `trustProxy`; false trusts none. */
  trustProxy: false | string[]
  secrets: (names: readonly string[]) => Record<string, string>
}

function checkBaseUrl(value: string): string {
  const fail = () => new InlayError('config', 'config.host.baseUrl', { value })
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw fail()
  }
  const bare = url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '' && url.password === ''
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !bare || !/^https?:\/\/[^/?#]+\/?$/i.test(value)) {
    throw fail()
  }
  return url.origin
}

function readNumber(env: NodeJS.ProcessEnv, name: string, fallback: number | undefined): number | undefined {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  if (!/^\d+$/.test(raw.trim())) throw new InlayError('config', 'config.host.number', { name, value: raw })
  return Number(raw.trim())
}

/** Address ranges `trustProxy` knows by name (proxy-addr's). */
const PROXY_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal'])

/** Whether `entry` is an IP address, an address range such as 10.0.0.0/8, or a named range. */
function isProxyAddress(entry: string): boolean {
  if (PROXY_RANGES.has(entry)) return true
  const [address = '', bits, ...rest] = entry.split('/')
  const version = isIP(address)
  if (version === 0 || rest.length > 0) return false
  return bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= (version === 4 ? 32 : 128))
}

/**
 * INLAY_TRUST_PROXY: off (the default), or the reverse proxies' addresses separated by commas. There's no way to
 * trust every address: then any visitor could fake theirs in X-Forwarded-For and get around the login limits.
 */
function readTrustProxy(env: NodeJS.ProcessEnv): false | string[] {
  const raw = env.INLAY_TRUST_PROXY
  if (raw === undefined || raw.trim() === '' || raw.trim().toLowerCase() === 'off') return false
  const entries = raw.split(',').map((entry) => entry.trim())
  if (!entries.every(isProxyAddress)) throw new InlayError('config', 'config.host.trustProxy', { value: raw })
  return entries
}

function readFlag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = raw.trim().toLowerCase()
  if (value === 'on') return true
  if (value === 'off') return false
  throw new InlayError('config', 'config.host.flag', { name, value: raw })
}

/** Where a host keeps its files, all in its data folder. */
export function hostPaths(dataDir: string): HostConfig['paths'] {
  return {
    db: join(dataDir, 'inlay.db'),
    media: join(dataDir, 'media'),
    backups: join(dataDir, 'backups'),
    releases: join(dataDir, 'releases'),
  }
}

/** INLAY_DATA_DIR, which must be set. */
export function readDataDir(env: NodeJS.ProcessEnv): string {
  const dataDir = env.INLAY_DATA_DIR
  if (!dataDir) throw new InlayError('config', 'config.host.dataDir', { value: dataDir ?? '' })
  return dataDir
}

/** The public keys in INLAY_TRUSTED_KEYS and the file INLAY_TRUSTED_KEYS_FILE names; none when neither is set. */
export function readTrustedKeys(env: NodeJS.ProcessEnv): string[] {
  const keys = new Set<string>()
  if (env.INLAY_TRUSTED_KEYS) for (const key of parsePublicKeys(env.INLAY_TRUSTED_KEYS)) keys.add(key)
  const keysFile = env.INLAY_TRUSTED_KEYS_FILE
  if (keysFile) {
    let text: string
    try {
      text = readFileSync(keysFile, 'utf8')
    } catch {
      throw new InlayError('config', 'config.host.trustedKeysFile', { value: keysFile })
    }
    for (const key of parsePublicKeys(text)) keys.add(key)
  }
  return [...keys]
}

export function readHostConfig(env: NodeJS.ProcessEnv, opts: { needKeys?: boolean } = {}): HostConfig {
  const dataDir = readDataDir(env)
  const baseUrlRaw = env.INLAY_BASE_URL
  if (!baseUrlRaw) throw new InlayError('config', 'config.host.baseUrl', { value: baseUrlRaw ?? '' })
  const baseUrl = checkBaseUrl(baseUrlRaw)
  const secret = env.INLAY_SECRET
  if (secret === undefined || secret.length < 32) throw new InlayError('config', 'config.host.secret', { value: '' })

  const keys = readTrustedKeys(env)
  if (opts.needKeys && keys.length === 0) throw new InlayError('config', 'config.host.trustedKeys', { value: '' })

  const portRaw = env.INLAY_PORT
  const port = readNumber(env, 'INLAY_PORT', 3000) as number
  if (port < 1 || port > 65535) throw new InlayError('config', 'config.host.port', { value: portRaw ?? '' })
  const maxBytes = readNumber(env, 'INLAY_UPLOAD_MAX_BYTES', undefined)

  return {
    dataDir,
    paths: hostPaths(dataDir),
    baseUrl,
    secret,
    trustedKeys: keys,
    port,
    host: env.INLAY_HOST || '0.0.0.0',
    rateLimit: readFlag(env, 'INLAY_RATE_LIMIT', true),
    ...(maxBytes !== undefined && { uploads: { maxBytes } }),
    backupKeep: readNumber(env, 'INLAY_BACKUP_KEEP', 14) as number,
    publicMaxAge: readNumber(env, 'INLAY_PUBLIC_MAX_AGE', 3600) as number,
    cdn: {
      maxAge: readNumber(env, 'INLAY_CDN_MAX_AGE', 15) as number,
      staleIfError: readNumber(env, 'INLAY_CDN_STALE_IF_ERROR', 86400) as number,
    },
    trustProxy: readTrustProxy(env),
    secrets: (names) => {
      const out: Record<string, string> = {}
      for (const name of names) {
        const value = env[name]
        if (value !== undefined) out[name] = value
      }
      return out
    },
  }
}

export async function ensureDataDir(config: HostConfig): Promise<void> {
  await mkdir(config.dataDir, { recursive: true })
  for (const dir of [config.paths.media, config.paths.backups, config.paths.releases]) {
    await mkdir(dir, { recursive: true })
  }
}
