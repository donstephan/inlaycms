import { createWriteStream } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import type { HostApi } from '../adapters/site/plugin.js'
import { previewLink } from '../adapters/site/preview.js'
import { canPush } from '../core/auth/roles.js'
import type { AuthService } from '../core/auth/service.js'
import type { GapSummary } from '../core/content/gaps.js'
import type { ShippedReport } from '../core/content/shipped.js'
import { migrateSystem } from '../core/db/migrate.js'
import { openDatabase } from '../core/db/connection.js'
import type { Database } from '../core/db/schema.js'
import { InlayError } from '../core/errors.js'
import { t, type MessageId } from '../core/messages/index.js'
import { manifestOfRegistry, manifestSchema, type ReleaseManifest } from '../core/release/manifest.js'
import type { Registry } from '../core/registry/registry.js'
import type { Actor } from '../core/types.js'
import type { HostConfig } from './config.js'
import { structuralDiff, type StructuralDiff } from './diff.js'
import type { ActivationSummary } from './ipc.js'
import { currentRelease, deleteRelease, getRelease, listReleases, releaseDir, storeRelease, type ReleaseRow } from './store.js'

/** What the staged release's own worker finds against live content (Task 5 fills it in). */
export interface ContentDiff {
  gaps: Array<Pick<GapSummary, 'type' | 'label' | 'documents'>>
  shipped: ShippedReport
  hidden: { types: Array<{ type: string; documents: number }>; locales: Array<{ locale: string; documents: number }> }
}

/** What a release would change: from the manifests alone, and against live content when that could be worked out. */
export interface ReleaseDiff {
  structural: StructuralDiff
  content: ContentDiff | null
}

export interface PushOptions {
  db: Kysely<Database>
  config: Pick<HostConfig, 'paths' | 'trustedKeys' | 'secrets' | 'baseUrl' | 'secret'>
  /** The site this app serves, compared with when no release is current; null when it serves none. */
  registry: Registry | null
  now: () => Date
  /**
   * Starts and stops a staged release's preview, whose worker works out the content half of the diff. Without
   * `startPreview` (offline, or a site not run by `inlaycms serve`) the diff has no content half.
   */
  host?: Pick<HostApi, 'startPreview' | 'stopPreview'>
  /** How long to wait for the preview's answer; 60 seconds by default. */
  diffTimeoutMs?: number
  /** With `activate`, how long the preview may take to start and answer, in all; `ACTIVATE_DIFF_TIMEOUT_MS` by default. */
  activateDiffTimeoutMs?: number
  /** Where a technical problem behind a plain-language warning is logged. */
  log?: (e: unknown) => void
}

/** What a push reports: the release kept (null for a dry run), what it would change, and why part of that is missing. */
export interface PushResult {
  release: ReleaseRow | null
  diff: ReleaseDiff
  /** Plain-language notes, such as why the content half of the diff couldn't be worked out. */
  warnings: string[]
}

/** The largest release file a push may send. */
export const PUSH_MAX_BYTES = 256 * 1024 ** 2

/** The longest name a push may give its release. */
export const RELEASE_NAME_MAX = 100

/** With `activate`, how long the content half of the diff may take in all (preview start and answer): the activation waits. */
export const ACTIVATE_DIFF_TIMEOUT_MS = 10_000

const RELEASES_PATH = '/_inlay/releases'
const BEARER = /^Bearer\s+(\S+)\s*$/i
const RELEASE_TYPES = new Set(['application/gzip', 'application/x-gzip', 'application/octet-stream'])
const DIFF_PATH = '/_inlay/internal/diff'
const DIFF_TIMEOUT_MS = 60_000

const problemOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A release row as the push API sends it: without the schema JSON, which is only kept for the record. */
export type ReleaseInfo = Omit<ReleaseRow, 'schema'>

export function releaseInfo(row: ReleaseRow): ReleaseInfo {
  const { schema: _schema, ...info } = row
  return info
}

async function readManifest(file: string): Promise<ReleaseManifest> {
  return manifestSchema.parse(JSON.parse(await readFile(file, 'utf8')))
}

/**
 * The manifest of what the site runs now: the current release's, or, for a site run from source with no current
 * release, the one its registry gives; null for a host with no site yet (everything a release has is then added).
 */
