import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { AUTH, inlay, type InlayOptions } from '../../src/adapters/site/plugin.js'
import type { AuthService } from '../../src/core/auth/service.js'
import type { Core } from '../../src/core/core.js'
import type { SiteDefinition } from '../../src/core/registry/define.js'
import type { Ctx, UploadLimits } from '../../src/core/types.js'
import { webSite } from '../fixtures/web.js'

/** The clock `makeCore` uses: starts at 2026-01-01T00:00:00Z and ticks 1s per call. */
export function testClock(): () => Date {
  let time = Date.parse('2026-01-01T00:00:00.000Z')
  return () => {
    const d = new Date(time)
    time += 1000
    return d
  }
}

/** Options `makeApp` passes to the plugin; tests override them to check option handling. */
export async function appOptions(
  opts: Partial<InlayOptions> = {},
): Promise<InlayOptions & { media: string; backups: string }> {
  const media = await mkdtemp(join(tmpdir(), 'inlay-media-'))
  const backups = opts.backups ?? (await mkdtemp(join(tmpdir(), 'inlay-backups-')))
  return {
    site: webSite,
    db: ':memory:',
    baseUrl: 'https://example.com',
    secret: 's'.repeat(32),
    now: testClock(),
    rateLimit: false,
    backupSchedule: false,
    ...opts,
    media,
    backups,
  }
}

export interface MakeAppOptions {
  site?: SiteDefinition
  /** A database file, so two apps (say, before and after a site change) can share one; in memory by default. */
  db?: string
  cache?: InlayOptions['cache']
  cdn?: InlayOptions['cdn']
  baseUrl?: string
  uploads?: UploadLimits
  publicDir?: string
  /** better-auth's login rate limit; off by default. */
  rateLimit?: boolean
  /** The admin's Releases screen: the releases folder, the keys an upload must be signed with, the host's hooks. */
  releasesDir?: string
  trustedKeys?: readonly string[]
  readOnly?: boolean
  release?: { id: string; name: string }
  adminHost?: InlayOptions['adminHost']
  /** Creates owner@example.com and editor@example.com (password `OWNER_PASSWORD`) with an API key each. */
  withOwner?: boolean
}

export interface MadeApp {
  app: FastifyInstance
  core: Core
  owner: Ctx
  editor: Ctx
  mediaDir: string
  service: AuthService
}

/** The password of the users `makeApp({ withOwner: true })` creates. */
export const OWNER_PASSWORD = 'correct horse battery'

/**
 * A Fastify app with Inlay registered over a fresh in-memory DB, or `opts.db` (not yet `ready`, so tests can
 * still add routes). Defaults: `webSite`, `baseUrl` `https://example.com`, no rate limit. Site settings
 * (`notFound`, `admin`, `publicPaths`) come from the site. With `withOwner`, `owner` and `editor` are
 * real users, and their API keys are returned too, with `pushKey`: an owner's key that can push releases.
 */
export async function makeApp(opts: MakeAppOptions & { withOwner: true }): Promise<MadeApp & { ownerKey: string; editorKey: string; pushKey: string }>
export async function makeApp(opts?: MakeAppOptions): Promise<MadeApp & { ownerKey?: string; editorKey?: string; pushKey?: string }>
export async function makeApp(opts: MakeAppOptions = {}): Promise<MadeApp & { ownerKey?: string; editorKey?: string; pushKey?: string }> {
  const options = await appOptions({
    ...(opts.site && { site: opts.site }),
    ...(opts.db !== undefined && { db: opts.db }),
    ...(opts.baseUrl && { baseUrl: opts.baseUrl }),
    ...(opts.cache !== undefined && { cache: opts.cache }),
    ...(opts.cdn && { cdn: opts.cdn }),
    ...(opts.uploads && { uploads: opts.uploads }),
    ...(opts.publicDir && { publicDir: opts.publicDir }),
    ...(opts.rateLimit !== undefined && { rateLimit: opts.rateLimit }),
    ...(opts.releasesDir !== undefined && { releasesDir: opts.releasesDir }),
    ...(opts.readOnly !== undefined && { readOnly: opts.readOnly }),
    ...(opts.release && { release: opts.release }),
    ...(opts.trustedKeys && { trustedKeys: opts.trustedKeys }),
    ...(opts.adminHost && { adminHost: opts.adminHost }),
  })
  const app = Fastify()
  await app.register(inlay, options)
  const service = app.inlay[AUTH]
  const made = { app, core: app.inlay.core, mediaDir: options.media, service }
  if (!opts.withOwner) {
    const owner: Ctx = { actor: { id: 'user-owner', name: 'Olivia Owner', role: 'owner' }, source: 'admin' }
    const editor: Ctx = { actor: { id: 'user-editor', name: 'Eddie Editor', role: 'editor' }, source: 'admin' }
    return { ...made, owner, editor }
  }
  const password = OWNER_PASSWORD
  const ownerActor = await service.createUser({ email: 'owner@example.com', name: 'Olivia Owner', password, role: 'owner' })
  const editorActor = await service.createUser({ email: 'editor@example.com', name: 'Eddie Editor', password, role: 'editor' })
  const ownerKey = await service.createApiKey(ownerActor.id!, 'owner key')
  const editorKey = await service.createApiKey(editorActor.id!, 'editor key')
  const pushKey = await service.createApiKey(ownerActor.id!, 'push key', { permissions: { release: ['push'] } })
  return {
    ...made,
    owner: { actor: ownerActor, source: 'admin' },
    editor: { actor: editorActor, source: 'admin' },
    ownerKey,
    editorKey,
    pushKey,
  }
}
