import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { InlayError } from '../../../core/errors.js'
import { t } from '../../../core/messages/index.js'
import type { Actor, CodeRedirect, Ctx, Redirect, RedirectInput, RedirectSource } from '../../../core/types.js'
import { adminActor, formOf, HTML, noticeOf, notFound, type AdminContext } from '../context.js'
import { DataTable, readTableQuery } from '../views/data-table.js'
import { Icon } from '../views/icons.js'
import { Alert, adminPage, Time } from '../views/layout.js'
import { Sheet } from '../views/sheet.js'
import { Badge } from '../views/status.js'


const sourceName = (s: RedirectSource): string => t(`admin.redirects.source.${s}`)

/** What the add form shows: the submitted values, and what went wrong. */
interface AddForm {
  values?: Record<string, string>
  error?: InlayError
  /** The title shown for the chosen page, when the form is shown again. */
  chosen?: string
}

interface ImportForm {
  csv: string
  problems: string[]
  summary?: string
}

/** The redirects: a searchable table, an add form, and a CSV import. */
export function registerRedirects(scope: FastifyInstance, ctx: AdminContext): void {
  const { core } = ctx
  const asCtx = (actor: Actor): Ctx => ({ actor, source: 'admin' })
  const send = async (reply: FastifyReply, status: number, opts: Parameters<typeof adminPage>[1], body: Parameters<typeof adminPage>[2]) =>
    reply.code(status).type(HTML).send(await adminPage(ctx, { ...opts, status }, body))

  function Target({ redirect, docs }: { redirect: Redirect; docs: Map<string, { documentId: string; title: string }> }) {
    if ('path' in redirect.to) return <code>{redirect.to.path}</code>
    if ('url' in redirect.to) return <code>{redirect.to.url}</code>
    const doc = docs.get(redirect.to.document)
    return doc === undefined ? (
      <span>{t('admin.redirects.missingPage')}</span>
    ) : (
      <a href={`/admin/documents/${encodeURIComponent(doc.documentId)}`} class="link">
        {doc.title}
      </a>
    )
  }

  function CodeRules({ rules }: { rules: CodeRedirect[] }) {
    return (
      <section id="code-redirects" aria-labelledby="code-redirects-heading" class="flex flex-col gap-3">
        <h2 id="code-redirects-heading" class="text-lg font-semibold">
          {t('admin.redirects.code.heading')}
        </h2>
        <p class="text-sm text-base-content/70">{t('admin.redirects.code.intro')}</p>
        <div class="overflow-x-auto">
          <table class="table">
            <caption class="sr-only">{t('admin.redirects.code.table')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.redirects.from')}</th>
                <th scope="col">{t('admin.redirects.to')}</th>
                <th scope="col">{t('admin.redirects.type')}</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr>
                  <td>
                    <code>{r.from}</code>
                  </td>
                  <td>
                    <code>{'path' in r.to ? r.to.path : r.to.url}</code>
                  </td>
                  <td>
                    {t(r.status === 301 ? 'admin.redirects.permanent' : 'admin.redirects.temporary')}
                    {r.overridden && (
                      <>
                        {' '}
                        <Badge tone="outline">{t('admin.redirects.code.overridden')}</Badge>
                      </>
                    )}
                    {r.hidden && (
                      <>
                        {' '}
                        <Badge tone="outline">{t('admin.redirects.code.hidden')}</Badge>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    )
  }

  async function list(request: FastifyRequest, reply: FastifyReply, status: number, sheets: { add?: AddForm; import?: ImportForm; deleteError?: string } = {}): Promise<FastifyReply> {
    const form = sheets.add ?? {}
    const imp = sheets.import ?? { csv: '', problems: [] }
    const sheet = (request.query as Record<string, unknown>).sheet
    const addOpen = sheets.add !== undefined || sheet === 'add'
    const importOpen = sheets.import !== undefined || sheet === 'import'
    const actor = adminActor(request)
    const query = request.query as Record<string, unknown>
    const table = readTableQuery(query, { sorts: [], defaultSort: 'from', defaultDir: 'asc' })
    const q = table.q
    const all = await core.listRedirects()
    const codeRules = core.registry.redirects.length === 0 ? [] : await core.listCodeRedirects()
    const wanted = new Set(all.flatMap((r) => ('document' in r.to ? [r.to.document] : [])))
    if (form.values?.to_document) wanted.add(form.values.to_document)
    const docs = wanted.size === 0 ? new Map() : await core.liveDocuments([...wanted], core.registry.defaultLocale, { state: 'preview' })
    const needle = q.toLowerCase()
    const shown =
      needle === ''
        ? all
        : all.filter((r) => {
            const to = 'path' in r.to ? r.to.path : 'url' in r.to ? r.to.url : (docs.get(r.to.document)?.title ?? '')
            return [r.from, to, r.note ?? ''].some((s) => s.toLowerCase().includes(needle))
          })
    const values = form.values ?? {}
    const mode = values.to_mode === 'document' ? 'document' : 'path'
    const chosen = values.to_document ? docs.get(values.to_document)?.title : undefined
    const picker = `/admin/pick/documents?${new URLSearchParams({ locale: core.registry.defaultLocale }).toString()}`
    const error = form.error
    const body = (
      <div class="flex flex-col gap-8">
        {sheets.deleteError !== undefined && (
          <Alert kind="error" id="delete-error">
            {sheets.deleteError}
          </Alert>
        )}
        <DataTable
          id="redirects"
          caption={t('admin.redirects.table')}
          base="/admin/redirects"
          query={table}
          rows={shown}
          rowKey={(r) => String(r.id)}
          rowLabel={(r) => r.from}
          search={{ label: t('admin.redirects.search') }}
          empty={t('admin.redirects.empty')}
          columns={[
            { key: 'from', label: t('admin.redirects.from'), cell: (r) => <code>{r.from}</code> },
            { key: 'to', label: t('admin.redirects.to'), cell: (r) => <Target redirect={r} docs={docs} /> },
            { key: 'type', label: t('admin.redirects.type'), cell: (r) => t(r.status === 301 ? 'admin.redirects.permanent' : 'admin.redirects.temporary') },
            {
              key: 'origin',
              label: t('admin.redirects.origin'),
              cell: (r) => (
                <>
                  {sourceName(r.source)}, {r.createdBy}, <Time iso={r.createdAt} relative />
                </>
              ),
            },
            { key: 'note', label: t('admin.redirects.note'), cell: (r) => r.note ?? '' },
          ]}
          rowActions={(r) => [{ label: t('admin.redirects.delete'), icon: 'trash', href: `/admin/redirects/${r.id}/delete`, danger: true, method: 'post' }]}
        />
        {codeRules.length > 0 && <CodeRules rules={codeRules} />}
        <Sheet
          id="add-redirect"
          title={t('admin.redirects.addHeading')}
          description={t('admin.redirects.addDescription')}
          open={addOpen}
          action="/admin/redirects"
          submit={t('admin.redirects.add')}
        >
          {error && (
            <Alert kind="error" id="redirect-error">
              <div>
                <p>{error.message}</p>
                {(error.details.issues ?? []).length > 0 && (
                  <ul class="list-disc pl-5">
                    {(error.details.issues ?? []).map((issue) => (
                      <li>{issue.message}</li>
                    ))}
                  </ul>
                )}
              </div>
            </Alert>
          )}
          <div class="flex flex-col gap-1.5">
            <label for="from" class="text-sm font-medium">
              {t('admin.redirects.from')}
            </label>
            <input id="from" name="from" type="text" value={values.from ?? ''} class="input w-full font-mono" placeholder={t('admin.redirects.fromPlaceholder')} aria-describedby="from-hint" />
            <p id="from-hint" class="text-xs text-base-content/70">
              {t('admin.redirects.fromHint')}
            </p>
          </div>
          <fieldset class="flex flex-col gap-3">
            <legend class="mb-1.5 text-sm font-medium">{t('admin.redirects.toMode')}</legend>
            <div class="join w-full">
              <input
                class="join-item btn btn-sm flex-1"
                type="radio"
                id="to-mode-path"
                name="to_mode"
                value="path"
                aria-label={t('admin.redirects.toPath')}
                checked={mode === 'path'}
              />
              <input
                class="join-item btn btn-sm flex-1"
                type="radio"
                id="to-mode-document"
                name="to_mode"
                value="document"
                aria-label={t('admin.redirects.toDocument')}
                checked={mode === 'document'}
              />
            </div>
            <div class="flex flex-col gap-1.5" data-shown-when="to_mode=path" hidden={mode !== 'path'}>
              <label for="to_path" class="text-sm font-medium">
                {t('admin.redirects.toPathLabel')}
              </label>
              <input id="to_path" name="to_path" type="text" value={values.to_path ?? ''} class="input w-full font-mono" placeholder={t('admin.redirects.toPathPlaceholder')} aria-describedby="to-path-hint" />
              <p id="to-path-hint" class="text-xs text-base-content/70">
                {t('admin.redirects.toPathHint')}
              </p>
            </div>
            <div
              data-shown-when="to_mode=document"
              hidden={mode !== 'document'}
              data-picker={picker}
              data-name="to_document"
              class="flex items-center gap-3 rounded-field border border-base-300 px-3 py-2.5"
            >
              <input type="hidden" name="to_document" value={values.to_document ?? ''} data-picker-value />
              <span id="to-document-chosen" data-picker-label data-empty={t('admin.form.nothingChosen')} class="min-w-0 flex-1 truncate text-sm text-base-content/60">
                {chosen ?? t('admin.form.nothingChosen')}
              </span>
              <button type="button" id="to-document" data-picker-open class="btn btn-sm" aria-describedby="to-document-chosen">
                {t('admin.redirects.choose')}
              </button>
              <button type="button" data-picker-clear class="btn btn-ghost btn-sm">
                {t('admin.form.clear')}
              </button>
            </div>
          </fieldset>
          <div class="flex flex-col gap-1.5">
            <label for="status" class="text-sm font-medium">
              {t('admin.redirects.type')}
            </label>
            <select id="status" name="status" class="select w-full">
              <option value="301" selected={values.status !== '302'}>
                {t('admin.redirects.permanent')}
              </option>
              <option value="302" selected={values.status === '302'}>
                {t('admin.redirects.temporary')}
              </option>
            </select>
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="note" class="text-sm font-medium">
              {t('admin.redirects.noteLabel')}
            </label>
            <input id="note" name="note" type="text" value={values.note ?? ''} class="input w-full" />
          </div>
        </Sheet>
        <Sheet
          id="import-redirects"
          size="lg"
          title={t('admin.redirects.importTitle')}
          description={t('admin.redirects.importDescription')}
          open={importOpen}
          action="/admin/redirects/import"
          enctype="multipart/form-data"
          submit={t('admin.redirects.importSubmit')}
        >
          {imp.problems.length > 0 && (
            <Alert kind="error" id="import-problems">
              <div>
                {imp.summary !== undefined && <p class="font-semibold">{imp.summary}</p>}
                <ul class="list-disc pl-5">
                  {imp.problems.map((p) => (
                    <li>{p}</li>
                  ))}
                </ul>
              </div>
            </Alert>
          )}
          <div id="csv-hint" class="rounded-field bg-base-200 px-4 py-3 text-sm">
            <p>{t('admin.redirects.importHint')}</p>
            <pre class="mt-2 overflow-x-auto font-mono text-xs text-base-content/80">{t('admin.redirects.importExample')}</pre>
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="file" class="text-sm font-medium">
              {t('admin.redirects.csvFile')}
            </label>
            <input id="file" name="file" type="file" accept=".csv,text/csv" class="file-input w-full" aria-describedby="csv-hint" />
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="csv" class="text-sm font-medium">
              {t('admin.redirects.csvText')}
            </label>
            <textarea id="csv" name="csv" rows="10" class="textarea w-full font-mono text-sm" aria-describedby="csv-hint">
              {imp.csv}
            </textarea>
          </div>
        </Sheet>
      </div>
    )
    const notice = noticeOf(query)
    const actions = (
      <>
        <button type="button" class="btn btn-sm" data-sheet-open="import-redirects">
          <Icon name="upload" />
          {t('admin.redirects.import')}
        </button>
        <button type="button" class="btn btn-primary btn-sm" data-sheet-open="add-redirect">
          <Icon name="plus" />
          {t('admin.redirects.addHeading')}
        </button>
      </>
    )
    return send(
      reply,
      status,
      { title: t('admin.redirects.title'), description: t('admin.redirects.intro'), actions, actor, section: 'redirects', ...(notice !== undefined && { notice }) },
      body,
    )
  }

  scope.get('/admin/redirects', (request, reply) => list(request, reply, 200))

  scope.post('/admin/redirects', async (request, reply) => {
    const actor = adminActor(request)
    const form = formOf(request)
    const to: RedirectInput['to'] = form.to_mode === 'document' ? { document: (form.to_document ?? '').trim() } : (form.to_path ?? '').trim()
    const input: RedirectInput = {
      from: (form.from ?? '').trim(),
      to,
      status: form.status === '302' ? 302 : 301,
      ...((form.note ?? '').trim() !== '' && { note: (form.note ?? '').trim() }),
    }
    try {
      await core.createRedirect(input, asCtx(actor))
    } catch (e) {
      if (!(e instanceof InlayError) || e.code !== 'validation') throw e
      return list(request, reply, 400, { add: { values: form, error: e } })
    }
    return reply.redirect('/admin/redirects?notice=redirectAdded', 303)
  })

  scope.get('/admin/redirects/import', (_request, reply) => reply.redirect('/admin/redirects?sheet=import', 303))

  /** The CSV text of an import: an uploaded file, then the textarea. */
  async function receiveCsv(request: FastifyRequest): Promise<string> {
    if (!request.isMultipart()) return formOf(request).csv ?? ''
    let file = ''
    let text = ''
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        const data = await part.toBuffer()
        if (data.length > 0) file = data.toString('utf8')
      } else if (part.fieldname === 'csv' && typeof part.value === 'string') {
        text = part.value
      }
    }
    return file !== '' ? file : text
  }

  scope.post('/admin/redirects/import', async (request, reply) => {
    const actor = adminActor(request)
    const csv = await receiveCsv(request)
    if (csv.trim() === '') return list(request, reply, 400, { import: { csv: '', problems: [t('admin.redirects.importNothing')] } })
    try {
      const { created, updated } = await core.importRedirects(csv, asCtx(actor))
      return reply.redirect(`/admin/redirects?notice=imported&created=${created}&updated=${updated}`, 303)
    } catch (e) {
      if (!(e instanceof InlayError) || e.code !== 'validation') throw e
      const lines = e.details.lines ?? []
      const problems = lines.length > 0 ? lines.map((l) => l.message) : (e.details.issues ?? []).map((i) => i.message)
      return list(request, reply, 400, {
        import: { csv, problems: problems.length > 0 ? problems : [e.message], ...(problems.length > 0 && { summary: e.message }) },
      })
    }
  })

  scope.post('/admin/redirects/:id/delete', async (request, reply) => {
    const actor = adminActor(request)
    const id = Number((request.params as { id: string }).id)
    if (!Number.isSafeInteger(id)) return notFound(reply, ctx, actor)
    try {
      await core.deleteRedirect(id, asCtx(actor))
    } catch (e) {
      if (e instanceof InlayError && e.code === 'not_found') return notFound(reply, ctx, actor)
      if (e instanceof InlayError && e.code === 'conflict') return list(request, reply, 409, { deleteError: e.message })
      throw e
    }
    return reply.redirect('/admin/redirects?notice=redirectRemoved', 303)
  })
}
