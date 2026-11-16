import cluster from 'node:cluster'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { InlayError } from '../core/errors.js'
import { t, type MessageId } from '../core/messages/index.js'
import { INLAY_BIN } from './bin.js'
import { ensureDataDir, readHostConfig, type HostConfig } from './config.js'
import { isPrimaryMessage, isWorkerMessage, type PrimaryMessage, type WorkerMessage } from './ipc.js'
import { createSupervisor, type WorkerHandle } from './primary.js'
import { readWorkerEnv, runWorker, type WorkerEnv } from './worker.js'

export interface ServeIo {
  out(line: string): void
  err(line: string): void
}

function forkWorker(env: Record<string, string>): WorkerHandle {
  const worker = cluster.fork(env)
  return {
    id: worker.id,
    send(m: PrimaryMessage) {
      if (worker.isConnected()) worker.send(m)
    },
    on(event: 'message' | 'exit', fn: ((m: WorkerMessage) => void) | ((code: number | null) => void)) {
      if (event === 'message') {
        worker.on('message', (m: unknown) => {
          if (isWorkerMessage(m)) (fn as (m: WorkerMessage) => void)(m)
        })
      } else {
        worker.on('exit', (code: number | null) => (fn as (code: number | null) => void)(code))
      }
    },
    kill() {
      worker.process.kill('SIGKILL')
    },
  }
}

/**
 * Removes what an earlier run left behind when it stopped mid-way: half-received pushes (`releases/.upload-*`,
 * `releases/.push-*`) and the previews' copies and sockets (everything in `run/`). Run by the primary before any
 * worker starts.
 */
export async function sweepLeftovers(config: Pick<HostConfig, 'dataDir' | 'paths'>): Promise<void> {
  const entries = async (dir: string) => readdir(dir).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? [] : Promise.reject(e)))
  for (const name of await entries(config.paths.releases)) {
    if (name.startsWith('.upload-') || name.startsWith('.push-')) await rm(join(config.paths.releases, name), { recursive: true, force: true })
  }
  const run = join(config.dataDir, 'run')
  for (const name of await entries(run)) await rm(join(run, name), { recursive: true, force: true })
}

function readConfig(io: ServeIo): HostConfig | null {
  try {
    return readHostConfig(process.env, { needKeys: true })
  } catch (e) {
    io.err(e instanceof InlayError ? e.message : String(e))
    return null
  }
}

async function worker(io: ServeIo): Promise<number> {
  // The primary decides when a worker stops; a signal sent to the whole process group must not cut requests off.
  process.on('SIGINT', () => {})
  process.on('SIGTERM', () => {})
  let sent: Promise<unknown> = Promise.resolve()
  const exit = (code: number) => void sent.then(() => process.exit(code))
  const config = readConfig(io)
  let env: WorkerEnv
  try {
    env = readWorkerEnv(process.env)
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e))
    exit(2)
    return 2
  }
  if (config === null) {
    exit(2)
    return 2
  }
  await runWorker(
    config,
    env,
    {
      send: (m) => {
        sent = sent.then(
          () =>
            new Promise((resolve) => {
              if (process.send) process.send(m, undefined, {}, resolve)
              else resolve(null)
            }),
        )
      },
      onMessage: (fn) =>
        process.on('message', (m: unknown) => {
          if (isPrimaryMessage(m)) fn(m)
        }),
      exit,
      log: (id, params) => io.err(t(id, params)),
    },
  )
  return 0
}

/**
 * `inlaycms serve`: in the primary, supervises the workers until SIGTERM or SIGINT and resolves with the exit code; in
 * a worker (`cluster` runs the same command again), runs that worker.
 */
export async function serve(_argv: string[], io: ServeIo): Promise<number> {
  if (cluster.isWorker) return worker(io)
  const config = readConfig(io)
  if (config === null) return 2
  try {
    await ensureDataDir(config)
    await sweepLeftovers(config)
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e))
    return 2
  }
  const log = (id: MessageId, params?: Record<string, string | number>) => io.err(t(id, params))
  // Workers run the `inlaycms` command's own file, not whatever started the primary.
  cluster.setupPrimary({ exec: INLAY_BIN, args: ['serve'] })
  return new Promise<number>((resolve) => {
    let code = 0
    let stopping = false
    const supervisor = createSupervisor(config, {
      fork: forkWorker,
      log,
      onFatal: () => {
        code = 1
        void shutDown()
      },
    })
    const shutDown = async () => {
      if (stopping) return
      stopping = true
      process.off('SIGTERM', onSignal)
      process.off('SIGINT', onSignal)
      await supervisor.stop()
      resolve(code)
    }
    const onSignal = () => {
      log('host.stopping')
      void shutDown()
    }
    process.on('SIGTERM', onSignal)
    process.on('SIGINT', onSignal)
    supervisor.start().catch((e: unknown) => {
      io.err(e instanceof Error ? e.message : String(e))
      code = 1
      void shutDown()
    })
  })
}
