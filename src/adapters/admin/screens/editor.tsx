import type { FastifyInstance, FastifyReply } from 'fastify'
import { normalizeContent } from '../../../core/content/schema.js'
import { validateContent } from '../../../core/content/validate.js'
import { InlayError } from '../../../core/errors.js'
import { t } from '../../../core/messages/index.js'
import { designedInCode } from '../../../core/registry/designed.js'
import type { Actor, ContentInput, ContentIssue, DocumentData, DocumentSummary, DocumentView, LiveDocument } from '../../../core/types.js'
import type { Renderable } from '../../../jsx/html.js'
import { loadAgentRefs } from '../../mcp/agent-refs.js'
import { previewLink } from '../../site/preview.js'
import { adminActor, forbidden, formValues, HTML, noticeOf, notFound, type AdminContext, type Section } from '../context.js'
import { blankPath, panePath, paneDocument } from './preview-pane.js'
import { applyFormOp, DocumentFields, parseDocumentForm, placeIssues, readOpenState, remapOpen, type FormContext } from '../form/walk.js'
import { Icon } from '../views/icons.js'
import { adminPage, Alert, Time } from '../views/layout.js'
import { sourceLabel, StatusBadge } from '../views/status.js'

/** The address of a document's editor. */
export const editorLink = (id: string): string => `/admin/documents/${encodeURIComponent(id)}`

/** The publish (or unpublish) review of one document, which comes back to its editor. */
const publishLink = (id: string, action: 'publish' | 'unpublish') =>
  `/admin/publish?${new URLSearchParams({ ids: id, action, back: editorLink(id) }).toString()}`

const REVISION = /^\d{1,15}$/

const LANGUAGES = new Intl.DisplayNames(['en'], { type: 'language' })

/** A locale's name in English ("Spanish"), or the code itself when it has none. */
export function localeName(locale: string): string {
  try {
    return LANGUAGES.of(locale) ?? locale
  } catch {
    return locale
  }
}

/** Where a document sits in the navigation: its section and the breadcrumb back to its list. */
export function placement(ctx: AdminContext, doc: DocumentSummary): { section: Section; breadcrumbs: Array<{ label: string; href: string }> } {
  const { registry } = ctx.core
  const query = doc.locale === registry.defaultLocale ? '' : `?${new URLSearchParams({ locale: doc.locale }).toString()}`
  if (doc.kind === 'singleton') return { section: 'pages', breadcrumbs: [{ label: t('admin.nav.pages'), href: `/admin/pages${query}` }] }
  if (doc.kind === 'global') return { section: 'globals', breadcrumbs: [{ label: t('admin.nav.globals'), href: `/admin/globals${query}` }] }
  const label = registry.types.get(doc.type)?.label ?? doc.type
  return {
    section: `collection:${doc.type}`,
    breadcrumbs: [{ label, href: `/admin/collections/${encodeURIComponent(doc.type)}${query}` }],
  }
}

/** One language of a document: the document in that locale, or `null` when it isn't translated yet. */
export interface Translation {
  locale: string
  document: DocumentSummary | null
}

/** Every locale of the site with its version of `doc`'s group. */
export async function translationsOf(ctx: AdminContext, doc: DocumentSummary): Promise<Translation[]> {
  return Promise.all(
    ctx.core.registry.locales.map(async (locale) => ({
      locale,
      document: locale === doc.locale ? doc : await ctx.core.findTranslation(doc.groupId, locale),
    })),
  )
}

/**
 * Links to each language of the document as a compact button group, the current one marked. A locale without a document shows `missing`
 * when given (the "Add <language>" button), otherwise a note that it isn't translated yet.
 */
export function LocaleSwitcher({ doc, translations, missing }: {
  doc: DocumentSummary
  translations: Translation[]
  missing?: (locale: string) => Renderable
}) {
  if (translations.length < 2) return null
  return (
    <nav aria-label={t('admin.editor.languages')}>
      <ul class="join">
        {translations.map(({ locale, document }) => (
          <li>
            {document ? (
              <a
                href={editorLink(document.id)}
                lang={locale}
                aria-current={document.id === doc.id ? 'page' : undefined}
                class={document.id === doc.id ? 'btn btn-xs join-item btn-active' : 'btn btn-xs join-item'}
              >
                {localeName(locale)}
              </a>
            ) : missing ? (
              missing(locale)
            ) : (
              <span class="btn btn-xs join-item btn-disabled">{t('admin.editor.missingLocale', { name: localeName(locale) })}</span>
            )}
          </li>
        ))}
      </ul>
    </nav>
  )
}

