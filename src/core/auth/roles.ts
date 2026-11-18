import { InlayError } from '../errors.js'
import { t } from '../messages/index.js'
import type { Actor, Ctx, RevisionSource, Role } from '../types.js'

export type Action =
  | 'content.read'
  | 'content.write'
  | 'content.publish'
  | 'entry.delete'
  | 'entry.restore'
  | 'backup.create'
  | 'backup.read'
  | 'content.export'
  | 'content.import'
  | 'media.write'
  | 'redirects.write'
  | 'users.manage'
  | 'site.protect'
  | 'integrations.manage'
  | 'release.push'
  | 'release.activate'
  | 'release.manage'

/** What only owners may do. */
const OWNER_ONLY: ReadonlySet<Action> = new Set<Action>([
  'entry.restore',
  'backup.create',
  'backup.read',
  'content.export',
  'content.import',
  'users.manage',
  'site.protect',
  'integrations.manage',
  'release.push',
  'release.activate',
  'release.manage',
])

export function can(role: Role, action: Action): boolean {
  switch (role) {
    case 'owner':
    case 'system':
      return true
    case 'editor':
      return !OWNER_ONLY.has(action)
    default:
      return false
  }
}

/** Whether an API key may push releases: its user is an owner now and the key was made with the `release:push` permission. */
export function canPush(actor: Actor, permissions: { release?: string[] }): boolean {
  return actor.role === 'owner' && can(actor.role, 'release.push') && (permissions.release ?? []).includes('push')
}

export function assertCan(ctx: Ctx, action: Action): void {
  if (!can(ctx.actor.role, action)) throw new InlayError('forbidden', 'error.forbidden')
}

/** The context for work Inlay does itself (initial content, system changes, restores). */
export function systemCtx(source: RevisionSource): Ctx {
  return { actor: { id: null, name: t('label.system'), role: 'system' }, source }
}
