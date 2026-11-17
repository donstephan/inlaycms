import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { InlayError } from '../../core/errors.js'
import type { ActivationSummary } from '../../host/ipc.js'
import type { ReleaseDiff, ReleaseInfo } from '../../host/push.js'

/** What the server answers to a push. */
export interface PushAnswer {
  /** The release kept on the server; null for a dry run. */
  release: ReleaseInfo | null
  diff: ReleaseDiff
  /** What making it live did; null without `activate`, or when that failed (see `failed`). */
  activation: ActivationSummary | null
  warnings: string[]
  /** Why the release, kept on the server, couldn't be made live; null when it was, or wasn't asked to be. */
  failed: string | null
  /** A signed link that previews the staged release; null when there is none (a dry run, or made live). */
  previewUrl: string | null
}

export interface ReleaseList {
  releases: ReleaseInfo[]
  current: string | null
}

export interface ActivateAnswer {
  release: ReleaseInfo
  activation: ActivationSummary
}

export interface RemoteOptions {
  /** Lets the token go over plain http:// to a server that isn't this computer. */
  insecure?: boolean
  /** How long the server may send nothing, once the request is sent, before Inlay gives up: 15 minutes by default. */
  timeoutMs?: number
}

/** A push or an activation waits for the activation, which may take up to 10 minutes on the server. */
export const REMOTE_TIMEOUT_MS = 15 * 60_000

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Whether `arg` is a server address rather than a file, an ID or a folder. */
export const isRemote = (arg: string | undefined): arg is string => arg !== undefined && /^https?:\/\//i.test(arg)

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Refuses (`cli.pushInsecure`, a `config` error) to send the push token over plain http:// to anything but this
 * computer, unless `insecure`.
 */
export function checkTransport(host: string, insecure: boolean): void {
  let url: URL
  try {
    url = new URL(host)
  } catch {
    throw new InlayError('config', 'cli.pushHost', { host })
  }
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname.toLowerCase()) && !insecure) {
    throw new InlayError('config', 'cli.pushInsecure', { host })
  }
}

/** The address of the push API on `host`, which may sit under a path. */
function releasesUrl(host: string, path = ''): string {
  return `${host.replace(/\/+$/, '')}/_inlay/releases${path}`
}

/** The server's plain-language error from an `{ error: { message } }` body, if it sent one. */
function errorOf(body: unknown): string | null {
  return isObject(body) && isObject(body.error) && typeof body.error.message === 'string' ? body.error.message : null
}

type Raw = { status: number; text: string; location: string | undefined }

/**
 * Sends one request with node's own client (no redirects followed, no proxy) on a connection of its own, never one
 * kept from an earlier request (whose worker may be shutting down), and reads the whole answer. `sent` turns true
 * once the request, body and all, has gone out (for a file, once its last byte is handed over).
 */
function send(url: URL, method: string, headers: OutgoingHttpHeaders, file: string | undefined, timeoutMs: number, sent: { done: boolean }): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers, agent: false }, (res: IncomingMessage) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), location: res.headers.location }))
    })
    request.setTimeout(timeoutMs, () => {
      request.destroy(new InlayError('release', 'error.remoteTimeout', { seconds: Math.round(timeoutMs / 1000) }))
    })
    request.on('error', reject)
    request.on('finish', () => (sent.done = true))
    if (file === undefined) return void request.end()
    // Sent once every byte is handed over: the stream's own end waits on one more read to find the end of the file,
    // and by then the server, which has all it needs, may already have answered or cut the connection.
    let left = Number(headers['content-length'])
    const body = createReadStream(file)
    body.on('data', (chunk) => {
      left -= chunk.length
      if (left <= 0) sent.done = true
    })
    body.on('error', (e) => request.destroy(e))
    body.pipe(request)
  })
}

/**
 * Sends one request to the push API with the token and answers the status and parsed JSON body (null for none).
 * A server that can't be reached is `error.remoteUnreachable`, a redirect `error.remoteRedirect` (the token is never
 * sent on), and a body that isn't JSON `error.remoteAnswer`. With `mayHaveWorked` (a push or an activation), a
 * request that went out but got no answer in time, lost its connection, or got a 5xx that isn't the server's own
 * error is `cli.pushUnknown`: it may still have gone through.
 */
