import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { InlayError, type ErrorCode } from '../core/errors.js'
import { en } from '../core/messages/en.js'
import type { MessageId } from '../core/messages/index.js'

/** What a failed activation reports: the error code, its plain-language message and, for an `InlayError`, its message ID. */
export interface IpcError {
  code: string
  message: string
  messageId?: string
  params?: Record<string, string | number>
}

/** What an activation did, as counts, so it can cross from the worker that did it to the one that asked. */
export interface ActivationSummary {
  shipped: { created: number; replaced: number; skipped: number }
  /** The migration functions run, in order. */
  migrations: string[]
  /** The pre-activation backup, null when none was needed. */
  backup: string | null
  /** True when the release was already current and nothing was done. */
  noop: boolean
  /** How many shipped slugs or paths were already taken and resolved. */
  warnings: number
}

/**
 * The Unix socket the preview of `releaseId` listens on: a short name under `<dataDir>/run`, as a socket path can't be
 * much over 100 bytes.
 */
export function previewSocket(dataDir: string, releaseId: string): string {
  return join(dataDir, 'run', `p-${createHash('sha256').update(releaseId).digest('hex').slice(0, 12)}.sock`)
}

/** How long a worker waits for a preview worker to be ready. */
export const PREVIEW_START_TIMEOUT_MS = 60_000

/** A preview worker that no request used for this long is stopped. */
export const PREVIEW_IDLE_MS = 10 * 60_000

/** How long an activation may take: the primary stops its worker, and a worker that asked stops waiting, after it. */
export const ACTIVATION_TIMEOUT_MS = 10 * 60_000

/** Messages a worker sends to the primary. */
export type WorkerMessage =
  /** Listening; `releaseId` is the release it serves, null for the "no site" page. An activation worker adds what it did. */
  | { type: 'ready'; releaseId: string | null; activation?: ActivationSummary }
  /** Asks the primary to make a stored release live (push, the admin). Only the current worker may ask. */
  | { type: 'activate'; requestId: string; releaseId: string }
  /** An activation worker committed the activation: the release is current, whether or not it then starts serving. */
  | { type: 'activated'; activation: ActivationSummary }
  /** An activation worker that couldn't start, activate or listen. */
  | { type: 'failed'; error: IpcError }
  /**
   * Asks the primary for the preview worker of a staged release, started if it isn't running. Only the current worker
   * may ask. `dir`: a push's scratch folder (`<releases>/.push-*`) holding the release, for a dry run that keeps nothing.
   */
  | { type: 'preview-start'; requestId: string; releaseId: string; dir?: string }
  /** The release's preview worker is no longer needed. */
  | { type: 'preview-stop'; releaseId: string }
  /** The release's preview is still in use (sent at most once a minute), so its worker isn't stopped as idle. */
  | { type: 'preview-touch'; releaseId: string }
  /** A preview worker is listening on the Unix socket `socket`. A preview worker that can't start sends `failed`. */
  | { type: 'preview-ready'; releaseId: string; socket: string }

/** Messages the primary sends to a worker. */
export type PrimaryMessage =
  /** Stop accepting requests, finish the ones in flight and exit. */
  | { type: 'shutdown' }
  /** The answer to a worker's `activate` request. */
  | { type: 'activation'; requestId: string; ok: true; activation: ActivationSummary }
  | { type: 'activation'; requestId: string; ok: false; error: IpcError }
  /** The answer to a worker's `preview-start` request: the socket the preview worker listens on. */
  | { type: 'preview'; requestId: string; ok: true; socket: string }
  | { type: 'preview'; requestId: string; ok: false; error: IpcError }

const isObject = (m: unknown): m is { type: unknown } => typeof m === 'object' && m !== null && 'type' in m

const WORKER_TYPES = new Set<unknown>(['ready', 'activate', 'activated', 'failed', 'preview-start', 'preview-stop', 'preview-touch', 'preview-ready'])
const PRIMARY_TYPES = new Set<unknown>(['shutdown', 'activation', 'preview'])

export function isWorkerMessage(m: unknown): m is WorkerMessage {
  return isObject(m) && WORKER_TYPES.has(m.type)
}

export function isPrimaryMessage(m: unknown): m is PrimaryMessage {
  return isObject(m) && PRIMARY_TYPES.has(m.type)
}

const CODES: Record<ErrorCode, true> = {
  not_found: true,
  forbidden: true,
  conflict: true,
  validation: true,
  in_use: true,
  invalid_operation: true,
  definition: true,
  shipped_content: true,
  check_failed: true,
  config: true,
  release: true,
  read_only: true,
}

/**
 * The error an activation reported over IPC, as an `InlayError` with its code and its own message: an `InlayError`
 * comes back as it was thrown, anything else as `error.releaseActivationFailed` with its message.
 */
export function activationError(error: IpcError): InlayError {
  const code = Object.hasOwn(CODES, error.code) ? (error.code as ErrorCode) : 'release'
  if (error.messageId !== undefined && Object.hasOwn(en, error.messageId)) {
    try {
      return new InlayError(code, error.messageId as MessageId, error.params ?? {})
    } catch {
      // Params that don't fit the message: fall back to its text.
    }
  }
  return new InlayError(code, 'error.releaseActivationFailed', { problem: error.message })
}

export function toIpcError(e: unknown): IpcError {
  if (e instanceof InlayError) return { code: e.code, message: e.message, messageId: e.messageId, params: e.params }
  return { code: 'release', message: e instanceof Error ? e.message : String(e) }
}