export async function currentManifest(
  opts: Pick<PushOptions, 'db' | 'registry' | 'now'> & { config: { paths: Pick<HostConfig['paths'], 'releases'> } },
): Promise<ReleaseManifest | null> {
  const row = await currentRelease(opts.db)
  if (row !== null) {
    try {
      return await readManifest(join(releaseDir(opts.config.paths.releases, row.id), 'manifest.json'))
    } catch {
      // A current release whose folder is gone or damaged: compare with what this app serves instead.
    }
  }
  return opts.registry === null ? null : manifestOfRegistry(opts.registry, { name: 'current', now: opts.now() })
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Asks the preview listening on `socketPath` what the release finds against live content. */
function fetchContentDiff(socketPath: string, timeoutMs: number): Promise<ContentDiff> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, method: 'GET', path: DIFF_PATH, headers: { accept: 'application/json' } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      res.on('end', () => {
        clearTimeout(timer)
        if (res.statusCode !== 200) {
          return reject(new InlayError('release', 'error.pushDiffAnswer', { status: res.statusCode ?? 0 }))
        }
        let body: unknown
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          body = null
        }
        if (!isObject(body) || !Array.isArray(body.gaps) || !isObject(body.shipped) || !isObject(body.hidden)) {
          return reject(new InlayError('release', 'error.pushDiffInvalid'))
        }
        resolve(body as unknown as ContentDiff)
      })
    })
    const timer = setTimeout(() => {
      request.destroy(new InlayError('release', 'error.pushDiffTimeout', { seconds: Math.round(timeoutMs / 1000) }))
    }, timeoutMs)
    request.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    request.end()
  })
}

const diffTimeout = (ms: number) => new InlayError('release', 'error.pushDiffTimeout', { seconds: Math.max(1, Math.round(ms / 1000)) })

/** `promise`, or a `pushDiffTimeout` after `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(diffTimeout(ms)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * The content half of the diff from the release's preview, started for it (from the scratch folder `dir` for a dry
 * run); null, with a warning saying why, when the preview couldn't start or answer, or not within `deadlineMs` in
 * all when that is given. Null without a warning when there is no host to start one. A technical problem (a socket
 * that isn't there, a connection cut) is logged and the warning says it in plain words.
 */
export async function contentDiff(
  opts: PushOptions,
  releaseId: string,
  how: { dir?: string; deadlineMs?: number } = {},
): Promise<{ content: ContentDiff | null; warnings: string[] }> {
  const host = opts.host
  if (host?.startPreview === undefined) return { content: null, warnings: [] }
  const startedAt = Date.now()
  try {
    const starting = how.dir === undefined ? host.startPreview(releaseId) : host.startPreview(releaseId, { dir: how.dir })
    const socket = how.deadlineMs === undefined ? await starting : await within(starting, how.deadlineMs)
    const left = how.deadlineMs === undefined ? (opts.diffTimeoutMs ?? DIFF_TIMEOUT_MS) : how.deadlineMs - (Date.now() - startedAt)
    if (left <= 0) throw diffTimeout(how.deadlineMs ?? 0)
    return { content: await fetchContentDiff(socket, left), warnings: [] }
  } catch (e) {
    let reason: string
    if (e instanceof InlayError) reason = e.message
    else {
      opts.log?.(e)
      reason = t('error.pushDiffUnreachable')
    }
    return { content: null, warnings: [t('push.diffUnavailable', { reason })] }
  }
}

/** The migration functions in `names` that haven't run for the release yet: activating it again doesn't rerun them. */
export async function pendingMigrations(db: Kysely<Database>, releaseId: string, names: readonly string[]): Promise<string[]> {
  const ran = await db.selectFrom('release_migrations').select('name').where('release_id', '=', releaseId).execute()
  const done = new Set(ran.map((r) => r.name))
  return names.filter((name) => !done.has(name))
}

