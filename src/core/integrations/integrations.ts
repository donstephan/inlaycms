import type { Kysely } from 'kysely'
import { assertCan } from '../auth/roles.js'
import { validateValues } from '../content/validate.js'
import type { Database } from '../db/schema.js'
import { InlayError } from '../errors.js'
import type { IntegrationDef } from '../registry/integration.js'
import type { CoreDeps, Ctx } from '../types.js'

export interface IntegrationRow {
  name: string
  enabled: boolean
  values: Record<string, unknown>
}

export interface IntegrationState {
  def: IntegrationDef
  enabled: boolean
  values: Record<string, unknown>
  /** Switched on and the saved values pass the integration's fields now. */
  active: boolean
  updatedAt: string | null
}

export interface ActiveIntegration {
  def: IntegrationDef
  values: Record<string, unknown>
}

function parseData(data: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(data)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Every stored row, defined by the site or not, by name. */
export async function readIntegrationRows(db: Kysely<Database>): Promise<IntegrationRow[]> {
  const rows = await db.selectFrom('integrations').selectAll().orderBy('name').execute()
  return rows.map((r) => ({ name: r.name, enabled: r.enabled === 1, values: parseData(r.data) }))
}

/** Replaces the whole table. Opens no transaction of its own, so call it inside the caller's. */
export async function replaceIntegrationRows(db: Kysely<Database>, rows: IntegrationRow[], now: string, by: string | null): Promise<void> {
  await db.deleteFrom('integrations').execute()
  if (rows.length === 0) return
  await db
    .insertInto('integrations')
    .values(rows.map((r) => ({ name: r.name, enabled: r.enabled ? 1 : 0, data: JSON.stringify(r.values), updated_at: now, updated_by: by })))
    .execute()
}

function definitions(deps: CoreDeps): IntegrationDef[] {
  return deps.registry.site.integrations
}

export async function listIntegrations(deps: CoreDeps, ctx: Ctx): Promise<IntegrationState[]> {
  assertCan(ctx, 'integrations.manage')
  const stored = await deps.db.selectFrom('integrations').selectAll().execute()
  const byName = new Map(stored.map((r) => [r.name, r]))
  return definitions(deps).map((def) => {
    const row = byName.get(def.name)
    if (!row) return { def, enabled: false, values: {}, active: false, updatedAt: null }
    const values = parseData(row.data)
    const enabled = row.enabled === 1
    return { def, enabled, values, active: enabled && validateValues(def.fields, values, 'strict').ok, updatedAt: row.updated_at }
  })
}

export async function saveIntegration(
  deps: CoreDeps,
  name: string,
  input: { enabled: boolean; values: Record<string, unknown> },
  ctx: Ctx,
): Promise<void> {
  assertCan(ctx, 'integrations.manage')
  const def = definitions(deps).find((d) => d.name === name)
  if (!def) throw new InlayError('not_found', 'integrations.unknown', { name })
  const result = validateValues(def.fields, input.values, input.enabled ? 'strict' : 'draft')
  if (!result.ok) throw new InlayError('validation', 'error.validation', {}, { issues: result.issues })
  const values = {
    name,
    enabled: input.enabled ? 1 : 0,
    data: JSON.stringify(result.data),
    updated_at: deps.now().toISOString(),
    updated_by: ctx.actor.id,
  }
  const { name: _name, ...update } = values
  await deps.db
    .insertInto('integrations')
    .values(values)
    .onConflict((oc) => oc.column('name').doUpdateSet(update))
    .execute()
}

/** What the site adapter renders: switched on, with saved values that pass the fields now. Needs no actor. */
export async function activeIntegrations(deps: CoreDeps): Promise<ActiveIntegration[]> {
  const stored = await deps.db.selectFrom('integrations').selectAll().where('enabled', '=', 1).execute()
  const byName = new Map(stored.map((r) => [r.name, r]))
  const active: ActiveIntegration[] = []
  for (const def of definitions(deps)) {
    const row = byName.get(def.name)
    if (!row) continue
    const result = validateValues(def.fields, parseData(row.data), 'strict')
    if (result.ok) active.push({ def, values: result.data })
  }
  return active
}
