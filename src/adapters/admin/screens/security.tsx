import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { InlayError } from '../../../core/errors.js'
import { t } from '../../../core/messages/index.js'
import type { Ctx } from '../../../core/types.js'
import { adminActor, forbidden, formOf, HTML, noticeOf, type AdminContext } from '../context.js'
import { Alert, adminPage } from '../views/layout.js'

type Errors = Record<string, string[]>

/** The validation issues of `e` by field, keeping only `fields`; anything else goes under `''`. */
function errorsOf(e: InlayError, fields: readonly string[]): Errors {
  const errors: Errors = {}
  const issues = e.details.issues ?? []
  if (issues.length === 0) (errors[''] ??= []).push(e.message)
  for (const issue of issues) {
    const at = issue.path[0]
    const key = typeof at === 'string' && fields.includes(at) ? at : ''
    ;(errors[key] ??= []).push(issue.message)
  }
  return errors
}

function Field(props: { id: string; name: string; label: string; hint?: string; errors?: string[] | undefined }) {
  const errors = props.errors ?? []
  const hintId = props.hint !== undefined ? `${props.id}-hint` : undefined
  const errorId = errors.length > 0 ? `${props.id}-error` : undefined
  const described = [hintId, errorId].filter((id) => id !== undefined).join(' ')
  return (
    <div class="flex flex-col gap-1">
      <label for={props.id} class="text-sm font-medium">
        {props.label}
      </label>
      <input
        id={props.id}
        name={props.name}
        type="password"
        autocomplete="new-password"
        class="input input-bordered w-full max-w-md"
        aria-describedby={described === '' ? undefined : described}
        aria-invalid={errors.length > 0 ? 'true' : undefined}
      />
      {hintId !== undefined && (
        <p id={hintId} class="text-sm">
          {props.hint}
        </p>
      )}
      {errorId !== undefined && (
        <p id={errorId} class="text-sm text-error">
          {errors.join(' ')}
        </p>
      )}
    </div>
  )
}

/** The owner's Security screen: whether the site needs a password, and which one. */
export function registerSecurity(scope: FastifyInstance, ctx: AdminContext): void {
  const { core } = ctx
  const asCtx = (request: FastifyRequest): Ctx => ({ actor: adminActor(request), source: 'admin' })

  async function securityPage(request: FastifyRequest, reply: FastifyReply, status = 200, errors: Errors = {}) {
    const actor = adminActor(request)
    const lock = await core.siteLock()
    const notice = noticeOf(request.query)
    const general = errors[''] ?? []
    const body = (
      <div class="flex flex-col gap-6">
        {general.length > 0 && (
          <Alert kind="error" id="security-error">
            {general.join(' ')}
          </Alert>
        )}
        <p id="security-status">{lock.enabled ? t('admin.security.statusOn') : t('admin.security.statusOff')}</p>
        <form method="post" action="/admin/security/lock" class="flex flex-wrap items-center gap-4">
          <div class="flex items-center gap-3">
            <input id="site-lock-enabled" type="checkbox" name="enabled" class="toggle" checked={lock.enabled} />
            <label for="site-lock-enabled">{t('admin.security.require')}</label>
          </div>
          <button type="submit" class="btn btn-primary btn-sm">
            {t('admin.security.saveLock')}
          </button>
          {!lock.hasPassword && <p class="text-sm">{t('admin.security.noPassword')}</p>}
        </form>
        <form method="post" action="/admin/security/password" class="flex flex-col gap-4">
          {lock.hasPassword && <p>{t('admin.security.passwordSet')}</p>}
          <Field id="site-password" name="password" label={t('label.sitePassword')} hint={t('admin.security.changeHint')} errors={errors.password} />
          <Field id="site-password-confirm" name="confirm" label={t('admin.security.confirm')} errors={errors.confirm} />
          <div>
            <button type="submit" class="btn btn-primary">
              {t('admin.security.savePassword')}
            </button>
          </div>
        </form>
        <Alert kind="info">{t('admin.security.cdnNote')}</Alert>
      </div>
    )
    const page = await adminPage(
      ctx,
      {
        title: t('admin.security.title'),
        actor,
        section: 'security',
        status,
        description: t('admin.security.description'),
        ...(notice !== undefined && { notice }),
      },
      body,
    )
    return reply.code(status).type(HTML).send(page)
  }

  scope.get('/admin/security', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    return securityPage(request, reply)
  })

  scope.post('/admin/security/lock', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    const enabled = formOf(request).enabled === 'on'
    try {
      await core.setSiteLock(enabled, asCtx(request))
    } catch (e) {
      if (!(e instanceof InlayError) || e.messageId !== 'error.sitePasswordMissing') throw e
      return securityPage(request, reply, 400, { '': [e.message] })
    }
    return reply.redirect(`/admin/security?notice=${enabled ? 'siteLocked' : 'siteUnlocked'}`, 303)
  })

  scope.post('/admin/security/password', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    const form = formOf(request)
    const password = form.password ?? ''
    if (password !== (form.confirm ?? '')) return securityPage(request, reply, 400, { confirm: [t('auth.passwordsDiffer')] })
    try {
      await core.setSitePassword(password, asCtx(request))
    } catch (e) {
      if (!(e instanceof InlayError) || e.code !== 'validation') throw e
      return securityPage(request, reply, 400, errorsOf(e, ['password']))
    }
    return reply.redirect('/admin/security?notice=sitePasswordSaved', 303)
  })
}
