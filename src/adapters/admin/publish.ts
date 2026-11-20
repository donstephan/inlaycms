import type { FastifyInstance, FastifyReply } from 'fastify'
import { InlayError } from '../../core/errors.js'
import { encodePath, presentHref } from '../../core/site/paths.js'
import { t } from '../../core/messages/index.js'
import type { Actor, ContentIssue, Ctx, DocumentSummary } from '../../core/types.js'
import { html, type SafeHtml } from '../../jsx/html.js'
import { adminActor, formOf, HTML, type AdminContext } from './context.js'
import { adminPage, Alert } from './views/layout.js'
import { badgeClass } from './views/status.js'

const PUBLISH_PATH = '/admin/publish'

type Action = 'publish' | 'unpublish'

const COPY = {
  publish: {
    title: 'admin.publish.title',
    intro: 'admin.publish.intro',
    submit: 'admin.publish.submit',
    nothing: 'admin.publish.nothing',
    busy: 'admin.publish.busy',
    doneTitle: 'admin.publish.done.title',
    done: 'admin.publish.done',
  },
  unpublish: {
    title: 'admin.unpublish.title',
    intro: 'admin.unpublish.intro',
    submit: 'admin.unpublish.submit',
    nothing: 'admin.unpublish.nothing',
    busy: 'admin.unpublish.busy',
    doneTitle: 'admin.unpublish.done.title',
    done: 'admin.unpublish.done',
  },
} as const

type Change = { document: DocumentSummary; isNew: boolean; lines: string[] }

const actionOf = (raw: unknown): Action => (raw === 'unpublish' ? 'unpublish' : 'publish')

/** The ids of a comma-separated list or of a repeated parameter, without blanks or repeats. */
export function idsOf(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : [raw]
  const ids = values.flatMap((value) => (typeof value === 'string' ? value.split(',') : []))
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ''))]
}

/** A return address inside the admin: `raw` when it is a plain `/admin` path, otherwise `/admin`. */
export function backOf(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/admin')) return '/admin'
  // eslint-disable-next-line no-control-regex
  if (raw.includes('//') || raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) return '/admin'
  return raw
}

const backLabel = (back: string | undefined) =>
  t(back === undefined ? 'admin.publish.back' : back.startsWith('/admin/documents/') ? 'admin.publish.backToEditor' : 'admin.publish.backToList')

/** A link to `back`, or to the start page without one. In the publish dialog it closes the dialog instead. */
const backLink = (back: string | undefined): SafeHtml =>
  html`<p><a href="${back ?? '/admin'}" class="btn btn-sm" data-dialog-cancel data-dialog-label="${t('admin.publish.close')}">${backLabel(back)}</a></p>`