async function call(
  host: string,
  token: string,
  path: string,
  req: { method: 'GET' | 'POST'; file?: string; mayHaveWorked?: boolean },
  opts: RemoteOptions,
): Promise<{ status: number; body: unknown }> {
  checkTransport(host, opts.insecure === true)
  const headers: OutgoingHttpHeaders = { authorization: `Bearer ${token}`, accept: 'application/json' }
  if (req.file !== undefined) {
    headers['content-type'] = 'application/gzip'
    headers['content-length'] = (await stat(req.file)).size
  } else if (req.method === 'POST') headers['content-length'] = 0
  const sent = { done: false }
  const unknown = (problem: string) => new InlayError('release', 'cli.pushUnknown', { host, problem })
  let res: Raw
  try {
    res = await send(new URL(releasesUrl(host, path)), req.method, headers, req.file, opts.timeoutMs ?? REMOTE_TIMEOUT_MS, sent)
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause : e
    const problem = cause instanceof Error ? cause.message : String(cause)
    if (req.mayHaveWorked && sent.done) throw unknown(problem)
    throw new InlayError('release', 'error.remoteUnreachable', { host, problem })
  }
  if (res.status >= 300 && res.status < 400) {
    throw new InlayError('release', 'error.remoteRedirect', { host, location: res.location ?? '' })
  }
  let body: unknown = null
  if (res.text !== '') {
    try {
      body = JSON.parse(res.text) as unknown
    } catch {
      body = undefined
    }
  }
  if (res.status >= 500 && req.mayHaveWorked && errorOf(body) === null) {
    throw unknown(new InlayError('release', 'error.remoteStatus', { status: res.status }).message)
  }
  if (body === undefined) throw new InlayError('release', 'error.remoteAnswer', { host, status: res.status })
  return { status: res.status, body }
}

/** The server's refusal as an error: its own message, or `error.remoteAnswer` when it sent none. */
function refused(host: string, status: number, body: unknown): InlayError {
  const message = errorOf(body)
  return message === null
    ? new InlayError('release', 'error.remoteAnswer', { host, status })
    : new InlayError('release', 'error.remoteRefused', { host, message })
}

/**
 * Pushes the release file `file` to `host`. A refusal throws `error.remoteRefused` with the server's message,
 * except a release kept on the server that then couldn't be made live: that answers with `failed` set, so the diff
 * is still shown.
 */
export async function pushFile(
  host: string,
  token: string,
  file: string,
  opts: { activate?: boolean; dryRun?: boolean; name?: string } & RemoteOptions = {},
): Promise<PushAnswer> {
  const query = new URLSearchParams()
  if (opts.activate) query.set('activate', '1')
  if (opts.dryRun) query.set('dryRun', '1')
  if (opts.name !== undefined) query.set('name', opts.name)
  const search = query.size > 0 ? `?${query}` : ''
  const { status, body } = await call(host, token, search, { method: 'POST', file, mayHaveWorked: !opts.dryRun }, opts)
  if (!isObject(body) || !isObject(body.diff)) throw refused(host, status, body)
  const answer: PushAnswer = {
    release: isObject(body.release) ? (body.release as unknown as ReleaseInfo) : null,
    diff: body.diff as unknown as ReleaseDiff,
    activation: isObject(body.activation) ? (body.activation as unknown as ActivationSummary) : null,
    warnings: Array.isArray(body.warnings) ? body.warnings.filter((w): w is string => typeof w === 'string') : [],
    failed: null,
    previewUrl: typeof body.previewUrl === 'string' ? body.previewUrl : null,
  }
  if (status >= 200 && status < 300) return answer
  const failed = errorOf(body)
  if (failed === null || answer.release === null) throw refused(host, status, body)
  return { ...answer, activation: null, failed }
}

/** The releases on `host`, newest first, with the current one's ID. */
export async function listRemoteReleases(host: string, token: string, opts: RemoteOptions = {}): Promise<ReleaseList> {
  const { status, body } = await call(host, token, '', { method: 'GET' }, opts)
  if (status !== 200 || !isObject(body) || !Array.isArray(body.releases)) throw refused(host, status, body)
  return { releases: body.releases as ReleaseInfo[], current: typeof body.current === 'string' ? body.current : null }
}

/** Makes the release `id` on `host` live. */
export async function activateRemote(host: string, token: string, id: string, opts: RemoteOptions = {}): Promise<ActivateAnswer> {
  const { status, body } = await call(host, token, `/${encodeURIComponent(id)}/activate`, { method: 'POST', mayHaveWorked: true }, opts)
  if (status !== 200 || !isObject(body) || !isObject(body.release) || !isObject(body.activation)) throw refused(host, status, body)
  return { release: body.release as unknown as ReleaseInfo, activation: body.activation as unknown as ActivationSummary }
}