/**
 * Checks the release file at `file` (signature, Inlay version, checksums, the secrets it needs) and works out what
 * it would change. Unless `dryRun`, it is then kept and recorded as staged; a dry run keeps nothing. The release is
 * opened into a scratch folder of its own under the releases folder (`.push-*`), with its row in a throwaway
 * database, and only moved into place and recorded once every check passed: a failed push leaves no file and no row.
 *
 * With a host that can start previews, the release's preview is then started for the content half of the diff (and
 * left running for whoever previews it next); with `activate`, that may take `ACTIVATE_DIFF_TIMEOUT_MS` in all. A
 * dry run's preview reads the release from the scratch folder and records it as staged only in its own copy of the
 * database: the live `releases` table never has it. The preview is stopped once it answered.
 */
export async function pushRelease(
  opts: PushOptions,
  file: string,
  push: { name?: string; dryRun: boolean; activate?: boolean; pushedBy: string | null },
): Promise<PushResult> {
  const releasesDir = opts.config.paths.releases
  await mkdir(releasesDir, { recursive: true })
  const work = await mkdtemp(join(releasesDir, '.push-'))
  const scratch = openDatabase(':memory:')
  try {
    await migrateSystem(scratch)
    const row = await storeRelease(
      { db: scratch, releasesDir: work, trustedKeys: opts.config.trustedKeys, now: opts.now },
      file,
      { pushedBy: push.pushedBy, ...(push.name !== undefined && { name: push.name }) },
    ).catch((e: unknown) => {
      // Not a tarball, or one Inlay won't open: the file is damaged or wasn't made by inlaycms pack.
      if (e instanceof InlayError && (e.messageId === 'error.archiveUnreadable' || e.messageId === 'error.archiveTooManyFiles')) {
        throw new InlayError('release', 'error.releaseInvalid')
      }
      throw e
    })
    const present = opts.config.secrets(row.secrets)
    const missing = row.secrets.filter((name) => !Object.hasOwn(present, name))
    if (missing.length > 0) throw new InlayError('release', 'error.releaseSecretsMissing', { names: missing.join(', ') })

    const staged = await readManifest(join(releaseDir(work, row.id), 'manifest.json'))
    const structural = structuralDiff(await currentManifest(opts), staged)
    if (push.dryRun) {
      if (opts.host?.startPreview === undefined) return { release: null, diff: { structural, content: null }, warnings: [] }
      try {
        const { content, warnings } = await contentDiff(opts, row.id, { dir: work })
        return { release: null, diff: { structural, content }, warnings }
      } finally {
        await opts.host.stopPreview?.(row.id).catch(() => {})
      }
    }

    const tgz = join(releasesDir, row.file)
    const dir = releaseDir(releasesDir, row.id)
    try {
      await rename(join(work, row.file), tgz)
      await rename(releaseDir(work, row.id), dir)
      await opts.db
        .insertInto('releases')
        .values({ ...row, secrets: JSON.stringify(row.secrets) })
        .execute()
    } catch (e) {
      // Only the files this push moved: a row is never removed here.
      await rm(tgz, { force: true })
      await rm(dir, { recursive: true, force: true })
      throw e
    }
    structural.migrations = await pendingMigrations(opts.db, row.id, structural.migrations)
    const { content, warnings } = await contentDiff(opts, row.id, push.activate ? { deadlineMs: opts.activateDiffTimeoutMs ?? ACTIVATE_DIFF_TIMEOUT_MS } : {})
    return { release: row, diff: { structural, content }, warnings }
  } finally {
    await scratch.destroy()
    await rm(work, { recursive: true, force: true })
  }
}

const tooLarge = (limit: number) => new InlayError('validation', 'error.pushTooLarge', { mb: Math.floor(limit / 1024 ** 2) })

/**
 * Writes the request body to `file`, refusing more than `limit` bytes. Over the limit it stops reading without
 * destroying the request, so a 413 can still be sent (the connection is then closed).
 */
function receive(body: Readable, file: string, limit: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(file, { flags: 'wx' })
    let bytes = 0
    let reading = true
    const stop = () => {
      reading = false
      body.off('data', onData)
      body.off('end', onEnd)
      body.off('error', onError)
      body.pause()
    }
    const onError = (e: unknown) => {
      if (reading) stop()
      out.destroy()
      reject(e)
    }
    const onData = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > limit) return onError(tooLarge(limit))
      if (!out.write(chunk)) {
        body.pause()
        out.once('drain', () => {
          if (reading) body.resume()
        })
      }
    }
    const onEnd = () => {
      stop()
      out.end()
    }
    out.on('error', onError)
    out.on('finish', () => resolve())
    body.on('data', onData)
    body.on('end', onEnd)
    body.on('error', onError)
  })
}

