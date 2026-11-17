import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { loadConfig } from '../config.js'
import { InlayError } from '../core/errors.js'
import { t } from '../core/messages/index.js'
import { INLAY_ENTRIES } from '../core/release/read.js'
import { createSiteApp, sourceFromConfig } from './app.js'
import { INLAY_BIN } from './bin.js'
import { ensureDataDir, readHostConfig } from './config.js'

export interface DevIo {
  cwd: string
  out(line: string): void
  err(line: string): void
}

/** Only for `inlaycms dev` on a developer's computer: the server's own secret when INLAY_SECRET isn't set. */
const DEV_SECRET = 'inlay-development-secret-not-for-production-0123456789'
const DEBOUNCE_MS = 200
const STOP_TIMEOUT_MS = 10_000

function usage(io: DevIo): number {
  for (const line of t('cli.usage').split('\n')) io.err(line)
  return 2
}

function findConfig(cwd: string, explicit: string | undefined): string {
  if (explicit) return resolve(cwd, explicit)
  for (const name of ['inlay.config.ts', 'inlay.config.js', 'inlay.config.mjs']) {
    const candidate = join(cwd, name)
    if (existsSync(candidate)) return candidate
  }
  throw new InlayError('not_found', 'error.configMissing', { path: join(cwd, 'inlay.config.ts') })
}

/** The host settings for a site run from source: the environment, with development defaults for the rest. */
function devEnv(env: NodeJS.ProcessEnv, cwd: string, siteDir: string, port: number): NodeJS.ProcessEnv {
  return {
    ...env,
    INLAY_DATA_DIR: env.INLAY_DATA_DIR ? resolve(cwd, env.INLAY_DATA_DIR) : join(siteDir, 'data'),
    INLAY_BASE_URL: env.INLAY_BASE_URL || `http://localhost:${port}`,
    INLAY_SECRET: env.INLAY_SECRET ?? DEV_SECRET,
    INLAY_PORT: String(port),
    INLAY_HOST: env.INLAY_HOST || 'localhost',
  }
}

/** Whether a change at `rel` (relative to the site folder) leaves the running site as it is. */
function ignored(rel: string, dataRel: string | null): boolean {
  const parts = rel.split(sep)
  if (parts.some((p) => p === 'node_modules' || p.startsWith('.'))) return true
  const under = (dir: string) => rel === dir || rel.startsWith(dir + sep)
  return under('data') || (dataRel !== null && under(dataRel)) || under(join('assets', 'admin'))
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Watches the site folder for changes that matter, calling `onChange` with the path relative to it. The folder
 * itself is watched for its own entries and each folder in it separately, so the watch never descends into
 * `node_modules`, dotfiles or the data folder (a folder that holds the data folder is split up the same way).
 */
function watchSite(siteDir: string, dataRel: string | null, onChange: (rel: string) => void): { close(): void } {
  const watchers = new Map<string, FSWatcher>()
  /** Stops watching `rel` and every folder in it. */
  const forget = (rel: string) => {
    for (const key of [...watchers.keys()]) {
      if (key !== rel && !(rel === '' || key.startsWith(rel + sep))) continue
      watchers.get(key)!.close()
      watchers.delete(key)
    }
  }
  const add = (rel: string) => {
    if (watchers.has(rel) || (rel !== '' && ignored(rel, dataRel))) return
    const abs = rel === '' ? siteDir : join(siteDir, rel)
    // Split up: the site folder, and any folder the data folder is in. The rest is watched whole.
    const split = rel === '' || (dataRel !== null && dataRel.startsWith(rel + sep))
    const watcher = watch(abs, { recursive: !split }, (_event, name) => {
      if (name === null) return
      const changed = rel === '' ? String(name) : join(rel, String(name))
      if (ignored(changed, dataRel)) return
      if (split) {
        // A folder made, removed or replaced here: watch what is there now.
        forget(changed)
        if (isDirectory(join(siteDir, changed))) add(changed)
      }
      onChange(changed)
    })
    watcher.on('error', () => forget(rel))
    watchers.set(rel, watcher)
    if (split) {
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        if (entry.isDirectory()) add(rel === '' ? entry.name : join(rel, entry.name))
      }
    }
  }
  try {
    add('')
  } catch (e) {
    for (const rel of [...watchers.keys()]) forget(rel)
    throw e
  }
  return {
    close() {
      for (const rel of [...watchers.keys()]) forget(rel)
    },
  }
}

/**
 * Makes the site's `import 'inlaycms'` load the running copy, as a release's `site.js` does, so a site folder
 * without its own install (or with another copy) still shares the host's field definitions.
 */
function useRunningInlay(): void {
  const urls = new Map(Object.entries(INLAY_ENTRIES).map(([specifier, file]) => [specifier, pathToFileURL(file).href]))
  registerHooks({
    resolve(specifier, context, next) {
      const url = urls.get(specifier)
      return url === undefined ? next(specifier, context) : { url, shortCircuit: true }
    },
  })
}

