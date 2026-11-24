import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { renderSVG } from 'uqr'
import { AUTH_BASE_PATH } from '../../../core/auth/auth.js'
import { MIN_PASSWORD, type UserInfo, type UserRole } from '../../../core/auth/service.js'
import { InlayError } from '../../../core/errors.js'
import { t } from '../../../core/messages/index.js'
import type { Actor } from '../../../core/types.js'
import { raw } from '../../../jsx/html.js'
import { copyCookies, toWebRequest, webHeaders } from '../../web.js'
import { adminActor, formOf, forbidden, hostOf, HTML, noticeOf, notFound, type AdminContext } from '../context.js'
import { DataTable } from '../views/data-table.js'
import { Icon } from '../views/icons.js'
import { Alert, adminPage, Time } from '../views/layout.js'
import { Sheet } from '../views/sheet.js'
import { Badge } from '../views/status.js'

const ROLES: readonly UserRole[] = ['owner', 'editor']

const asRole = (value: string | undefined): UserRole | undefined => ROLES.find((r) => r === value)

const roleName = (role: UserRole | null): string => t(role === null ? 'admin.users.role.none' : `admin.users.role.${role}`)

/** Problems by field name; `''` holds those that belong to no field. */
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

/** A labeled input with its hint and problems tied to it. */
function Field(props: {
  id: string
  name: string
  label: string
  type?: string
  value?: string
  hint?: string
  errors?: string[] | undefined
  autocomplete?: string
  inputmode?: string
}) {
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
        type={props.type ?? 'text'}
        value={props.value}
        autocomplete={props.autocomplete}
        inputmode={props.inputmode}
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

/** A value to copy, such as the MCP address, in a read-only input with a hint below it. */
function ReadonlyField(props: { id: string; label: string; hint: string; value: string }) {
  return (
    <div class="flex flex-col gap-1">
      <label for={props.id} class="text-sm font-medium">
        {props.label}
      </label>
      <input
        id={props.id}
        type="text"
        readonly
        value={props.value}
        class="input input-bordered w-full font-mono"
        aria-describedby={`${props.id}-hint`}
        autocomplete="off"
      />
      <p id={`${props.id}-hint`} class="text-sm">
        {props.hint}
      </p>
    </div>
  )
}

/** The problems that belong to no field, if any. */
function General({ errors, id }: { errors: Errors; id: string }) {
  const general = errors[''] ?? []
  if (general.length === 0) return null
  return (
    <Alert kind="error" id={id}>
      <div>
        {general.map((message) => (
          <p>{message}</p>
        ))}
      </div>
    </Alert>
  )
}

const USER_FIELDS = ['name', 'email', 'password', 'confirm', 'role'] as const
const PASSWORD_FIELDS = ['current', 'password', 'confirm'] as const

/** An `otpauth://totp/` URI and the base32 key in it. */
interface AuthenticatorLink {
  uri: string
  key: string
}

/** Longer than any URI the two-step login plugin makes, so a posted value can't make an outsized QR code. */
const MAX_URI = 2048

/**
 * The setup form posts the URI back, so it is read as untrusted: only an `otpauth://totp/` URI with a base32
 * `secret` counts. Anything else gives `undefined`.
 */
function authenticatorLink(raw: string | undefined): AuthenticatorLink | undefined {
  if (raw === undefined || raw.length > MAX_URI || !raw.startsWith('otpauth://totp/')) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  const key = url.searchParams.get('secret')
  if (key === null || !/^[A-Z2-7]+=*$/i.test(key)) return undefined
  return { uri: raw, key: key.replace(/=+$/, '').toUpperCase() }
}

/** better-auth's JSON answer, or `null` when it isn't JSON. */
async function jsonOf(res: Response): Promise<unknown> {
  return res.headers.get('content-type')?.includes('application/json') ? await res.json() : null
}

/** The `code` of a better-auth error answer, such as the two-step login plugin's `INVALID_CODE`. */
function errorCodeIn(json: unknown): string | undefined {
  return typeof json === 'object' && json !== null && 'code' in json && typeof json.code === 'string' ? json.code : undefined
}

/** The `totpURI` of the plugin's answer to enable. */
function totpUriIn(json: unknown): string | undefined {
  return typeof json === 'object' && json !== null && 'totpURI' in json && typeof json.totpURI === 'string' ? json.totpURI : undefined
}

/**
 * The request's headers with its cookies updated by the `set-cookie`s of `res`, as the browser will send them next:
 * after the plugin replaces the session, these carry the new one.
 */
function headersAfter(request: FastifyRequest, res: Response): Headers {
  const jar = new Map<string, string>()
  for (const pair of (request.headers.cookie ?? '').split(';')) {
    const eq = pair.indexOf('=')
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
  for (const line of res.headers.getSetCookie()) {
    const [pair = '', ...attrs] = line.split(';')
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (value === '' || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) jar.delete(name)
    else jar.set(name, value)
  }
  const headers = webHeaders(request)
  headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
  return headers
}

/** The QR code of `uri`, drawn on the server as an inline SVG. */
function QrCode({ uri }: { uri: string }) {
  // The four-module white margin QR codes need to scan, also on the admin's dark theme.
  const svg = renderSVG(uri, { border: 4 })
  const viewBox = /viewBox="([^"]*)"/.exec(svg)?.[1]
  const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={viewBox}
      role="img"
      aria-label={t('admin.account.twoStep.qrAlt')}
      class="size-48 shrink-0 rounded-box border border-base-300"
    >
      {raw(inner)}
    </svg>
  )
}
/** The owner's Users screens and everyone's own account page. */
export function registerUsers(scope: FastifyInstance, ctx: AdminContext): void {
  const { service } = ctx
  const send = async (reply: FastifyReply, status: number, opts: Parameters<typeof adminPage>[1], body: Parameters<typeof adminPage>[2]) =>
    reply.code(status).type(HTML).send(await adminPage(ctx, { ...opts, status }, body))

  const idOf = (request: FastifyRequest): string => (request.params as { id: string }).id

  /** Answers a refused or missing user from the service with the matching page; rethrows anything else. */
  function refused(e: unknown, reply: FastifyReply, actor: Actor): Promise<FastifyReply> {
    if (e instanceof InlayError && e.code === 'forbidden') return forbidden(reply, ctx, actor)
    if (e instanceof InlayError && e.code === 'not_found') return notFound(reply, ctx, actor)
    throw e
  }

  // Users (owner only).

  async function listPage(request: FastifyRequest, reply: FastifyReply, status: number, values: Record<string, string> = {}, errors: Errors = {}) {
    const actor = adminActor(request)
    const users = await service.listUsers(actor)
    const role = asRole(values.role) ?? 'editor'
    const body = (
      <div class="flex flex-col gap-8">
        <DataTable
          id="users"
          caption={t('admin.users.table')}
          base="/admin/users"
          rows={users}
          rowKey={(user) => user.id}
          rowLabel={(user) => user.name}
          empty={t('admin.users.empty')}
          columns={[
            {
              key: 'name',
              label: t('admin.users.name'),
              cell: (user) => (
                <>
                  {user.name}
                  {user.id === actor.id && <span class="badge badge-primary badge-sm ml-2">{t('admin.users.you')}</span>}
                </>
              ),
            },
            { key: 'email', label: t('admin.users.email'), cell: (user) => user.email },
            {
              key: 'role',
              label: t('admin.users.role'),
              cell: (user) => (
                <>
                  {roleName(user.role)}
                  {user.banned && (
                    <Badge tone="warning" class="ml-2">
                      {t('admin.users.blocked')}
                    </Badge>
                  )}
                </>
              ),
            },
            {
              key: 'twoStep',
              label: t('admin.users.twoStep'),
              cell: (user) => user.twoStep && <Badge tone="success">{t('admin.account.twoStep.on')}</Badge>,
            },
            { key: 'added', label: t('admin.users.added'), cell: (user) => <Time iso={user.createdAt} relative /> },
            {
              key: 'manage',
              label: t('admin.users.manage'),
              hideLabel: true,
              cell: (user) => (
                <a
                  href={`/admin/users/${encodeURIComponent(user.id)}`}
                  class="btn btn-sm"
                  aria-label={t('admin.users.manageLabel', { name: user.name })}
                >
                  {t('admin.users.manage')}
                </a>
              ),
            },
          ]}
        />
        <Sheet
          id="add-user"
          title={t('admin.users.addHeading')}
          description={t('admin.users.addHint')}
          open={Object.keys(errors).length > 0}
          action="/admin/users"
          submit={t('admin.users.add')}
        >
          <General errors={errors} id="add-error" />
          <Field id="name" name="name" label={t('admin.users.name')} value={values.name ?? ''} errors={errors.name} autocomplete="off" />
          <Field id="email" name="email" type="email" label={t('admin.users.email')} value={values.email ?? ''} errors={errors.email} autocomplete="off" />
          <Field
            id="password"
            name="password"
            type="password"
            label={t('admin.users.password')}
            hint={t('admin.users.passwordHint', { min: MIN_PASSWORD })}
            errors={errors.password}
            autocomplete="new-password"
          />
          <Field id="confirm" name="confirm" type="password" label={t('admin.users.confirm')} errors={errors.confirm} autocomplete="new-password" />
          <RoleSelect id="role" role={role} errors={errors.role} hint={t('admin.users.roles')} />
        </Sheet>
      </div>
    )
    const notice = noticeOf(request.query)
    const actions = (
      <button type="button" class="btn btn-primary btn-sm" data-sheet-open="add-user">
        <Icon name="plus" />
        {t('admin.users.addHeading')}
      </button>
    )
    return send(
      reply,
      status,
      { title: t('admin.users.title'), description: t('admin.users.intro'), actions, actor, section: 'users', ...(notice !== undefined && { notice }) },
      body,
    )
  }

  function RoleSelect({ id, role, errors, hint }: { id: string; role: UserRole | null; errors?: string[] | undefined; hint?: string }) {
    const errorId = errors !== undefined && errors.length > 0 ? `${id}-error` : undefined
    const hintId = hint === undefined ? undefined : `${id}-hint`
    const described = [hintId, errorId].filter((x) => x !== undefined).join(' ')
    return (
      <div class="flex flex-col gap-1">
        <label for={id} class="text-sm font-medium">
          {t('admin.users.role')}
        </label>
        <select
          id={id}
          name="role"
          class="select select-bordered w-full max-w-md"
          aria-describedby={described === '' ? undefined : described}
          aria-invalid={errorId !== undefined ? 'true' : undefined}
        >
          {ROLES.map((r) => (
            <option value={r} selected={r === role}>
              {roleName(r)}
            </option>
          ))}
        </select>
        {hintId !== undefined && (
          <p id={hintId} class="text-sm">
            {hint}
          </p>
        )}
        {errorId !== undefined && (
          <p id={errorId} class="text-sm text-error">
            {(errors ?? []).join(' ')}
          </p>
        )}
      </div>
    )
  }

  /** The user `id` as the owner sees them, or `undefined` when there is none. */
  async function findUser(actor: Actor, id: string): Promise<UserInfo | undefined> {
    return (await service.listUsers(actor)).find((u) => u.id === id)
  }

  async function userPage(request: FastifyRequest, reply: FastifyReply, status: number, errors: Errors = {}) {
    const actor = adminActor(request)
    const user = await findUser(actor, idOf(request))
    if (!user) return notFound(reply, ctx, actor)
    const self = user.id === actor.id
    const base = `/admin/users/${encodeURIComponent(user.id)}`
    const body = (
      <div class="flex flex-col gap-8">
        <General errors={errors} id="user-error" />
        <dl class="grid max-w-md grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt class="font-medium">{t('admin.users.email')}</dt>
          <dd>{user.email}</dd>
          <dt class="font-medium">{t('admin.users.added')}</dt>
          <dd>
            <Time iso={user.createdAt} />
          </dd>
        </dl>
        <section aria-labelledby="role-heading" class="flex flex-col gap-4">
          <h2 id="role-heading" class="text-lg font-semibold">
            {t('admin.users.roleHeading')}
          </h2>
          <p>{t('admin.users.roles')}</p>
          <form method="post" action={`${base}/role`} class="flex flex-col gap-4">
            <RoleSelect id="role" role={user.role} />
            <div>
              <button type="submit" class="btn">
                {t('admin.users.saveRole')}
              </button>
            </div>
          </form>
        </section>
        <section aria-labelledby="password-heading" class="flex flex-col gap-4">
          <h2 id="password-heading" class="text-lg font-semibold">
            {t('admin.users.passwordHeading')}
          </h2>
          {self ? (
            <p>
              {t('admin.users.ownPassword')}{' '}
              <a href="/admin/account" class="link">
                {t('admin.nav.account')}
              </a>
            </p>
          ) : (
            <>
              <p>{t('admin.users.passwordIntro', { name: user.name })}</p>
              <form method="post" action={`${base}/password`} class="flex flex-col gap-4">
                <Field
                  id="password"
                  name="password"
                  type="password"
                  label={t('admin.users.newPassword')}
                  hint={t('admin.users.passwordHint', { min: MIN_PASSWORD })}
                  errors={errors.password}
                  autocomplete="new-password"
                />
                <Field id="confirm" name="confirm" type="password" label={t('admin.users.confirm')} errors={errors.confirm} autocomplete="new-password" />
                <div>
                  <button type="submit" class="btn">
                    {t('admin.users.setPassword')}
                  </button>
                </div>
              </form>
            </>
          )}
        </section>
        {!self && (
          <section aria-labelledby="remove-heading" class="flex flex-col gap-4">
            <h2 id="remove-heading" class="text-lg font-semibold">
              {t('admin.users.removeHeading')}
            </h2>
            <p>{t('admin.users.removeIntro', { name: user.name })}</p>
            <p>
              <a href={`${base}/remove`} class="btn btn-error btn-outline">
                {t('admin.users.remove')}
              </a>
            </p>
          </section>
        )}
      </div>
    )
    const notice = noticeOf(request.query)
    return send(
      reply,
      status,
      {
        title: user.name,
        actor,
        section: 'users',
        breadcrumbs: [{ label: t('admin.users.title'), href: '/admin/users' }],
        ...(notice !== undefined && { notice }),
      },
      body,
    )
  }

  scope.get('/admin/users', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    return listPage(request, reply, 200)
  })

  scope.post('/admin/users', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    const form = formOf(request)
    const values = { name: form.name ?? '', email: form.email ?? '', role: form.role ?? '' }
    const role = asRole(form.role)
    const password = form.password ?? ''
    if (role === undefined) return listPage(request, reply, 400, values, { role: [t('issue.required', { field: t('admin.users.role') })] })
    if (password !== (form.confirm ?? '')) return listPage(request, reply, 400, values, { confirm: [t('auth.passwordsDiffer')] })
    try {
      await service.addUser(actor, { name: values.name, email: values.email, password, role })
    } catch (e) {
      if (!(e instanceof InlayError) || e.code !== 'validation') return refused(e, reply, actor)
      return listPage(request, reply, 400, values, errorsOf(e, USER_FIELDS))
    }
    return reply.redirect('/admin/users?notice=userAdded', 303)
  })

  scope.get('/admin/users/:id', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    return userPage(request, reply, 200)
  })

  scope.post('/admin/users/:id/role', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    const id = idOf(request)
    const role = asRole(formOf(request).role)
    if (role === undefined) return userPage(request, reply, 400, { '': [t('issue.required', { field: t('admin.users.role') })] })
    try {
      await service.setRole(actor, id, role)
    } catch (e) {
      if (!(e instanceof InlayError) || e.code !== 'invalid_operation') return refused(e, reply, actor)
      return userPage(request, reply, 400, { '': [e.message] })
    }
    // Owners who made themselves editors can't see the Users screen any more.
    if (id === actor.id && role !== 'owner') return reply.redirect('/admin?notice=userUpdated', 303)
    return reply.redirect(`/admin/users/${encodeURIComponent(id)}?notice=userUpdated`, 303)
  })

  scope.post('/admin/users/:id/password', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    const id = idOf(request)
    const form = formOf(request)
    const password = form.password ?? ''
    if (password !== (form.confirm ?? '')) return userPage(request, reply, 400, { confirm: [t('auth.passwordsDiffer')] })
    try {
      await service.setPassword(actor, id, password)
    } catch (e) {
      if (!(e instanceof InlayError) || e.code !== 'validation') return refused(e, reply, actor)
      return userPage(request, reply, 400, errorsOf(e, ['password']))
    }
    return reply.redirect(`/admin/users/${encodeURIComponent(id)}?notice=userUpdated`, 303)
  })

  scope.get('/admin/users/:id/remove', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    const user = await findUser(actor, idOf(request))
    if (!user) return notFound(reply, ctx, actor)
    const base = `/admin/users/${encodeURIComponent(user.id)}`
    const body = (
      <div class="flex flex-col gap-4">
        <p>{t('admin.users.removeIntro', { name: user.name })}</p>
        <form method="post" action={`${base}/remove`} class="flex flex-wrap gap-4">
          <button type="submit" class="btn btn-error">
            {t('admin.users.removeConfirm', { name: user.name })}
          </button>
          <a href={base} class="btn">
            {t('admin.users.cancel')}
          </a>
        </form>
      </div>
    )
    return send(
      reply,
      200,
      {
        title: t('admin.users.removeTitle', { name: user.name }),
        actor,
        section: 'users',
        breadcrumbs: [
          { label: t('admin.users.title'), href: '/admin/users' },
          { label: user.name, href: base },
        ],
      },
      body,
    )
  })

  scope.post('/admin/users/:id/remove', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    try {
      await service.removeUser(actor, idOf(request))
    } catch (e) {
      if (!(e instanceof InlayError) || e.code !== 'invalid_operation') return refused(e, reply, actor)
      return userPage(request, reply, 400, { '': [e.message] })
    }
    return reply.redirect('/admin/users?notice=userRemoved', 303)
  })

  // Your account (everyone).

  interface AccountState {
    password?: Errors
    keyName?: { value: string; push: boolean; errors: Errors }
    /** `setup` holds the link being set up, shown until its code is confirmed; `errors` by field (`password`, `code`). */
    twoStep?: { setup?: AuthenticatorLink; errors?: Errors }
  }

  /** The two-step login section: Off with the password to set it up, the QR code and key while setting up, or On. */
  function TwoStepSection({ on, state }: { on: boolean; state: NonNullable<AccountState['twoStep']> }) {
    const errors = state.errors ?? {}
    const setup = on ? undefined : state.setup
    const passwordField = (
      <Field
        id="two-step-password"
        name="password"
        type="password"
        label={t('admin.account.twoStep.password')}
        errors={errors.password}
        autocomplete="current-password"
      />
    )
    return (
      <section aria-labelledby="two-step-heading" class="flex flex-col gap-4">
        <div class="flex items-center gap-3">
          <h2 id="two-step-heading" class="text-lg font-semibold">
            {t('admin.account.twoStep.heading')}
          </h2>
          <span data-two-step-state>
            <Badge tone={on ? 'success' : 'ghost'}>{t(on ? 'admin.account.twoStep.on' : 'admin.account.twoStep.off')}</Badge>
          </span>
        </div>
        <General errors={errors} id="two-step-error-all" />
        {on ? (
          <>
            <p>{t('admin.account.twoStep.onIntro')}</p>
            <form method="post" action="/admin/account/two-step/off" class="flex flex-col gap-4">
              {passwordField}
              <div>
                <button type="submit" class="btn">
                  {t('admin.account.twoStep.turnOff')}
                </button>
              </div>
            </form>
          </>
        ) : setup !== undefined ? (
          <>
            <p>{t('admin.account.twoStep.scan')}</p>
            <div class="flex flex-wrap items-start gap-6">
              <QrCode uri={setup.uri} />
              <div class="flex max-w-xs flex-col gap-2">
                <p>{t('admin.account.twoStep.key')}</p>
                <code id="two-step-key" class="font-mono break-words">
                  {(setup.key.match(/.{1,4}/g) ?? []).join(' ')}
                </code>
              </div>
            </div>
            <p>{t('admin.account.twoStep.enterCode')}</p>
            <form method="post" action="/admin/account/two-step/confirm" class="flex flex-col gap-4">
              <input type="hidden" name="uri" value={setup.uri} />
              <Field
                id="two-step-code"
                name="code"
                label={t('auth.code.label')}
                errors={errors.code}
                autocomplete="one-time-code"
                inputmode="numeric"
              />
              <div class="flex flex-wrap items-center gap-4">
                <button type="submit" class="btn">
                  {t('admin.account.twoStep.turnOn')}
                </button>
                <a href="/admin/account" class="link">
                  {t('admin.account.twoStep.cancel')}
                </a>
              </div>
            </form>
          </>
        ) : (
          <>
            <p>{t('admin.account.twoStep.offIntro')}</p>
            <form method="post" action="/admin/account/two-step/setup" class="flex flex-col gap-4">
              {passwordField}
              <div>
                <button type="submit" class="btn">
                  {t('admin.account.twoStep.setUp')}
                </button>
              </div>
            </form>
          </>
        )}
        <p class="text-sm">{t('admin.account.twoStep.keysNote')}</p>
      </section>
    )
  }

  async function accountPage(request: FastifyRequest, reply: FastifyReply, status: number, state: AccountState = {}) {
    const actor = adminActor(request)
    if (actor.id === null) return forbidden(reply, ctx, actor)
    const keys = await service.listApiKeys(actor.id)
    const assistants = await service.listAssistants(actor.id)
    const twoStepOn = await service.twoStepOn(actor.id)
    const passwordErrors = state.password ?? {}
    const keyErrors = state.keyName?.errors ?? {}
    const body = (
      <div class="flex flex-col gap-8">
        <section aria-labelledby="password-heading" class="flex flex-col gap-4">
          <h2 id="password-heading" class="text-lg font-semibold">
            {t('admin.account.passwordHeading')}
          </h2>
          <p>{t('admin.account.passwordIntro')}</p>
          <General errors={passwordErrors} id="password-error-all" />
          <form method="post" action="/admin/account/password" class="flex flex-col gap-4">
            <Field
              id="current"
              name="current"
              type="password"
              label={t('label.user.currentPassword')}
              errors={passwordErrors.current}
              autocomplete="current-password"
            />
            <Field
              id="password"
              name="password"
              type="password"
              label={t('admin.account.newPassword')}
              hint={t('admin.users.passwordHint', { min: MIN_PASSWORD })}
              errors={passwordErrors.password}
              autocomplete="new-password"
            />
            <Field
              id="confirm"
              name="confirm"
              type="password"
              label={t('admin.account.confirm')}
              errors={passwordErrors.confirm}
              autocomplete="new-password"
            />
            <div>
              <button type="submit" class="btn">
                {t('admin.account.changePassword')}
              </button>
            </div>
          </form>
        </section>
        <TwoStepSection on={twoStepOn} state={state.twoStep ?? {}} />
        <section aria-labelledby="assistants-heading" class="flex flex-col gap-4">
          <h2 id="assistants-heading" class="text-lg font-semibold">
            {t('admin.account.assistantsHeading')}
          </h2>
          <p>{t('admin.account.assistantsIntro')}</p>
          <ReadonlyField id="mcp-url" label={t('admin.account.mcpUrl')} hint={t('admin.account.mcpUrlHint')} value={service.resource} />
          <ReadonlyField
            id="mcp-command"
            label={t('admin.account.mcpCommand')}
            hint={t('admin.account.mcpCommandHint')}
            value={`claude mcp add --transport http inlay ${service.resource}`}
          />
          <p>{t('admin.account.connectSteps')}</p>
          {assistants.length === 0 ? (
            <p>{t('admin.account.noAssistants')}</p>
          ) : (
            <>
              <DataTable
                id="assistants"
                caption={t('admin.account.assistantsTable')}
                base="/admin/account"
                rows={assistants}
                rowKey={(assistant) => assistant.clientId}
                rowLabel={(assistant) => assistant.name}
                empty={t('admin.account.noAssistants')}
                columns={[
                  { key: 'name', label: t('admin.account.assistantName'), cell: (assistant) => assistant.name },
                  {
                    key: 'returnsTo',
                    label: t('admin.account.assistantReturnsTo'),
                    cell: (assistant) => [...new Set(assistant.redirectUris.map(hostOf).filter((h) => h !== undefined))].join(', '),
                  },
                  {
                    key: 'connected',
                    label: t('admin.account.assistantConnected'),
                    cell: (assistant) => <Time iso={assistant.connectedAt} relative />,
                  },
                ]}
              />
              <p class="text-sm">{t('admin.account.assistantsNote')}</p>
            </>
          )}
        </section>
        <section aria-labelledby="keys-heading" class="flex flex-col gap-4">
          <div class="flex items-center justify-between gap-4">
            <h2 id="keys-heading" class="text-lg font-semibold">
              {t('admin.account.keysHeading')}
            </h2>
            <button type="button" class="btn btn-sm" data-sheet-open="create-key">
              <Icon name="plus" />
              {t('admin.account.createHeading')}
            </button>
          </div>
          <p>{t('admin.account.keysIntro')}</p>
          {keys.length === 0 ? (
            <p>{t('admin.account.noKeys')}</p>
          ) : (
            <DataTable
              id="api-keys"
              caption={t('admin.account.keysTable')}
              base="/admin/account"
              rows={keys}
              rowKey={(key) => key.id}
              rowLabel={(key) => key.name}
              empty={t('admin.account.noKeys')}
              columns={[
                { key: 'name', label: t('admin.account.keyName'), cell: (key) => key.name },
                {
                  key: 'start',
                  label: t('admin.account.keyStart'),
                  cell: (key) => key.start !== null && <code>{t('admin.account.keyStartValue', { start: key.start })}</code>,
                },
                { key: 'created', label: t('admin.account.keyCreated'), cell: (key) => <Time iso={key.createdAt} relative /> },
                {
                  key: 'lastUsed',
                  label: t('admin.account.keyLastUsed'),
                  cell: (key) => (key.lastUsedAt !== null ? <Time iso={key.lastUsedAt} relative /> : t('admin.account.keyNeverUsed')),
                },
                {
                  key: 'revoke',
                  label: t('admin.account.revoke'),
                  hideLabel: true,
                  cell: (key) => (
                    <form method="post" action={`/admin/account/keys/${encodeURIComponent(key.id)}/delete`}>
                      <button type="submit" class="btn btn-error btn-outline btn-sm" aria-label={t('admin.account.revokeLabel', { name: key.name })}>
                        {t('admin.account.revoke')}
                      </button>
                    </form>
                  ),
                },
              ]}
            />
          )}
        </section>
        <Sheet
          id="create-key"
          title={t('admin.account.createHeading')}
          open={state.keyName !== undefined}
          action="/admin/account/keys"
          submit={t('admin.account.create')}
        >
          <General errors={keyErrors} id="key-error-all" />
          <Field
            id="key-name"
            name="name"
            label={t('admin.account.keyName')}
            value={state.keyName?.value ?? ''}
            hint={t('admin.account.keyNameHint')}
            errors={keyErrors.keyName}
            autocomplete="off"
          />
          {actor.role === 'owner' && (
            <div class="flex flex-col gap-1">
              <div class="flex items-center gap-3">
                <input id="key-push" type="checkbox" name="push" class="checkbox" checked={state.keyName?.push ?? false} aria-describedby="key-push-hint" />
                <label for="key-push">{t('admin.account.keyPush')}</label>
              </div>
              <p id="key-push-hint" class="text-sm">
                {t('admin.account.keyPushHint')}
              </p>
            </div>
          )}
        </Sheet>
      </div>
    )
    const notice = noticeOf(request.query)
    return send(
      reply,
      status,
      {
        title: t('admin.account.title'),
        description: t('admin.signedInAs', { name: actor.name, role: t(actor.role === 'owner' ? 'role.owner' : 'role.editor') }),
        actor,
        section: 'account',
        ...(notice !== undefined && { notice }),
      },
      body,
    )
  }

  scope.get('/admin/account', (request, reply) => accountPage(request, reply, 200))

  scope.post('/admin/account/password', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.id === null) return forbidden(reply, ctx, actor)
    const form = formOf(request)
    const password = form.password ?? ''
    if (password !== (form.confirm ?? '')) return accountPage(request, reply, 400, { password: { confirm: [t('auth.passwordsDiffer')] } })
    try {
      await service.changePassword(actor.id, form.current ?? '', password, webHeaders(request))
    } catch (e) {
      if (!(e instanceof InlayError) || e.code !== 'validation') throw e
      return accountPage(request, reply, 400, { password: errorsOf(e, PASSWORD_FIELDS) })
    }
    return reply.redirect('/admin/account?notice=passwordChanged', 303)
  })

  /** Sends `body` to the two-step login plugin's `endpoint` as the signed-in user, with the request's cookies. */
  const twoFactor = (request: FastifyRequest, endpoint: 'enable' | 'verify-totp' | 'disable', body: Record<string, string>) =>
    service.auth.handler(
      toWebRequest(request, ctx.baseUrl, {
        path: `${AUTH_BASE_PATH}/two-factor/${endpoint}`,
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', accept: 'application/json' },
      }),
    )

  /** An answer from the plugin none of the forms expects: logged, then the admin's error page. */
  function unexpected(request: FastifyRequest, res: Response, json: unknown): never {
    request.log.error({ status: res.status, code: errorCodeIn(json) }, 'two-step login: unexpected answer')
    throw new InlayError('invalid_operation', 'admin.error')
  }

  const wrongPassword = () => [t('issue.wrongPassword', { field: t('admin.account.twoStep.password') })]
  const tooManyAttempts = () => ({ '': [t('auth.tooManyAttempts')] })

  scope.post('/admin/account/two-step/setup', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.id === null) return forbidden(reply, ctx, actor)
    const res = await twoFactor(request, 'enable', { password: formOf(request).password ?? '' })
    const json = await jsonOf(res)
    copyCookies(reply, res)
    if (res.status === 429) return accountPage(request, reply, 429, { twoStep: { errors: tooManyAttempts() } })
    if (res.ok) {
      const setup = authenticatorLink(totpUriIn(json))
      if (setup === undefined) return unexpected(request, res, json)
      // The page itself, not a redirect, so the key is never in a URL.
      return accountPage(request, reply, 200, { twoStep: { setup } })
    }
    const code = errorCodeIn(json)
    if (code === 'INVALID_PASSWORD') return accountPage(request, reply, 400, { twoStep: { errors: { password: wrongPassword() } } })
    if (code === 'TOTP_ALREADY_ENABLED') return reply.redirect('/admin/account', 303)
    return unexpected(request, res, json)
  })

  scope.post('/admin/account/two-step/confirm', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.id === null) return forbidden(reply, ctx, actor)
    const form = formOf(request)
    const setup = authenticatorLink(form.uri)
    if (setup === undefined) return accountPage(request, reply, 400)
    const res = await twoFactor(request, 'verify-totp', { code: (form.code ?? '').replace(/\s/g, '') })
    const json = await jsonOf(res)
    copyCookies(reply, res)
    if (res.status === 429) return accountPage(request, reply, 429, { twoStep: { setup, errors: tooManyAttempts() } })
    if (res.ok) {
      // Confirming replaced the session: the one to keep is the new one the browser was just given.
      await service.endOtherSessions(actor.id, headersAfter(request, res))
      return reply.redirect('/admin/account?notice=twoStepOn', 303)
    }
    const code = errorCodeIn(json)
    if (code === 'INVALID_CODE') return accountPage(request, reply, 400, { twoStep: { setup, errors: { code: [t('auth.code.wrong')] } } })
    // No key waiting to be confirmed (it was never set up, or was turned off since): start again.
    if (code === 'TOTP_NOT_ENABLED') return accountPage(request, reply, 400)
    return unexpected(request, res, json)
  })

  scope.post('/admin/account/two-step/off', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.id === null) return forbidden(reply, ctx, actor)
    const res = await twoFactor(request, 'disable', { password: formOf(request).password ?? '' })
    const json = await jsonOf(res)
    copyCookies(reply, res)
    if (res.status === 429) return accountPage(request, reply, 429, { twoStep: { errors: tooManyAttempts() } })
    if (res.ok) return reply.redirect('/admin/account?notice=twoStepOff', 303)
    if (errorCodeIn(json) === 'INVALID_PASSWORD') return accountPage(request, reply, 400, { twoStep: { errors: { password: wrongPassword() } } })
    return unexpected(request, res, json)
  })

  scope.post('/admin/account/keys', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.id === null) return forbidden(reply, ctx, actor)
    const form = formOf(request)
    const name = form.name ?? ''
    // Only owners see the choice; a `push` an editor sends anyway is ignored.
    const push = actor.role === 'owner' && form.push !== undefined
    let key: string
    try {
      key = await service.createApiKey(actor.id, name, push ? { permissions: { release: ['push'] } } : {})
    } catch (e) {
      if (!(e instanceof InlayError) || e.code !== 'validation') throw e
      return accountPage(request, reply, 400, { keyName: { value: name, push, errors: errorsOf(e, ['keyName']) } })
    }
    const body = (
      <div class="flex flex-col gap-4">
        <Alert kind="warning" id="key-once">
          <p>{t('admin.account.keyOnce')}</p>
        </Alert>
        <div class="flex flex-col gap-1">
          <label for="key" class="text-sm font-medium">
            {t('admin.account.key')}
          </label>
          <input id="key" type="text" readonly value={key} class="input input-bordered w-full font-mono" aria-describedby="key-once" autocomplete="off" />
        </div>
        <p>
          <a href="/admin/account" class="btn">
            {t('admin.account.back')}
          </a>
        </p>
      </div>
    )
    return send(
      reply,
      200,
      {
        title: t('admin.account.keyCreatedTitle'),
        actor,
        section: 'account',
        breadcrumbs: [{ label: t('admin.account.title'), href: '/admin/account' }],
      },
      body,
    )
  })

  scope.post('/admin/account/keys/:id/delete', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.id === null) return forbidden(reply, ctx, actor)
    try {
      await service.deleteApiKey(actor.id, idOf(request))
    } catch (e) {
      return refused(e, reply, actor)
    }
    return reply.redirect('/admin/account?notice=keyRevoked', 303)
  })
}
