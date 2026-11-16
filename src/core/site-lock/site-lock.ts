import type { Kysely } from 'kysely'
import { passwordHasher } from '../auth/auth.js'
import { assertCan } from '../auth/roles.js'
import { contentIssue } from '../content/validate.js'
import type { Database } from '../db/schema.js'
import { InlayError } from '../errors.js'
import { t } from '../messages/index.js'
import type { ContentIssue, CoreDeps, Ctx } from '../types.js'

export interface SiteLockStatus {
  enabled: boolean
  hasPassword: boolean
}

/** What the gate and export/import need; never on the public `Core`. */
export interface SiteLockRow {
  enabled: boolean
  passwordHash: string | null
}

export const MIN_SITE_PASSWORD = 8
export const MAX_SITE_PASSWORD = 128

export async function readSiteLock(db: Kysely<Database>): Promise<SiteLockRow> {
  const row = await db.selectFrom('site_lock').selectAll().where('id', '=', 1).executeTakeFirst()
  return row ? { enabled: row.enabled === 1, passwordHash: row.password_hash } : { enabled: false, passwordHash: null }
}

export async function writeSiteLock(db: Kysely<Database>, row: SiteLockRow): Promise<void> {
  const values = { enabled: row.enabled ? 1 : 0, password_hash: row.passwordHash }
  await db
    .insertInto('site_lock')
    .values({ id: 1, ...values })
    .onConflict((oc) => oc.column('id').doUpdateSet(values))
    .execute()
}

function status(row: SiteLockRow): SiteLockStatus {
  return { enabled: row.enabled, hasPassword: row.passwordHash !== null }
}

function passwordIssues(password: string): ContentIssue[] {
  const at = ['password']
  const label = [t('label.sitePassword')]
  if (password.length < MIN_SITE_PASSWORD) return [contentIssue(at, label, 'too_short', 'issue.tooShort', { min: MIN_SITE_PASSWORD })]
  if (password.length > MAX_SITE_PASSWORD) return [contentIssue(at, label, 'too_long', 'issue.tooLong', { max: MAX_SITE_PASSWORD })]
  return []
}

export async function setSitePassword(deps: CoreDeps, password: string, ctx: Ctx): Promise<SiteLockStatus> {
  assertCan(ctx, 'site.protect')
  const issues = passwordIssues(password)
  if (issues.length > 0) throw new InlayError('validation', 'error.validation', {}, { issues })
  const current = await readSiteLock(deps.db)
  const next = { enabled: current.enabled, passwordHash: await passwordHasher().hash(password) }
  await writeSiteLock(deps.db, next)
  return status(next)
}

export async function setSiteLock(deps: CoreDeps, enabled: boolean, ctx: Ctx): Promise<SiteLockStatus> {
  assertCan(ctx, 'site.protect')
  const current = await readSiteLock(deps.db)
  if (enabled && current.passwordHash === null) throw new InlayError('invalid_operation', 'error.sitePasswordMissing')
  const next = { ...current, enabled }
  await writeSiteLock(deps.db, next)
  return status(next)
}

/** The stored hash `password` was verified against, or `null` when it doesn't match (or the hash can't be read). */
export async function matchSitePassword(db: Kysely<Database>, password: string): Promise<string | null> {
  const { passwordHash } = await readSiteLock(db)
  if (passwordHash === null) return null
  try {
    return (await passwordHasher().verify({ hash: passwordHash, password })) ? passwordHash : null
  } catch {
    return null
  }
}

export async function checkSitePassword(deps: CoreDeps, password: string): Promise<boolean> {
  return (await matchSitePassword(deps.db, password)) !== null
}