/** The child: loads the site from source, applies its shipped content and serves it until told to stop. */
async function runSite(configFile: string, io: DevIo): Promise<number> {
  // The parent decides when the site stops; Ctrl-C reaches the whole process group.
  process.on('SIGINT', () => {})
  let app: Awaited<ReturnType<typeof createSiteApp>>['app'] | undefined
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await app?.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void close())
  process.on('disconnect', () => void close())
  try {
    useRunningInlay()
    const loaded = await loadConfig(configFile)
    const host = readHostConfig(process.env)
    await ensureDataDir(host)
    app = (await createSiteApp(host, sourceFromConfig(loaded), { content: 'apply', logger: true })).app
    if (closing) return 0
    await app.listen({ port: host.port, host: host.host })
  } catch (e) {
    io.err(t('host.workerFailed', { problem: e instanceof Error ? e.message : String(e) }))
    process.exit(1)
  }
  process.send?.({ type: 'ready' })
  return 0
}

/**
 * `inlaycms dev`: runs the site from its source in a child process and restarts it whenever a file in the site folder
 * changes, until SIGINT or SIGTERM. The child is this same command with INLAY_DEV_CONFIG set.
 */
export async function dev(argv: string[], io: DevIo): Promise<number> {
  const childConfig = process.env.INLAY_DEV_CONFIG
  if (childConfig && process.send) return runSite(childConfig, io)

  let values: { config?: string | undefined; port?: string | undefined }
  try {
    ;({ values } = parseArgs({ args: argv, options: { config: { type: 'string' }, port: { type: 'string' } } }))
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e))
    return usage(io)
  }
  const portRaw = values.port ?? (process.env.INLAY_PORT || '3000')
  const port = Number(portRaw)
  if (!/^\d+$/.test(portRaw) || port < 1 || port > 65535) {
    io.err(t('host.devPort', { value: portRaw }))
    return 2
  }

  let configFile: string
  let env: NodeJS.ProcessEnv
  let dataDir: string
  let baseUrl: string
  try {
    configFile = findConfig(io.cwd, values.config)
    if (!existsSync(configFile)) throw new InlayError('not_found', 'error.configMissing', { path: configFile })
    env = devEnv(process.env, io.cwd, dirname(configFile), port)
    ;({ dataDir, baseUrl } = readHostConfig(env))
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e))
    return 2
  }
  const siteDir = dirname(configFile)
  const dataRel = relative(siteDir, dataDir)
  const dataInside = dataRel !== '' && !dataRel.startsWith('..') && !isAbsolute(dataRel) ? dataRel : null

  return new Promise<number>((done) => {
    let child: ChildProcess | null = null
    /** Children told to stop, whose exit isn't news. */
    const told = new WeakSet<ChildProcess>()
    let announced = false
    let stopping = false
    let timer: NodeJS.Timeout | undefined
    let changed: string | null = null
    let restarting: Promise<void> = Promise.resolve()

    const start = () => {
      const proc = fork(INLAY_BIN, ['dev'], {
        env: { ...env, INLAY_DEV_CONFIG: configFile },
        stdio: 'inherit',
      })
      child = proc
      proc.on('message', (m: unknown) => {
        if ((m as { type?: unknown } | null)?.type !== 'ready' || announced) return
        announced = true
        io.out(t('host.devListening', { url: baseUrl }))
      })
      proc.on('exit', (code, signal) => {
        if (child === proc) child = null
        if (!stopping && !told.has(proc)) {
          io.err(t('host.devStopped', { code: code ?? signal ?? '' }))
        }
      })
    }

    const stopChild = async () => {
      const proc = child
      if (proc === null || proc.exitCode !== null || proc.signalCode !== null) return
      told.add(proc)
      const gone = new Promise((exited) => proc.once('exit', exited))
      proc.kill('SIGTERM')
      const force = setTimeout(() => proc.kill('SIGKILL'), STOP_TIMEOUT_MS)
      await gone
      clearTimeout(force)
    }

    const restart = () => {
      const file = changed
      changed = null
      if (file === null || stopping) return
      restarting = restarting.then(async () => {
        if (stopping) return
        io.out(t('host.devRestart', { file }))
        await stopChild()
        if (!stopping) start()
      })
    }

    let watcher: { close(): void } | null = null
    try {
      watcher = watchSite(siteDir, dataInside, (rel) => {
        changed = rel
        clearTimeout(timer)
        timer = setTimeout(restart, DEBOUNCE_MS)
      })
    } catch (e) {
      io.err(e instanceof Error ? e.message : String(e))
      done(2)
      return
    }

    const shutDown = async () => {
      if (stopping) return
      stopping = true
      process.off('SIGINT', shutDown)
      process.off('SIGTERM', shutDown)
      clearTimeout(timer)
      watcher?.close()
      await restarting
      await stopChild()
      done(0)
    }
    process.on('SIGINT', shutDown)
    process.on('SIGTERM', shutDown)
    start()
  })
}