/** A button that creates the `locale` translation of the document group `id` belongs to. */
export function TranslateButton({ id, locale }: { id: string; locale: string }) {
  return (
    <form method="post" action={`${editorLink(id)}/translations`}>
      <input type="hidden" name="locale" value={locale} />
      <button type="submit" class="btn btn-xs btn-outline join-item">
        {t('admin.editor.addLanguage', { name: localeName(locale) })}
      </button>
    </form>
  )
}

/** "Needed before publishing" hints for `data`, by form name, and those no field shows. */
function publishHints(ctx: AdminContext, type: string, data: DocumentData): { byName: Map<string, string[]>; unplaced: ContentIssue[] } {
  const { registry } = ctx.core
  const strict = validateContent(registry, type, data, 'strict')
  if (strict.ok) return { byName: new Map(), unplaced: [] }
  const placed = placeIssues(registry, type, data, strict.issues)
  const byName = new Map([...placed.byName].map(([name, messages]) => [name, messages.map((problem) => t('admin.editor.needed', { problem }))]))
  return { byName, unplaced: placed.unplaced }
}

/** The editor header's right side: when it was last saved, the Edit/Preview tabs (with a pane), Save, Publish and More. */
function HeaderActions({ doc, conflictHead, pane }: { doc: DocumentView; conflictHead?: number; pane: boolean }) {
  return (
    <div class="ml-auto flex flex-wrap items-center gap-2">
      <span id="save-state" data-text-unsaved={t('admin.editor.unsavedShort')} class="hidden text-xs text-base-content/70 md:inline">
        {t('admin.editor.lastSaved')} <Time iso={doc.revision.createdAt} />{' '}
        {t('admin.editor.savedBy', { name: doc.revision.authorName, source: sourceLabel(doc.revision.source) })}
      </span>
      {pane && (
        <div role="group" aria-label={t('admin.preview.views')} class="join lg:hidden">
          <button type="button" aria-pressed="true" data-view-btn="edit" class="btn btn-sm join-item btn-active">
            {t('admin.preview.editTab')}
          </button>
          <button type="button" aria-pressed="false" data-view-btn="preview" class="btn btn-sm join-item">
            {t('admin.preview.previewTab')}
          </button>
        </div>
      )}
      <div role="group" aria-label={t('admin.editor.actions')} class="flex items-center gap-2">
        <button type="submit" form="editor-form" name="_action" value="save" class="btn btn-sm">
          {t('admin.editor.save')}
        </button>
        {conflictHead !== undefined && (
          <button type="submit" form="editor-form" name="overwrite" value={String(conflictHead)} class="btn btn-sm btn-warning">
            {t('admin.editor.overwrite')}
          </button>
        )}
        <button type="submit" form="editor-form" name="_action" value="publish" data-publish-dialog class="btn btn-sm btn-primary">
          <Icon name="send" />
          {t('admin.editor.publish')}
        </button>
        <details id="editor-more" data-refresh class="dropdown dropdown-end">
          <summary class="btn btn-ghost btn-sm btn-square" aria-label={t('admin.editor.more')}>
            <Icon name="more" />
          </summary>
          <ul class="dropdown-content menu menu-sm z-20 mt-1 w-56 rounded-box border border-base-300 bg-base-100 p-1 shadow-lg">
            <li>
              <button type="submit" form="editor-form" name="_action" value="preview">
                <Icon name="external" />
                {t('admin.editor.preview')}
              </button>
            </li>
            <li>
              <a href={`${editorLink(doc.id)}/history`}>
                <Icon name="history" />
                {t('admin.editor.history')}
              </a>
            </li>
            {doc.kind === 'entry' && doc.publishedRev !== null && (
              <li>
                <a href={publishLink(doc.id, 'unpublish')} data-publish-dialog>
                  <Icon name="x" />
                  {t('admin.editor.unpublish')}
                </a>
              </li>
            )}
            {doc.kind === 'entry' && (
              <li>
                <a href={`${editorLink(doc.id)}/delete`} class="text-error">
                  <Icon name="trash" />
                  {t('admin.editor.delete')}
                </a>
              </li>
            )}
          </ul>
        </details>
      </div>
    </div>
  )
}