/** `{ id: headRev }` from the form, or `null` unless it covers every id with a revision number. */
function expectOf(raw: unknown, ids: string[]): Record<string, number> | null {
  if (typeof raw !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const expect: Record<string, number> = {}
  for (const id of ids) {
    const rev = (parsed as Record<string, unknown>)[id]
    if (typeof rev !== 'number' || !Number.isInteger(rev)) return null
    expect[id] = rev
  }
  return expect
}

const pageLink = (action: Action, ids: string[], back?: string) =>
  `${PUBLISH_PATH}?${new URLSearchParams({ ids: ids.join(','), action, ...(back !== undefined && { back }) }).toString()}`

const itemTitle = (doc: Pick<DocumentSummary, 'title' | 'locale'>) => t('admin.publish.item', { title: doc.title, locale: doc.locale })

/** Each document, marked when new, with its change lines (none for unpublishing). */
function changeList(action: Action, changes: Change[]): SafeHtml {
  return html`<ul class="list-disc space-y-2 pl-6">${changes.map(
    ({ document, isNew, lines }) =>
      html`<li><strong>${itemTitle(document)}</strong>${
        isNew && action === 'publish' ? html` <span class="${badgeClass('info')}">${t('admin.publish.new')}</span>` : ''
      }${action === 'publish' && lines.length > 0 ? html`<ul class="list-disc pl-6">${lines.map((line) => html`<li>${line}</li>`)}</ul>` : ''}</li>`,
  )}</ul>`
}

/** The problems of a failed (dry) run: one list per document, each problem named by its field labels. */
function problemList(e: InlayError): SafeHtml {
  const line = (issue: ContentIssue) =>
    html`<li>${issue.labels.length > 0 ? `${issue.labels.join(' → ')}: ` : ''}${issue.message}</li>`
  const documents = e.details.documents ?? []
  return html`${Alert({ kind: 'error', children: e.message })}${documents.map(
    (doc) => html`<h2 class="mt-4 text-xl font-semibold">${doc.title}</h2><ul class="list-disc pl-6">${doc.issues.map(line)}</ul>`,
  )}${(e.details.issues ?? []).length > 0 ? html`<ul class="list-disc pl-6">${(e.details.issues ?? []).map(line)}</ul>` : ''}`
}

/** What the page is showing; the publish dialog picks its icon by it. */
type PanelState = 'review' | 'unpublish' | 'nothing' | 'problems' | 'changed' | 'done'

/**
 * An admin page in the dashboard's section. Its content is `#publish-panel`, which `client/admin/publish.ts` loads
 * into the publish dialog, taking the dialog's heading from `data-title`.
 */
const sectionPage = (ctx: AdminContext, actor: Actor, title: string, state: PanelState, body: SafeHtml) =>
  adminPage(
    ctx,
    { title, actor, section: 'dashboard' },
    html`<div id="publish-panel" data-state="${state}" data-title="${title}" class="flex flex-col gap-4">${body}</div>`,
  )

function confirmForm(action: Action, ids: string[], expect: Record<string, number>, back: string | undefined): SafeHtml {
  return html`<form method="post" action="${PUBLISH_PATH}" data-busy-label="${t(
    COPY[action].busy,
  )}" class="flex flex-wrap items-center gap-2 [&>button]:btn [&>button]:btn-primary"><input type="hidden" name="ids" value="${ids.join(
    ',',
  )}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="expect" value="${JSON.stringify(
    expect,
  )}">${back === undefined ? '' : html`<input type="hidden" name="back" value="${back}">`}<button type="submit">${t(
    COPY[action].submit,
  )}</button><a href="${back ?? '/admin'}" class="btn btn-ghost" data-dialog-cancel>${t('admin.publish.cancel')}</a></form>`
}

/** Nothing happened because the content moved on since the page was shown; `reload` shows the latest. */
function changedPage(ctx: AdminContext, actor: Actor, reload: string): Promise<string> {
  return sectionPage(
    ctx,
    actor,
    t('admin.publish.changed.title'),
    'changed',
    html`<p>${t('admin.publish.changed')}</p><p><a href="${reload}" class="btn btn-sm btn-primary">${t('admin.publish.reload')}</a></p>`,
  )
}

/** The heading of a failed (dry) run: content that isn't ready to publish, or anything else that stopped it. */
const failedTitle = (action: Action, e: InlayError) =>
  t(action === 'publish' && e.code === 'validation' ? 'admin.publish.blocked.title' : 'admin.publish.failed.title')

const statusOf = (e: InlayError) => (e.code === 'forbidden' ? 403 : e.code === 'conflict' ? 409 : 400)

/**
 * `GET /admin/publish?ids=&action=` shows what publishing (or unpublishing) would change, with one button that
 * confirms exactly that; `POST /admin/publish` does it, refusing if anything changed since the page was shown.
 * `scope` is a signed-in scope from `registerScreens`, which also checks the origin of the POST.
 */
export function registerPublishRoutes(scope: FastifyInstance, opts: AdminContext): void {
  const { core } = opts
  const page = (reply: FastifyReply, status: number, body: string) => reply.code(status).type(HTML).send(body)

  scope.get(PUBLISH_PATH, async (request, reply) => {
    const actor = adminActor(request)
    const ctx: Ctx = { actor, source: 'admin' }
    const query = request.query as Record<string, unknown>
    const action = actionOf(query.action)
    const reviewPage = (body: SafeHtml, state: PanelState = 'nothing') => sectionPage(opts, actor, t(COPY[action].title), state, body)
    const asked = idsOf(query.ids)
    const back = Object.hasOwn(query, 'back') ? backOf(query.back) : undefined
    // `ids` with nothing in it is the dashboard's form with every box unticked; without `ids`, publish everything waiting.
    if (Object.hasOwn(query, 'ids') && asked.length === 0) {
      const body = html`<p>${t('admin.publish.noneSelected')}</p>${backLink(back)}`
      return page(reply, 200, await reviewPage(body))
    }
    const ids = asked.length > 0 ? asked : action === 'publish' ? (await core.listPendingChanges()).map((d) => d.id) : []
    const nothing = async () => page(reply, 200, await reviewPage(html`<p>${t(COPY[action].nothing)}</p>${backLink(back)}`))
    if (ids.length === 0) return nothing()

    let changes: Change[]
    try {
      changes = await core.describeChanges(ids)
      const expect = Object.fromEntries(changes.map((c) => [c.document.id, c.document.headRev]))
      const dry =
        action === 'publish'
          ? await core.publish(ids, ctx, { dryRun: true, expect })
          : await core.unpublish(ids, ctx, { dryRun: true })
      const doing = new Set(dry.items.map((item) => item.documentId))
      changes = changes.filter((c) => doing.has(c.document.id))
    } catch (e) {
      if (!(e instanceof InlayError)) throw e
      if (e.code === 'conflict') return page(reply, 409, await changedPage(opts, actor, pageLink(action, ids, back)))
      const body = html`<p>${t('admin.publish.problems')}</p>${problemList(e)}`
      return page(reply, e.code === 'forbidden' ? 403 : 200, await sectionPage(opts, actor, failedTitle(action, e), 'problems', body))
    }
    if (changes.length === 0) return nothing()
    const confirming = changes.map((c) => c.document.id)
    const expect = Object.fromEntries(changes.map((c) => [c.document.id, c.document.headRev]))
    const body = html`<p>${t(COPY[action].intro)}</p>${changeList(action, changes)}${confirmForm(action, confirming, expect, back)}`
    return page(reply, 200, await reviewPage(body, action === 'publish' ? 'review' : 'unpublish'))
  })

  scope.post(PUBLISH_PATH, async (request, reply) => {
    const actor = adminActor(request)
    const ctx: Ctx = { actor, source: 'admin' }
    const form = formOf(request)
    const action = actionOf(form.action)
    const ids = idsOf(form.ids)
    const back = form.back === undefined ? undefined : backOf(form.back)
    const reload = pageLink(action, ids, back)
    const changed = async () => page(reply, 409, await changedPage(opts, actor, reload))
    if (ids.length === 0) return changed()
    const expect = action === 'publish' ? expectOf(form.expect, ids) : {}
    // Without the revisions the user saw, there is no telling what they confirmed.
    if (expect === null) return changed()

    // The publish page (no JS, or a page opened before the dialog existed) goes back where it came from; the dialog
    // (`_dialog`) gets the "done" panel, and reloads the page itself when it closes.
    const returning = back !== undefined && form._dialog !== '1'

    let done: string[]
    try {
      const result = action === 'publish' ? await core.publish(ids, ctx, { expect }) : await core.unpublish(ids, ctx)
      done = result.items.map((item) => item.documentId)
    } catch (e) {
      if (!(e instanceof InlayError)) throw e
      if (e.code === 'conflict') return changed()
      const body = html`<p>${t('admin.publish.problems')}</p>${problemList(e)}<p><a href="${reload}" class="btn btn-sm">${t('admin.publish.reload')}</a></p>`
      return page(reply, statusOf(e), await sectionPage(opts, actor, failedTitle(action, e), 'problems', body))
    }

    if (returning) {
      return reply.redirect(`${back}${back.includes('?') ? '&' : '?'}notice=${action === 'publish' ? 'published' : 'unpublished'}`, 303)
    }

    const items: SafeHtml[] = []
    for (const id of done) {
      const doc = await core.getDocument(id)
      if (!doc) continue
      const live =
        action === 'publish'
          ? (await core.liveDocuments([doc.groupId], doc.locale, { state: 'published' })).get(doc.groupId)
          : undefined
      const path = live && live.documentId === id ? live.path : null
      items.push(html`<li>${path === null ? itemTitle(doc) : html`<a href="${presentHref(encodePath(path), core.registry.site.trailingSlash)}" class="link">${itemTitle(doc)}</a>`}</li>`)
    }
    const body = html`<p>${t(COPY[action].done)}</p><ul class="list-disc pl-6">${items}</ul>${backLink(back)}`
    return page(reply, 200, await sectionPage(opts, actor, t(COPY[action].doneTitle), 'done', body))
  })
}
