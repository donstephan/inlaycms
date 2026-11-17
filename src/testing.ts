import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { checkBundle } from './core/check.js'
import { InlayError } from './core/errors.js'
import { formatReport } from './core/report.js'
import { createSiteApp, sourceFromConfig } from './host/app.js'
import { ensureDataDir, readHostConfig, type HostConfig } from './host/config.js'

export interface TestSiteOptions {
  /** The site's inlay.config.ts: a path relative to process.cwd(), or a file: URL (a URL, or a string starting with file:). */
  config: string | URL
  /** Used for canonical, Open Graph and sitemap URLs. Default http://localhost. */
  baseUrl?: string
  /** Values for the site's declared secrets. */
  secrets?: Record<string, string>
  /** What routes get as ctx.fetch. Default: the global fetch. */
  fetch?: typeof fetch
  /** The clock. Default: real time. */
  now?: () => Date
}

export interface TestSite {
  fetch(path: string, init?: RequestInit): Promise<Response>
  paths(): Promise<string[]>
  close(): Promise<void>
}

function configFile(config: string | URL): string {
  if (typeof config === 'string' && !config.startsWith('file:')) return resolve(process.cwd(), config)
  const url = typeof config === 'string' ? new URL(config) : config
  if (url.protocol !== 'file:') throw new InlayError('not_found', 'error.configMissing', { path: url.href })
  return fileURLToPath(url)
}

/** Refuses a site that `inlaycms pack` refuses, so its tests can't pass where a release would fail. */
async function checkPackBoundary(file: string): Promise<void> {
  const problems = await checkBundle(file)
  if (problems.length === 0) return
  const list = formatReport({
    ok: false,
    systemMigrations: [],
    shipped: { created: [], replaced: [], skipped: [], deletedRefs: [], warnings: [] },
    problems,
    warnings: [],
  }).join('\n')
  throw new InlayError('check_failed', 'error.checkFailed', { count: problems.length, list }, { problems })
}

/** Statuses a Response can't carry a body with. */
const NULL_BODY_STATUSES = new Set([204, 205, 304])

/**
 * Boots the site of an `inlay.config.ts` the way `inlaycms dev` does, in a temporary data folder, and answers its
 * requests in process (Fastify `inject`): no port, no child process. `close()` stops it and removes the folder.
 */
export async function createTestSite(opts: TestSiteOptions): Promise<TestSite> {
  const file = configFile(opts.config)
  const loaded = await loadConfig(file)
  await checkPackBoundary(file)
  const dataDir = await mkdtemp(join(tmpdir(), 'inlay-test-site-'))
  let host: HostConfig
  let booted: Awaited<ReturnType<typeof createSiteApp>>
  try {
    const read = readHostConfig({
      INLAY_DATA_DIR: dataDir,
      INLAY_BASE_URL: opts.baseUrl ?? 'http://localhost',
      INLAY_SECRET: randomBytes(32).toString('hex'),
      INLAY_RATE_LIMIT: 'off',
    })
    const given = opts.secrets ?? {}
    host = {
      ...read,
      secrets: (names) => Object.fromEntries(Object.entries(given).filter(([name]) => names.includes(name))),
    }
    await ensureDataDir(host)
    booted = await createSiteApp(host, sourceFromConfig(loaded), {
      content: 'apply',
      backupSchedule: false,
      ...(opts.now && { now: opts.now }),
      ...(opts.fetch && { fetch: opts.fetch }),
    })
  } catch (e) {
    await rm(dataDir, { recursive: true, force: true })
    throw e
  }
  const { app, core } = booted
  const hostHeader = new URL(host.baseUrl).host
  let closed: Promise<void> | null = null
  const inFlight = new Set<Promise<unknown>>()
  const track = <T>(p: Promise<T>): Promise<T> => {
    inFlight.add(p)
    const done = () => void inFlight.delete(p)
    p.then(done, done)
    return p
  }
  const ensureOpen = () => {
    if (closed) throw new InlayError('invalid_operation', 'error.testSiteClosed')
  }

  const send = async (path: string, init: RequestInit = {}): Promise<Response> => {
    ensureOpen()
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
      throw new InlayError('invalid_operation', 'error.testSitePath', { path: String(path) })
    }
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = Object.fromEntries(new Headers(init.headers))
    if (headers.host === undefined) headers.host = hostHeader
    const body = init.body
    let payload: string | undefined
    if (typeof body === 'string') {
      payload = body
      if (headers['content-type'] === undefined) headers['content-type'] = 'text/plain;charset=UTF-8'
    } else if (body instanceof URLSearchParams) {
      payload = body.toString()
      if (headers['content-type'] === undefined) {
        headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
      }
    } else if (body !== undefined && body !== null) {
      throw new InlayError('invalid_operation', 'error.testSiteBody')
    }
    const res = await app.inject({
      method: method as 'GET',
      url: path,
      headers,
      ...(payload !== undefined && { payload }),
    })
    const out = new Headers()
    for (const [name, value] of Object.entries(res.headers)) {
      if (value === undefined) continue
      if (Array.isArray(value)) for (const v of value) out.append(name, v)
      else out.append(name, String(value))
    }
    const bodiless = method === 'HEAD' || NULL_BODY_STATUSES.has(res.statusCode)
    return new Response(bodiless ? null : new Uint8Array(res.rawPayload), {
      status: res.statusCode,
      statusText: res.statusMessage,
      headers: out,
    })
  }

  return {
    async fetch(path, init) {
      ensureOpen()
      return track(send(path, init))
    },
    async paths() {
      ensureOpen()
      return track(core.sitemapEntries().then((entries) => entries.map((e) => e.path)))
    },
    close() {
      closed ??= (async () => {
        try {
          await Promise.allSettled([...inFlight])
          await app.close()
        } finally {
          await rm(dataDir, { recursive: true, force: true })
        }
      })()
      return closed
    },
  }
}