/** A preview size button; `client/admin` resizes the page to that device's width. */
function DeviceButton({ device, icon, pressed }: { device: 'desktop' | 'tablet' | 'phone'; icon: 'monitor' | 'tablet' | 'smartphone'; pressed: boolean }) {
  const label = t(`admin.preview.${device}`)
  return (
    <button
      type="button"
      data-device={device}
      aria-pressed={pressed ? 'true' : 'false'}
      aria-label={label}
      title={label}
      class={pressed ? 'btn btn-xs join-item btn-active' : 'btn btn-xs join-item'}
    >
      <Icon name={icon} />
    </button>
  )
}

/** The live preview: a toolbar over the page itself, which loads the saved draft and is then rewritten as the form changes. */
function PreviewPane({ id, live }: { id: string; live: LiveDocument & { path: string } }) {
  const src = panePath(id)
  return (
    <div id="preview-pane" class="flex min-h-0 flex-col overflow-y-auto border-l border-base-300 bg-base-100">
      <div class="flex h-11 shrink-0 items-center gap-2 border-b border-base-300 px-3">
        <div role="group" aria-label={t('admin.preview.size')} class="join">
          <DeviceButton device="desktop" icon="monitor" pressed />
          <DeviceButton device="tablet" icon="tablet" pressed={false} />
          <DeviceButton device="phone" icon="smartphone" pressed={false} />
        </div>
        <span id="preview-scale" class="text-xs tabular-nums text-base-content/70"></span>
        <div class="mx-auto flex min-w-0 items-center gap-1.5 rounded-field bg-base-200 px-2.5 py-1 text-xs text-base-content/70">
          <Icon name="globe" class="opacity-60" />
          <span class="truncate">{live.path}</span>
        </div>
        <span
          id="preview-status"
          data-text-updating={t('admin.preview.updating')}
          data-text-ready={t('admin.preview.ready')}
          data-text-signed-out={t('admin.preview.signedOut')}
          data-text-failed={t('admin.preview.failed')}
          class="flex min-w-0 items-center gap-1.5 truncate text-xs text-base-content/70"
        ></span>
        <span id="preview-announce" role="status" class="sr-only"></span>
        <button
          type="button"
          id="preview-hide"
          aria-label={t('admin.preview.hide')}
          title={t('admin.preview.hide')}
          class="btn btn-ghost btn-xs btn-square hidden lg:inline-flex"
        >
          <Icon name="panel-right" />
        </button>
      </div>
      <div id="preview-stage" class="relative flex min-h-0 flex-1 justify-center overflow-hidden bg-base-200 p-3">
        <div id="preview-device" class="relative w-full overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-base-300">
          <iframe
            id="preview-frame"
            title={t('admin.preview.title')}
            src={src}
            data-preview-url={src}
            data-blank-url={blankPath(id)}
            data-page-path={live.path}
            class="absolute left-0 top-0 h-full w-full origin-top-left border-0 bg-white"
          ></iframe>
        </div>
      </div>
    </div>
  )
}

/** What the editor page shows besides the document itself. */
export interface EditorState {
  /** The data in the form: the stored head, or what was submitted. */
  data: DocumentData
  /** The `base` the form carries: the head it was opened from. */
  base: string
  status?: number
  notice?: string
  /** Inside the form, so htmx swaps carry it: "not saved yet" after a list button. */
  unsaved?: boolean
  /** A message about the whole form, shown as an error above the fields. */
  error?: string
  problems?: Map<string, string[]>
  unplaced?: ContentIssue[]
  /** A stale save: who saved since, and the head to save over. */
  conflict?: { head: number; name: string; source: DocumentView['revision']['source'] }
  /** After a list button: the list items and cards to show open and closed, as the editor had them. */
  open?: Set<string>
  closed?: Set<string>
  /** After Save and publish: the review the publish dialog opens with as the page loads. */
  review?: string
}