type ErrorBody = { error: { code: string; message: string } }

const errorBody = (code: string, message: string): ErrorBody => ({ error: { code, message } })

/** The status a push or release request answers for `e`. */
function statusOf(e: InlayError): number {
  switch (e.messageId) {
    case 'error.releaseSignature':
      return 403
    case 'error.releaseVersion':
    case 'error.releaseSecretsMissing':
    case 'error.releaseCurrent':
    case 'error.releaseDeleted':
      return 409
    case 'error.pushTooLarge':
      return 413
  }
  if (e.code === 'not_found') return 404
  if (e.code === 'forbidden') return 403
  return 400
}

/** The plain JSON error for `e`: an `InlayError` with its status, anything else as a 500 that is logged. */
function sendError(request: FastifyRequest, reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof InlayError) return reply.code(statusOf(e)).send(errorBody(e.code, e.message))
  const message = t('error.pushFailed', { problem: problemOf(e) })
  request.log.error({ err: e }, message)
  return reply.code(500).send(errorBody('release', message))
}

/** A failed activation, always a 500: the error it reported, or `error.releaseActivationFailed` with its message. */
function activationFailure(e: unknown): ErrorBody {
  const error = e instanceof InlayError ? e : new InlayError('release', 'error.releaseActivationFailed', { problem: problemOf(e) })
  return errorBody(error.code, error.message)
}

/** A refusal before the body was read: the connection is closed after it, so the unread body goes nowhere. */
const refuse = (reply: FastifyReply, status: 401 | 403, code: string, id: MessageId) => {
  if (status === 401) void reply.header('www-authenticate', 'Bearer')
  return reply.code(status).header('connection', 'close').send(errorBody(code, t(id)))
}

/** The caller, when the request carries the API key of an owner that may push releases; otherwise answers 401 or 403. */
async function pusher(request: FastifyRequest, reply: FastifyReply, service: AuthService): Promise<Actor | null> {
  const header = request.headers.authorization
  const token = BEARER.exec(Array.isArray(header) ? (header[0] ?? '') : (header ?? ''))?.[1]
  const found = token === undefined ? null : await service.apiKeyActor(token)
  if (found === null) {
    refuse(reply, 401, 'unauthorized', 'error.pushUnauthorized')
    return null
  }
  if (!canPush(found.actor, found.permissions)) {
    refuse(reply, 403, 'forbidden', 'error.pushForbidden')
    return null
  }
  return found.actor
}

const flag = (value: unknown) => value === '1' || value === 'true'

/**
 * The push API (spec §7), served by the current worker under `inlaycms serve`; a push token (an owner's API key that
 * may push releases) as `Authorization: Bearer` on every request, no cookies.
 * - `POST /_inlay/releases?activate&dryRun&name` with the release file as the body (`application/gzip`, at most
 *   256 MB): checks and stages it, answers 201 `{ release, diff, activation, warnings, previewUrl }` (200 with
 *   `release: null` for a dry run); `previewUrl` is a signed link that previews the staged release for 24 hours. With
 *   `activate`, asks the host to make it live (no `previewUrl` then). The content half of `diff` comes from the
 *   release's preview; when that can't be had it is null and `warnings` says why. `name` is at most 100 characters.
 * - `GET /_inlay/releases`: `{ releases, current }`, each release without its schema.
 * - `POST /_inlay/releases/:id/activate`: `{ release, activation }`.
 * - `DELETE /_inlay/releases/:id`: 204, and the release's preview is stopped; the current release can't be deleted (409).
 * Errors are `{ error: { code, message } }`.
 */
