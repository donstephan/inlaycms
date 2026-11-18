import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { InlayError } from '../../../core/errors.js'
import { fieldMeta, type AdminWidget, type AgentRefs, type FieldMeta } from '../../../core/fields/define.js'
import type { IntegrationState } from '../../../core/integrations/integrations.js'
import { t } from '../../../core/messages/index.js'
import type { ConsentCategory } from '../../../core/registry/integration.js'
import type { Ctx } from '../../../core/types.js'
import { adminActor, forbidden, formValues, HTML, noticeOf, notFound, type AdminContext } from '../context.js'
import { Alert, adminPage } from '../views/layout.js'

type Errors = Record<string, string[]>

/** What a re-rendered form shows in place of the saved state: what was typed, and what was wrong with it. */
interface Posted {
  name: string
  enabled: boolean
  values: Record<string, unknown>
  errors: Errors
}

const NO_REFS: AgentRefs = {
  document: () => null,
  media: () => ({ status: 'unknown' }),
  mediaUrl: () => '',
}

const CATEGORY = {
  analytics: 'admin.integrations.category.analytics',
  marketing: 'admin.integrations.category.marketing',
  functional: 'admin.integrations.category.functional',
} as const satisfies Record<ConsentCategory, string>

const isOptional = (schema: z.ZodType): boolean => schema._zod.optin === 'optional'

const fieldsOf = (shape: Record<string, z.ZodType>) =>
  Object.entries(shape).flatMap(([key, schema]) => {
    const meta = fieldMeta(schema)
    return meta?.admin === undefined ? [] : [{ key, meta, widget: meta.admin, optional: isOptional(schema) }]
  })

/** The validation issues of `e` by field key; anything else goes under `''`. */
function errorsOf(e: InlayError, keys: readonly string[]): Errors {
  const errors: Errors = {}
  const issues = e.details.issues ?? []
  if (issues.length === 0) (errors[''] ??= []).push(e.message)
  for (const issue of issues) {
    const at = issue.path[0]
    const key = typeof at === 'string' && keys.includes(at) ? at : ''
    ;(errors[key] ??= []).push(issue.message)
  }
  return errors
}

function FieldRow(props: { prefix: string; name: string; meta: FieldMeta; widget: AdminWidget; optional: boolean; value: unknown; errors: string[] }) {
  const { prefix, name, meta, widget, optional, value, errors } = props
  const id = `${prefix}-${name}`
  const ids: string[] = []
  if (meta.help !== undefined) ids.push(`${id}-help`)
  if (errors.length > 0) ids.push(`${id}-problem`)
  const control = widget.render({
    name,
    id,
    value,
    meta,
    optional,
    readOnly: false,
    describedBy: ids.length > 0 ? ids.join(' ') : undefined,
    invalid: errors.length > 0,
    refs: NO_REFS,
    locale: '',
  })
  const notes = (
    <>
      {meta.help !== undefined && (
        <p id={`${id}-help`} class="text-sm text-base-content/70">
          {meta.help}
        </p>
      )}
      {errors.length > 0 && (
        <ul id={`${id}-problem`} class="text-sm text-error">
          {errors.map((e) => (
            <li>{e}</li>
          ))}
        </ul>
      )}
    </>
  )
  const mark = optional ? <span class="ms-2 text-sm font-normal text-base-content/60">{t('admin.form.optional')}</span> : null
  if (widget.fieldset === true) {
    return (
      <fieldset class="fieldset" aria-describedby={ids.length > 0 ? ids.join(' ') : undefined}>
        <legend class="fieldset-legend">
          {meta.label}
          {mark}
        </legend>
        {notes}
        {control}
      </fieldset>
    )
  }
  if (meta.kind === 'boolean') {
    return (
      <div class="flex flex-col gap-1">
        <div class="flex items-center gap-2">
          {control}
          <label for={id}>
            {meta.label}
            {mark}
          </label>
        </div>
        {notes}
      </div>
    )
  }
  return (
    <div class="flex flex-col gap-1">
      <label for={id} class="text-sm font-medium">
        {meta.label}
        {mark}
      </label>
      {control}
      {notes}
    </div>
  )
}