/** The editor page of `doc` (the current head, for the header) showing `state`. */
export async function editorPage(ctx: AdminContext, actor: Actor, doc: DocumentView, state: EditorState): Promise<string> {
  const { core } = ctx
  const { registry } = core
  const def = registry.getType(doc.type)
  const action = editorLink(doc.id)
  const [refs, translations, live, gap] = await Promise.all([
    loadAgentRefs({ core, baseUrl: ctx.baseUrl }, doc.type, doc.locale, state.data),
    translationsOf(ctx, doc),
    paneDocument(ctx, doc),
    doc.publishedRev === null ? undefined : core.listGaps({ ids: [doc.id] }).then((gaps) => gaps[0]),
  ])
  const pane = live !== null && live.path !== null ? { ...live, path: live.path } : null
  const hints = publishHints(ctx, doc.type, state.data)
  const formCtx: FormContext = {
    registry,
    type: doc.type,
    locale: doc.locale,
    refs,
    action,
    ...(ctx.readOnly && { readOnly: true }),
    hints: hints.byName,
    ...(state.problems && { problems: state.problems }),
    ...(state.open && { open: state.open }),
    ...(state.closed && { closed: state.closed }),
  }
  const unplaced = state.unplaced ?? []
  const actions = (
    <>
      <span id="editor-status" data-refresh>
        <StatusBadge doc={doc} />
      </span>
      <LocaleSwitcher
        doc={doc}
        translations={translations}
        missing={(locale) => <TranslateButton id={doc.id} locale={locale} />}
      />
      <HeaderActions doc={doc} pane={pane !== null} {...(state.conflict && { conflictHead: state.conflict.head })} />
    </>
  )
  const body = (
    <>
      <div
        id="workspace"
        data-view="edit"
        class={pane ? 'grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(24rem,5fr)_7fr]' : 'grid min-h-0 flex-1 grid-cols-1'}
      >
        <div id="form-pane" class="min-h-0 overflow-y-auto">
          {/* `data-save-errors`: the page shows a failed save, which Save and publish sends the ordinary way to clear. */}
          <form
            id="editor-form"
            method="post"
            action={action}
            data-save-errors={(state.status ?? 200) >= 400}
            class="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-24"
          >
            {/* The first submit button is what Enter in a text box presses, so it must be Save, not a list button. */}
            <button type="submit" name="_action" value="save" class="hidden" tabindex="-1" aria-hidden="true"></button>
            <input type="hidden" name="base" value={state.base} />
            {state.review !== undefined && <div hidden data-publish-open={state.review}></div>}
            {state.unsaved === true && (
              <div role="status" class="alert alert-info">
                {t('admin.editor.unsaved')}
              </div>
            )}
            {state.conflict && (
              <Alert kind="error">
                {t('admin.editor.conflict', { name: state.conflict.name, source: sourceLabel(state.conflict.source) })}
              </Alert>
            )}
            {(state.error !== undefined || unplaced.length > 0) && (
              <Alert kind="error">
                <div>
                  {state.error !== undefined && <p>{state.error}</p>}
                  {unplaced.length > 0 && (
                    <ul class="list-disc pl-6">
                      {unplaced.map((issue) => (
                        <li>{issue.message}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </Alert>
            )}
            {/* Labels only: the field hints below already mark the same fields when the head is the published revision. */}
            {gap && (
              <Alert kind="warning">
                {t('admin.gaps.editor', { count: gap.issues.length, labels: gap.issues.map((issue) => issue.labels.join(' → ')).join(', ') })}
              </Alert>
            )}
            {hints.unplaced.length > 0 && (
              <Alert kind="warning">
                <div>
                  <p>{t('admin.editor.neededIntro')}</p>
                  <ul class="list-disc pl-6">
                    {hints.unplaced.map((issue) => (
                      <li>{issue.message}</li>
                    ))}
                  </ul>
                </div>
              </Alert>
            )}
            {def.kind !== 'collection' && designedInCode(def.template) ? (
              <div role="note" class="alert alert-info">
                {t('admin.editor.designedInCode')}
              </div>
            ) : (
              <DocumentFields
                ctx={formCtx}
                data={state.data}
                {...(def.kind === 'collection' && { entry: { customPaths: def.customPaths } })}
              />
            )}
          </form>
        </div>
        {pane && <PreviewPane id={doc.id} live={pane} />}
      </div>
      {pane && (
        <button type="button" id="preview-show" hidden class="btn btn-sm fixed bottom-4 right-4 z-30 shadow-lg">
          <Icon name="eye" />
          {t('admin.preview.show')}
        </button>
      )}
    </>
  )
  const { section, breadcrumbs } = placement(ctx, doc)
  return adminPage(
    ctx,
    {
      title: doc.title,
      actor,
      section,
      breadcrumbs,
      actions,
      layout: 'workspace',
      scripts: ['editor.js'],
      ...(state.status !== undefined && { status: state.status }),
      ...(state.notice !== undefined && { notice: state.notice }),
    },
    body,
  )
}

/** What the new-entry page shows besides the empty form. */
interface NewState {
  data: DocumentData
  status?: number
  unsaved?: boolean
  error?: string
  problems?: Map<string, string[]>
  unplaced?: ContentIssue[]
  open?: Set<string>
  closed?: Set<string>
}

/** The form for a new entry of collection `type` in `locale`. */
async function newEntryPage(ctx: AdminContext, actor: Actor, type: string, locale: string, state: NewState): Promise<string> {
  const { core } = ctx
  const { registry } = core
  const def = registry.getType(type)
  const action = `/admin/collections/${encodeURIComponent(type)}`
  const refs = await loadAgentRefs({ core, baseUrl: ctx.baseUrl }, type, locale, state.data)
  const formCtx: FormContext = {
    registry,
    type,
    locale,
    refs,
    action,
    ...(ctx.readOnly && { readOnly: true }),
    ...(state.problems && { problems: state.problems }),
    ...(state.open && { open: state.open }),
    ...(state.closed && { closed: state.closed }),
  }
  const unplaced = state.unplaced ?? []
  const body = (
    <form id="editor-form" method="post" action={action} class="flex flex-col gap-4">
      <button type="submit" name="_action" value="save" class="hidden" tabindex="-1" aria-hidden="true"></button>
      <input type="hidden" name="locale" value={locale} />
      {state.unsaved === true && (
        <div role="status" class="alert alert-info">
          {t('admin.editor.unsaved')}
        </div>
      )}
      {(state.error !== undefined || unplaced.length > 0) && (
        <Alert kind="error">
          <div>
            {state.error !== undefined && <p>{state.error}</p>}
            {unplaced.length > 0 && (
              <ul class="list-disc pl-6">
                {unplaced.map((issue) => (
                  <li>{issue.message}</li>
                ))}
              </ul>
            )}
          </div>
        </Alert>
      )}
      <DocumentFields
        ctx={formCtx}
        data={state.data}
        {...(def.kind === 'collection' && { entry: { customPaths: def.customPaths } })}
      />
      <div role="group" aria-label={t('admin.editor.actions')} class="flex flex-wrap items-center gap-2 border-t border-base-300 pt-4">
        <button type="submit" name="_action" value="save" class="btn btn-primary">
          {t('admin.editor.create')}
        </button>
        <button type="submit" name="_action" value="preview" class="btn">
          {t('admin.editor.createPreview')}
        </button>
      </div>
    </form>
  )
  return adminPage(
    ctx,
    {
      title: t('admin.editor.newTitle', { label: def.label }),
      actor,
      section: `collection:${type}`,
      breadcrumbs: [{ label: def.label, href: action }],
      scripts: ['editor.js'],
      ...(state.status !== undefined && { status: state.status }),
    },
    body,
  )
}

/** A page with one message, for a request the core refused. */
async function messagePage(reply: FastifyReply, ctx: AdminContext, actor: Actor, status: number, title: string, message: string, section?: Section) {
  const body = (
    <>
      <Alert kind="error">{message}</Alert>
      <p>
        <a href="/admin" class="link">
          {t('admin.backToDashboard')}
        </a>
      </p>
    </>
  )
  const page = await adminPage(ctx, { title, actor, status, ...(section && { section }) }, body)
  return reply.code(status).type(HTML).send(page)
}

/** The 404 page of a deleted entry, linking to its list. */
async function deletedPage(reply: FastifyReply, ctx: AdminContext, actor: Actor, doc: DocumentView): Promise<FastifyReply> {
  const { section, breadcrumbs } = placement(ctx, doc)
  const list = breadcrumbs[0]!
  const body = (
    <>
      <p>{t('error.editDeleted', { title: doc.title })}</p>
      <p>
        <a href={list.href} class="link">
          {t('admin.editor.backToList', { list: list.label })}
        </a>
      </p>
    </>
  )
  const page = await adminPage(ctx, { title: t('admin.editor.deleted.title'), actor, section, breadcrumbs, status: 404 }, body)
  return reply.code(404).type(HTML).send(page)
}

/** The editor: `GET` shows a document's form, `POST` saves it (or applies a list button without saving). */
export function registerEditor(scope: FastifyInstance, ctx: AdminContext): void {
  const { core } = ctx
  const { registry } = core

  const send = (reply: FastifyReply, status: number, body: string) => reply.code(status).type(HTML).send(body)

  /** The document, or the reply already sent when it is unknown or deleted. */
  async function load(reply: FastifyReply, actor: Actor, id: string): Promise<DocumentView | FastifyReply> {
    const doc = await core.getDocument(id)
    if (!doc) return notFound(reply, ctx, actor)
    if (doc.deletedAt !== null) return deletedPage(reply, ctx, actor, doc)
    return doc
  }

  scope.get('/admin/documents/:id', async (request, reply) => {
    const actor = adminActor(request)
    const { id } = request.params as { id: string }
    const doc = await load(reply, actor, id)
    if (!('revision' in doc)) return doc
    const notice = noticeOf(request.query)
    const review = (request.query as Record<string, unknown>).review === 'publish' ? publishLink(doc.id, 'publish') : undefined
    const page = await editorPage(ctx, actor, doc, {
      data: doc.data,
      base: String(doc.headRev),
      ...(notice !== undefined && { notice }),
      ...(review !== undefined && { review }),
    })
    return send(reply, 200, page)
  })

  scope.post('/admin/documents/:id', async (request, reply) => {
    const actor = adminActor(request)
    const { id } = request.params as { id: string }
    const doc = await load(reply, actor, id)
    if (!('revision' in doc)) return doc
    const form = formValues(request)
    const data = parseDocumentForm(registry, doc.type, form)
    const submittedBase = form.get('base') ?? ''

    const op = form.get('_op')
    if (op !== undefined) {
      const next = applyFormOp(registry, doc.type, data, op)
      const { open, closed } = readOpenState(form)
      const shown = { open: new Set(remapOpen(registry, doc.type, data, op, open)), closed: new Set(closed) }
      return send(reply, 200, await editorPage(ctx, actor, doc, { data: next, base: submittedBase, unsaved: true, ...shown }))
    }

    const rawBase = form.get('overwrite') ?? form.get('base')
    if (rawBase === undefined || !REVISION.test(rawBase)) {
      return send(reply, 400, await editorPage(ctx, actor, doc, { data, base: submittedBase, status: 400, error: t('admin.editor.badBase') }))
    }

    let result
    try {
      result = await core.saveDraft(doc.id, { baseRevisionId: Number(rawBase), data }, { actor, source: 'admin' })
    } catch (e) {
      if (!(e instanceof InlayError)) throw e
      if (e.code === 'not_found') return notFound(reply, ctx, actor)
      if (e.code === 'validation') {
        const { byName, unplaced } = placeIssues(registry, doc.type, data, e.details.issues ?? [])
        const page = await editorPage(ctx, actor, doc, {
          data,
          base: submittedBase,
          status: 400,
          error: t('admin.editor.problems'),
          problems: byName,
          unplaced,
        })
        return send(reply, 400, page)
      }
      if (e.code === 'conflict') {
        const current = await core.getDocument(doc.id)
        if (!current || current.deletedAt !== null) return notFound(reply, ctx, actor)
        const conflict = { head: current.headRev, name: current.revision.authorName, source: current.revision.source }
        return send(reply, 409, await editorPage(ctx, actor, current, { data, base: submittedBase, status: 409, conflict }))
      }
      if (e.code === 'invalid_operation') {
        return send(reply, 400, await editorPage(ctx, actor, doc, { data, base: submittedBase, status: 400, error: e.message }))
      }
      throw e
    }

    const next = form.get('_action')
    if (next === 'preview') {
      const live = await core.liveDocuments([doc.groupId], doc.locale, { state: 'preview' })
      const path = live.get(doc.groupId)?.path ?? '/'
      return reply.redirect(previewLink(ctx, path), 303)
    }
    if (next === 'publish') {
      // With JS (`_dialog`), back to the editor, which opens the publish dialog; without, to the publish page.
      const to = form.get('_dialog') === '1' ? `${editorLink(doc.id)}?review=publish` : publishLink(doc.id, 'publish')
      return reply.redirect(to, 303)
    }
    return reply.redirect(`${editorLink(doc.id)}?notice=${result.changed ? 'saved' : 'unchanged'}`, 303)
  })

  scope.get('/admin/collections/:type/new', async (request, reply) => {
    const actor = adminActor(request)
    const { type } = request.params as { type: string }
    if (registry.types.get(type)?.kind !== 'collection') return notFound(reply, ctx, actor)
    // Entries start in the default language; other languages are added as translations.
    const data = normalizeContent(registry, type, {})
    return send(reply, 200, await newEntryPage(ctx, actor, type, registry.defaultLocale, { data }))
  })

  scope.post('/admin/collections/:type', async (request, reply) => {
    const actor = adminActor(request)
    const { type } = request.params as { type: string }
    if (registry.types.get(type)?.kind !== 'collection') return notFound(reply, ctx, actor)
    const form = formValues(request)
    const asked = form.get('locale')
    const locale = asked !== undefined && registry.locales.includes(asked) ? asked : registry.defaultLocale
    const data = parseDocumentForm(registry, type, form)

    const op = form.get('_op')
    if (op !== undefined) {
      const next = applyFormOp(registry, type, data, op)
      const { open, closed } = readOpenState(form)
      const shown = { open: new Set(remapOpen(registry, type, data, op, open)), closed: new Set(closed) }
      return send(reply, 200, await newEntryPage(ctx, actor, type, locale, { data: next, unsaved: true, ...shown }))
    }

    const input: ContentInput = {
      ...(data.slug !== undefined && { slug: data.slug }),
      ...(data.path !== undefined && { path: data.path }),
      fields: data.fields,
      slots: Object.fromEntries(Object.entries(data.slots).map(([key, slot]) => [key, slot.enabled ? slot.data : false])),
    }
    let created
    try {
      created = await core.createEntry(type, { ...input, locale }, { actor, source: 'admin' })
    } catch (e) {
      if (!(e instanceof InlayError)) throw e
      if (e.code === 'forbidden') return forbidden(reply, ctx, actor)
      if (e.code === 'validation') {
        const { byName, unplaced } = placeIssues(registry, type, data, e.details.issues ?? [])
        const page = await newEntryPage(ctx, actor, type, locale, {
          data,
          status: 400,
          error: t('admin.editor.problems'),
          problems: byName,
          unplaced,
        })
        return send(reply, 400, page)
      }
      if (e.code === 'invalid_operation') {
        return send(reply, 400, await newEntryPage(ctx, actor, type, locale, { data, status: 400, error: e.message }))
      }
      throw e
    }

    if (form.get('_action') === 'preview') {
      const live = await core.liveDocuments([created.groupId], created.locale, { state: 'preview' })
      return reply.redirect(previewLink(ctx, live.get(created.groupId)?.path ?? '/'), 303)
    }
    return reply.redirect(`${editorLink(created.id)}?notice=created`, 303)
  })

  scope.post('/admin/documents/:id/translations', async (request, reply) => {
    const actor = adminActor(request)
    const { id } = request.params as { id: string }
    const doc = await core.getDocument(id)
    if (!doc) return notFound(reply, ctx, actor)
    const locale = formValues(request).get('locale') ?? ''
    try {
      const created = await core.createTranslation(doc.groupId, locale, { actor, source: 'admin' })
      return reply.redirect(`${editorLink(created.id)}?notice=translated`, 303)
    } catch (e) {
      if (!(e instanceof InlayError)) throw e
      if (e.code === 'forbidden') return forbidden(reply, ctx, actor)
      if (e.code === 'not_found') return notFound(reply, ctx, actor)
      if (e.code === 'invalid_operation') {
        return messagePage(reply, ctx, actor, 400, doc.title, e.message, placement(ctx, doc).section)
      }
      throw e
    }
  })

  scope.get('/admin/documents/:id/delete', async (request, reply) => {
    const actor = adminActor(request)
    const { id } = request.params as { id: string }
    const doc = await load(reply, actor, id)
    if (!('revision' in doc)) return doc
    if (doc.kind !== 'entry') return notFound(reply, ctx, actor)
    const { section, breadcrumbs } = placement(ctx, doc)
    const body = (
      <form method="post" action={`${editorLink(doc.id)}/delete`} class="flex flex-col gap-4">
        <p>{t('admin.delete.intro', { title: doc.title })}</p>
        <div class="flex gap-2">
          <button type="submit" class="btn btn-error">
            {t('admin.delete.confirm')}
          </button>
          <a href={editorLink(doc.id)} class="btn btn-ghost">
            {t('admin.delete.cancel')}
          </a>
        </div>
      </form>
    )
    const page = await adminPage(ctx, { title: t('admin.delete.title', { title: doc.title }), actor, section, breadcrumbs }, body)
    return send(reply, 200, page)
  })

  scope.post('/admin/documents/:id/delete', async (request, reply) => {
    const actor = adminActor(request)
    const { id } = request.params as { id: string }
    const doc = await load(reply, actor, id)
    if (!('revision' in doc)) return doc
    if (doc.kind !== 'entry') return notFound(reply, ctx, actor)
    const { section, breadcrumbs } = placement(ctx, doc)
    try {
      await core.deleteEntry(doc.groupId, { actor, source: 'admin' })
    } catch (e) {
      if (!(e instanceof InlayError)) throw e
      if (e.code === 'forbidden') return forbidden(reply, ctx, actor)
      if (e.code === 'not_found') return notFound(reply, ctx, actor)
      if (e.code === 'in_use') {
        const usages = e.details.usages ?? []
        const body = (
          <>
            <Alert kind="error">{e.message}</Alert>
            <p>{t('admin.delete.usedBy')}</p>
            <ul class="list-disc pl-6">
              {usages.map((u) => (
                <li>
                  <a href={editorLink(u.documentId)} class="link">
                    {u.title}
                  </a>
                </li>
              ))}
            </ul>
            <p>
              <a href={editorLink(doc.id)} class="link">
                {t('admin.editor.backToList', { list: doc.title })}
              </a>
            </p>
          </>
        )
        const page = await adminPage(ctx, { title: t('admin.delete.title', { title: doc.title }), actor, section, breadcrumbs, status: 409 }, body)
        return send(reply, 409, page)
      }
      throw e
    }
    return reply.redirect(`${breadcrumbs[0]!.href}${breadcrumbs[0]!.href.includes('?') ? '&' : '?'}notice=deleted`, 303)
  })

  scope.post('/admin/documents/:id/restore', async (request, reply) => {
    const actor = adminActor(request)
    const { id } = request.params as { id: string }
    const doc = await core.getDocument(id)
    if (!doc) return notFound(reply, ctx, actor)
    try {
      await core.restoreEntry(doc.groupId, { actor, source: 'admin' })
    } catch (e) {
      if (!(e instanceof InlayError)) throw e
      if (e.code === 'forbidden') return forbidden(reply, ctx, actor)
      if (e.code === 'not_found') return notFound(reply, ctx, actor)
      throw e
    }
    return reply.redirect(`${editorLink(doc.id)}?notice=restored`, 303)
  })
}