export function registerPushRoutes(
  app: FastifyInstance,
  opts: PushOptions & { service: AuthService; host: HostApi; maxBytes?: number },
): void {
  const { db, service, host } = opts
  const limit = opts.maxBytes ?? PUSH_MAX_BYTES
  const releasesDir = opts.config.paths.releases
  const { baseUrl, secret } = opts.config

  app.register(async (scope) => {
    // A body is left unread to the handler: a pushed release is streamed to a file once the caller is known.
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', (_request, payload, done) => done(null, payload))
    scope.setErrorHandler((e, request, reply) => sendError(request, reply, e))

    scope.post(RELEASES_PATH, async (request, reply) => {
      const actor = await pusher(request, reply, service)
      if (actor === null) return reply
      const type = (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
      const body = request.body as Readable | undefined
      // Each refusal before the body is read closes the connection after it, so the unread body goes nowhere.
      if (!RELEASE_TYPES.has(type) || body === undefined) {
        return reply.code(415).header('connection', 'close').send(errorBody('validation', t('error.pushContentType')))
      }
      if (Number(request.headers['content-length'] ?? 0) > limit) {
        return sendError(request, reply.header('connection', 'close'), tooLarge(limit))
      }
      const query = request.query as Record<string, string | undefined>
      const dryRun = flag(query.dryRun)
      const activate = flag(query.activate) && !dryRun
      const name = query.name?.trim() || undefined
      if (name !== undefined && name.length > RELEASE_NAME_MAX) {
        const e = new InlayError('validation', 'error.releaseNameTooLong', { max: RELEASE_NAME_MAX })
        return sendError(request, reply.header('connection', 'close'), e)
      }

      await mkdir(releasesDir, { recursive: true })
      const upload = await mkdtemp(join(releasesDir, '.upload-'))
      let pushed: PushResult | null = null
      let failure: unknown = null
      let received = false
      try {
        const file = join(upload, 'release.tgz')
        await receive(body, file, limit)
        received = true
        const log = (e: unknown) => request.log.warn({ err: e }, problemOf(e))
        pushed = await pushRelease({ ...opts, log }, file, { dryRun, activate, pushedBy: actor.id ?? null, ...(name !== undefined && { name }) })
      } catch (e) {
        failure = e
      }
      // Gone before the answer, so whoever pushed finds nothing left behind.
      await rm(upload, { recursive: true, force: true })
      if (pushed === null) return sendError(request, received ? reply : reply.header('connection', 'close'), failure)

      const { diff, warnings } = pushed
      if (pushed.release === null) return reply.code(200).send({ release: null, diff, activation: null, warnings })
      const release = releaseInfo(pushed.release)
      const previewUrl = previewLink({ baseUrl, secret, now: opts.now }, '/', { release: release.id })
      if (!activate) return reply.code(201).send({ release, diff, activation: null, warnings, previewUrl })
      let activation: ActivationSummary
      try {
        activation = await host.requestActivation(release.id)
      } catch (e) {
        return reply.code(500).send({ ...activationFailure(e), release, diff, warnings, previewUrl })
      }
      const live = await getRelease(db, release.id)
      return reply.code(201).send({ release: live === null ? release : releaseInfo(live), diff, activation, warnings })
    })

    scope.get(RELEASES_PATH, async (request, reply) => {
      if ((await pusher(request, reply, service)) === null) return reply
      const releases = (await listReleases(db)).map(releaseInfo)
      return { releases, current: releases.find((r) => r.state === 'current')?.id ?? null }
    })

    scope.post<{ Params: { id: string } }>(`${RELEASES_PATH}/:id/activate`, async (request, reply) => {
      if ((await pusher(request, reply, service)) === null) return reply
      const { id } = request.params
      const row = await getRelease(db, id)
      if (row === null) return sendError(request, reply, new InlayError('not_found', 'error.releaseUnknown', { id }))
      if (row.state === 'deleted') return sendError(request, reply, new InlayError('release', 'error.releaseDeleted', { name: row.name }))
      let activation: ActivationSummary
      try {
        activation = await host.requestActivation(id)
      } catch (e) {
        return reply.code(500).send(activationFailure(e))
      }
      return { release: releaseInfo((await getRelease(db, id)) ?? row), activation }
    })

    scope.delete<{ Params: { id: string } }>(`${RELEASES_PATH}/:id`, async (request, reply) => {
      if ((await pusher(request, reply, service)) === null) return reply
      const { id } = request.params
      try {
        await deleteRelease({ db, releasesDir }, id)
      } catch (e) {
        return sendError(request, reply, e)
      }
      // Its preview has nothing left to show.
      await host.stopPreview?.(id).catch((e: unknown) => request.log.warn({ err: e }, problemOf(e)))
      return reply.code(204).send()
    })
  })
}
