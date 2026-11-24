import { t, type MessageId } from '../../core/messages/index.js'
import type { Actor } from '../../core/types.js'
import { html, type SafeHtml } from '../../jsx/html.js'
import type { AdminContext } from './context.js'
import { adminPage, Alert, authPage } from './views/layout.js'

export type SetupField = 'name' | 'email' | 'password' | 'confirm'

interface FieldOptions {
  id: string
  label: string
  type: 'text' | 'email' | 'password'
  autocomplete: string
  value?: string
  hint?: string
  errors?: string[]
  inputmode?: 'numeric'
  autofocus?: boolean
}

/** A labeled input, with its hint and problems tied to it through `aria-describedby`. */
function field(opts: FieldOptions): SafeHtml {
  const errors = opts.errors ?? []
  const hintId = `${opts.id}-hint`
  const errorId = `${opts.id}-error`
  const describedBy = [opts.hint !== undefined ? hintId : null, errors.length > 0 ? errorId : null].filter((x) => x !== null)
  return html`<div class="flex flex-col gap-1"><label for="${opts.id}" class="font-medium">${opts.label}</label>${
    opts.hint !== undefined ? html`<p class="text-sm" id="${hintId}">${opts.hint}</p>` : ''
  }${errors.length > 0 ? html`<p class="text-sm text-error" id="${errorId}">${errors.join(' ')}</p>` : ''}<input id="${opts.id}" name="${opts.id}" type="${opts.type}" autocomplete="${opts.autocomplete}"${
    opts.inputmode !== undefined ? html` inputmode="${opts.inputmode}"` : ''
  }${opts.autofocus === true ? html` autofocus` : ''}${
    opts.value !== undefined ? html` value="${opts.value}"` : ''
  } class="input w-full" required${describedBy.length > 0 ? html` aria-describedby="${describedBy.join(' ')}"` : ''}${
    errors.length > 0 ? html` aria-invalid="true"` : ''
  }></div>`
}

const alert = (message: string | undefined) => (message === undefined ? '' : Alert({ kind: 'error', children: message }))

/** First run: the form that creates the owner account. */
export function setupPage(
  ctx: AdminContext,
  opts: {
    values?: { name?: string; email?: string }
    errors?: Partial<Record<SetupField, string[]>>
  },
): Promise<string> {
  const errors = opts.errors ?? {}
  const problems = Object.values(errors).some((list) => list.length > 0)
  const body = html`<p>${t('auth.setup.intro')}</p>${alert(problems ? t('auth.formProblems') : undefined)}<form method="post" action="/admin/setup" class="flex flex-col gap-4">${[
    field({ id: 'name', label: t('label.user.name'), type: 'text', autocomplete: 'name', value: opts.values?.name ?? '', errors: errors.name ?? [] }),
    field({ id: 'email', label: t('label.user.email'), type: 'email', autocomplete: 'email', value: opts.values?.email ?? '', errors: errors.email ?? [] }),
    field({ id: 'password', label: t('label.user.password'), type: 'password', autocomplete: 'new-password', hint: t('auth.passwordHint'), errors: errors.password ?? [] }),
    field({ id: 'confirm', label: t('auth.passwordConfirm'), type: 'password', autocomplete: 'new-password', errors: errors.confirm ?? [] }),
  ]}<button type="submit" class="btn btn-primary">${t('auth.setup.submit')}</button></form>`
  return authPage(ctx, t('auth.setup.title'), body)
}

/** The login form. `oauthQuery` carries a signed OAuth authorize request through the login. */
export function loginPage(
  ctx: AdminContext,
  opts: { email?: string; next: string; oauthQuery?: string; error?: string },
): Promise<string> {
  const body = html`${alert(opts.error)}<form method="post" action="/admin/login" class="flex flex-col gap-4"><input type="hidden" name="next" value="${opts.next}">${
    opts.oauthQuery !== undefined ? html`<input type="hidden" name="oauth_query" value="${opts.oauthQuery}">` : ''
  }${[
    field({ id: 'email', label: t('label.user.email'), type: 'email', autocomplete: 'username', value: opts.email ?? '' }),
    field({ id: 'password', label: t('label.user.password'), type: 'password', autocomplete: 'current-password' }),
  ]}<button type="submit" class="btn btn-primary">${t('auth.login.submit')}</button></form>`
  return authPage(ctx, t('auth.login.title'), body)
}

/**
 * The second step of logging in, for a user with two-step login on: the code from their authenticator app. `next`
 * and `oauthQuery` carry on from the login form.
 */
