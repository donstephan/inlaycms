import type { HostApi } from '../adapters/site/plugin.js'
import { previewLink } from '../adapters/site/preview.js'
import { InlayError } from '../core/errors.js'
import type { ReleaseManifest } from '../core/release/manifest.js'
import type { ActivationSummary } from './ipc.js'
import {
  ACTIVATE_DIFF_TIMEOUT_MS,
  contentDiff,
  currentManifest,
  pushRelease,
  type ContentDiff,
  type PushOptions,
  type ReleaseDiff,
} from './push.js'
import { currentRelease, type ReleaseRow } from './store.js'

/** What a staged release finds against live content; `content` is null, with `warnings` saying why, when that couldn't be worked out. */
export interface ContentDiffResult {
  content: ContentDiff | null
  warnings: string[]
}

/**
 * What the admin's Releases screen can ask of the host it runs under. Without them (tests, `inlaycms dev`) the screen
 * still lists, compares, deletes and uploads releases, but can't preview or activate one.
 */
export interface AdminHostHooks {
  /** Makes a stored release live; rejects with the activation's error, the previous release still live. */
  requestActivation(id: string): Promise<ActivationSummary>
  /** What a staged release finds against live content, from its preview, within a short deadline. */
  contentDiff(id: string): Promise<ContentDiffResult>
  /** Checks and stages a release file as a push does. */
  pushFile(
    file: string,
    opts: { pushedBy: string | null; name?: string },
  ): Promise<{ release: ReleaseRow; diff: ReleaseDiff; previewUrl: string }>
  /** The release's preview worker, if one runs, is no longer needed (the release was deleted). */
  stopPreview?(id: string): Promise<void>
  /** The manifest of what the site runs now, as a push compares with; null when the host serves no site yet. */
  liveManifest?(): Promise<ReleaseManifest | null>
}

/**
 * The admin's hooks for a site served by `inlaycms serve`: activation through `host`, the rest as the push API does it.
 * A staged release's content diff is asked of its preview within `activateDiffTimeoutMs` (`ACTIVATE_DIFF_TIMEOUT_MS`
 * by default) and kept, per release, while the same release stays live; a diff that couldn't be had is asked again.
 */
export function adminHostHooks(opts: PushOptions & { host: HostApi }): AdminHostHooks {
  const diffs = new Map<string, { live: string | null; content: ContentDiff }>()
  const live = async () => (await currentRelease(opts.db))?.id ?? null
  return {
    requestActivation: async (id) => {
      try {
        return await opts.host.requestActivation(id)
      } finally {
        diffs.clear()
      }
    },
    contentDiff: async (id) => {
      const now = await live()
      const kept = diffs.get(id)
      if (kept !== undefined && kept.live === now) return { content: kept.content, warnings: [] }
      const found = await contentDiff(opts, id, { deadlineMs: opts.activateDiffTimeoutMs ?? ACTIVATE_DIFF_TIMEOUT_MS })
      if (found.content !== null) diffs.set(id, { live: now, content: found.content })
      return found
    },
    pushFile: async (file, push) => {
      if (opts.config.trustedKeys.length === 0) throw new InlayError('release', 'admin.releases.noKeys')
      const { release, diff } = await pushRelease(opts, file, { ...push, dryRun: false })
      if (release === null) throw new InlayError('release', 'error.releaseInvalid')
      if (diff.content !== null) diffs.set(release.id, { live: await live(), content: diff.content })
      const previewUrl = previewLink({ baseUrl: opts.config.baseUrl, secret: opts.config.secret, now: opts.now }, '/', { release: release.id })
      return { release, diff, previewUrl }
    },
    stopPreview: async (id) => {
      diffs.delete(id)
      await opts.host.stopPreview?.(id)
    },
    liveManifest: () => currentManifest(opts),
  }
}