function IntegrationForm({ state, posted }: { state: IntegrationState; posted: Posted | undefined }) {
  const { def } = state
  const name = def.name
  const enabled = posted?.enabled ?? state.enabled
  const values = posted?.values ?? state.values
  const errors = posted?.errors ?? {}
  const general = errors[''] ?? []
  const prefix = `integration-${name}`
  const unsafe = def.csp['script-src']?.includes("'unsafe-inline'") === true
  return (
    <form method="post" action={`/admin/integrations/${name}`} class="card bg-base-100 shadow-sm" aria-labelledby={`${prefix}-title`}>
      <div class="card-body flex flex-col gap-4">
        <h2 id={`${prefix}-title`} class="card-title">
          {def.label}
        </h2>
        {def.description !== undefined && <p>{def.description}</p>}
        <ul class="list-none text-sm">
          <li>{def.consent !== undefined ? t('admin.integrations.consent', { category: t(CATEGORY[def.consent]) }) : t('admin.integrations.always')}</li>
          {def.preview && <li>{t('admin.integrations.preview')}</li>}
          {unsafe && <li>{t('admin.integrations.unsafeInline')}</li>}
        </ul>
        {posted === undefined && state.enabled && !state.active && (
          <Alert kind="warning" id={`${prefix}-not-running`}>
            {t('admin.integrations.notRunning')}
          </Alert>
        )}
        {general.length > 0 && (
          <Alert kind="error" id={`${prefix}-error`}>
            {general.join(' ')}
          </Alert>
        )}
        <div class="flex items-center gap-3">
          <input id={`${prefix}-enabled`} type="checkbox" name="enabled" value="true" class="toggle" checked={enabled} />
          <label for={`${prefix}-enabled`}>{t('admin.integrations.on')}</label>
        </div>
        {fieldsOf(def.fields.shape).map(({ key, meta, widget, optional }) => (
          <FieldRow prefix={prefix} name={key} meta={meta} widget={widget} optional={optional} value={values[key]} errors={errors[key] ?? []} />
        ))}
        <div class="card-actions">
          <button type="submit" class="btn btn-primary">
            {t('admin.integrations.save')}
          </button>
        </div>
      </div>
    </form>
  )
}

/** The owner's Integrations screen: switch on the scripts the site's code defines and fill in their details. */
export function registerIntegrations(scope: FastifyInstance, ctx: AdminContext): void {
  const { core } = ctx
  const asCtx = (request: FastifyRequest): Ctx => ({ actor: adminActor(request), source: 'admin' })
  const defined = () => core.registry.site.integrations

  async function integrationsPage(request: FastifyRequest, reply: FastifyReply, status = 200, posted?: Posted) {
    const actor = adminActor(request)
    const states = await core.integrations(asCtx(request))
    const notice = noticeOf(request.query)
    const body = (
      <div class="flex flex-col gap-6">
        <Alert kind="info">{t('admin.integrations.public')}</Alert>
        {states.map((state) => (
          <IntegrationForm state={state} posted={posted?.name === state.def.name ? posted : undefined} />
        ))}
      </div>
    )
    const page = await adminPage(
      ctx,
      {
        title: t('admin.integrations.title'),
        actor,
        section: 'integrations',
        status,
        description: t('admin.integrations.description'),
        ...(notice !== undefined && { notice }),
      },
      body,
    )
    return reply.code(status).type(HTML).send(page)
  }

  scope.get('/admin/integrations', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    if (defined().length === 0) return notFound(reply, ctx, actor)
    return integrationsPage(request, reply)
  })

  scope.post<{ Params: { name: string } }>('/admin/integrations/:name', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    const { name } = request.params
    const def = defined().find((d) => d.name === name)
    if (def === undefined) return notFound(reply, ctx, actor)
    const form = formValues(request)
    const enabled = form.get('enabled') === 'true'
    const fields = fieldsOf(def.fields.shape)
    const values: Record<string, unknown> = {}
    for (const { key, meta, widget, optional } of fields) {
      const value = widget.parse(form, key, meta, optional)
      if (value !== undefined) values[key] = value
    }
    try {
      await core.saveIntegration(name, { enabled, values }, asCtx(request))
    } catch (e) {
      if (!(e instanceof InlayError)) throw e
      if (e.code === 'not_found') return notFound(reply, ctx, actor)
      if (e.code !== 'validation') throw e
      return integrationsPage(request, reply, 400, {
        name,
        enabled,
        values,
        errors: errorsOf(
          e,
          fields.map((x) => x.key),
        ),
      })
    }
    return reply.redirect('/admin/integrations?notice=integrationSaved', 303)
  })
}