export function codePage(ctx: AdminContext, opts: { next: string; oauthQuery?: string; error?: string }): Promise<string> {
  const back = opts.oauthQuery !== undefined ? `/admin/login?${opts.oauthQuery}` : `/admin/login?${new URLSearchParams({ next: opts.next }).toString()}`
  const body = html`<p>${t('auth.code.intro')}</p>${alert(opts.error)}<form method="post" action="/admin/login/code" class="flex flex-col gap-4"><input type="hidden" name="next" value="${opts.next}">${
    opts.oauthQuery !== undefined ? html`<input type="hidden" name="oauth_query" value="${opts.oauthQuery}">` : ''
  }${field({ id: 'code', label: t('auth.code.label'), type: 'text', autocomplete: 'one-time-code', inputmode: 'numeric', autofocus: true })}<button type="submit" class="btn btn-primary">${t(
    'auth.code.submit',
  )}</button></form><p class="text-sm">${t('auth.code.lostPhone')}</p><p><a href="${back}" class="link">${t('auth.code.back')}</a></p>`
  return authPage(ctx, t('auth.code.title'), body)
}

/** `/admin` until the dashboard: who is signed in and a link to the publish page. The navigation has the logout button. */
export function adminHomePage(ctx: AdminContext, actor: Actor): Promise<string> {
  const role = actor.role === 'owner' ? t('role.owner') : t('role.editor')
  const body = html`<div class="flex flex-col gap-4"><p>${t('admin.signedInAs', { name: actor.name, role })}</p><p>${t(
    'admin.comingSoon',
  )}</p><p><a href="/admin/publish" data-publish-dialog class="link">${t('admin.publishLink')}</a></p></div>`
  return adminPage(ctx, { title: t('admin.nav.dashboard'), actor, section: 'dashboard' }, body)
}

const SCOPES = {
  openid: 'auth.consent.scope.openid',
  profile: 'auth.consent.scope.profile',
  email: 'auth.consent.scope.email',
  offline_access: 'auth.consent.scope.offline_access',
} as const satisfies Record<string, MessageId>

const scopeText = (scope: string) =>
  Object.hasOwn(SCOPES, scope) ? t(SCOPES[scope as keyof typeof SCOPES]) : t('auth.consent.scope.other', { scope })

/**
 * Asks the signed-in user whether `client` may use their account. It names the client and the host it sends the
 * user back to, since anyone can register a client under any name.
 */
export function consentPage(ctx: AdminContext, opts: {
  client: string
  host: string
  /** Every place the client registered to send users back to, so a second, unexpected one can't hide. */
  hosts: string[]
  name: string
  scopes: string[]
  oauthQuery: string
}): Promise<string> {
  const { client } = opts
  const scopes = opts.scopes.length > 0 ? html`<p>${t('auth.consent.scopes')}</p><ul>${opts.scopes.map((s) => html`<li>${scopeText(s)}</li>`)}</ul>` : ''
  const hosts = html`<p>${t('auth.consent.hosts', { client, hosts: opts.hosts.join(', ') })}</p>${
    opts.hosts.length > 1 ? Alert({ kind: 'error', children: t('auth.consent.manyHosts', { client }) }) : ''
  }`
  const body = html`<p>${t('auth.consent.intro', { client, name: opts.name })}</p>${scopes}<p><strong>${t('auth.consent.redirect', {
    host: opts.host,
  })}</strong></p>${hosts}<form method="post" action="/admin/consent" class="flex gap-2"><input type="hidden" name="oauth_query" value="${opts.oauthQuery}"><button type="submit" name="accept" value="true" class="btn btn-primary">${t(
    'auth.consent.allow',
  )}</button> <button type="submit" name="accept" value="false" class="btn">${t('auth.consent.deny')}</button></form>`
  return authPage(ctx, t('auth.consent.title', { client }), body)
}

/** A POST whose `Origin` isn't the site's. */
export function badOriginPage(ctx: AdminContext): Promise<string> {
  return authPage(ctx, t('auth.badOrigin.title'), html`<p>${t('auth.badOrigin')}</p>`)
}

/** A page with a catalog title and one catalog paragraph, such as a failed consent or an unexpected error. */
export function messagePage(ctx: AdminContext, titleId: MessageId, bodyId: MessageId): Promise<string> {
  return authPage(ctx, t(titleId), html`<p>${t(bodyId)}</p>`)
}
