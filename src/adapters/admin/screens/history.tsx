import type { FastifyInstance, FastifyReply } from 'fastify'
import { formatDiff } from '../../../core/content/diff.js'
import { InlayError } from '../../../core/errors.js'
import { t } from '../../../core/messages/index.js'
import type { Actor, DocumentView } from '../../../core/types.js'
import { loadAgentRefs } from '../../mcp/agent-refs.js'
import { adminActor, HTML, notFound, type AdminContext } from '../context.js'
import { DocumentFields } from '../form/walk.js'
import { DataTable } from '../views/data-table.js'
import { adminPage, Time } from '../views/layout.js'
import { Badge, sourceLabel } from '../views/status.js'
import { editorLink, placement } from './editor.js'

const REVISION = /^\d{1,15}$/

const historyLink = (id: string) => `${editorLink(id)}/history`

function ChangeList({ lines }: { lines: string[] }) {
  if (lines.length === 0) return <p>{t('admin.history.noChanges')}</p>
  return (
    <ul class="list-disc pl-6">
      {lines.map((line) => (
        <li>{line}</li>
      ))}
    </ul>
  )
}

/** The history of a document: its saved versions, and any one of them with the option to restore it. */
export function registerHistory(scope: FastifyInstance, ctx: AdminContext): void {
  const { core } = ctx
  const { registry } = core

  const send = (reply: FastifyReply, status: number, body: string) => reply.code(status).type(HTML).send(body)

  /** The live document, or `undefined` when it is unknown or deleted. */
  async function load(id: string): Promise<DocumentView | undefined> {
    const doc = await core.getDocument(id)
    return doc && doc.deletedAt === null ? doc : undefined
  }

  scope.get('/admin/documents/:id/history', async (request, reply) => {
    const actor = adminActor(request)
    const { id } = request.params as { id: string }
    const doc = await load(id)
    if (!doc) return notFound(reply, ctx, actor)
    const revisions = await core.listRevisions(doc.id)
    const { section, breadcrumbs } = placement(ctx, doc)
    const body = (
      <>
        <p class="mb-4">{t('admin.history.intro')}</p>
        <DataTable
          id="history"
          caption={t('admin.history.title', { title: doc.title })}
          base={`${historyLink(doc.id)}`}
          rows={revisions}
          rowKey={(rev) => String(rev.id)}
          rowLabel={(rev) => rev.createdAt}
          empty={t('admin.history.noChanges')}
          columns={[
            {
              key: 'when',
              label: t('admin.history.when'),
              cell: (rev) => (
                <a href={`${historyLink(doc.id)}/${rev.id}`} class="link">
                  <Time iso={rev.createdAt} relative />
                </a>
              ),
            },
            { key: 'author', label: t('admin.history.author'), cell: (rev) => rev.authorName },
            { key: 'how', label: t('admin.history.how'), cell: (rev) => sourceLabel(rev.source) },
            { key: 'message', label: t('admin.history.message'), cell: (rev) => rev.message ?? '' },
            {
              key: 'state',
              label: t('admin.history.state'),
              cell: (rev) => (
                <div class="flex flex-wrap gap-1">
                  {rev.id === doc.publishedRev && <Badge tone="success">{t('admin.history.published')}</Badge>}
                  {rev.id === doc.headRev && <Badge tone="warning">{t('admin.history.current')}</Badge>}
                </div>
              ),
            },
          ]}
        />
      </>
    )
    const page = await adminPage(
      ctx,
      {
        title: t('admin.history.title', { title: doc.title }),
        actor,
        section,
        breadcrumbs: [...breadcrumbs, { label: doc.title, href: editorLink(doc.id) }],
      },
      body,
    )
    return send(reply, 200, page)
  })

  scope.get('/admin/documents/:id/history/:rev', async (request, reply) => {
    const actor = adminActor(request)
    const { id, rev: rawRev } = request.params as { id: string; rev: string }
    const doc = await load(id)
    if (!doc || !REVISION.test(rawRev)) return notFound(reply, ctx, actor)
    const revisionId = Number(rawRev)
    const [revision, revisions] = await Promise.all([core.getRevision(revisionId), core.listRevisions(doc.id)])
    if (!revision || revision.documentId !== doc.id) return notFound(reply, ctx, actor)

    const index = revisions.findIndex((r) => r.id === revisionId)
    const previous = revisions[index + 1]
    const [changes, sinceThen, refs] = await Promise.all([
      core.diffRevisions(previous?.id ?? null, revisionId),
      revisionId === doc.headRev ? Promise.resolve(null) : core.diffRevisions(revisionId, doc.headRev),
      loadAgentRefs({ core, baseUrl: ctx.baseUrl }, doc.type, doc.locale, revision.data),
    ])
    const { section, breadcrumbs } = placement(ctx, doc)
    const meta = revision.meta
    const body = (
      <>
        <p class="mb-6">
          <Time iso={meta.createdAt} /> {t('admin.editor.savedBy', { name: meta.authorName, source: sourceLabel(meta.source) })}
        </p>
        <section aria-labelledby="h-changes" class="mb-6">
          <h2 id="h-changes" class="mb-2 text-xl font-semibold">
            {t('admin.history.changes')}
          </h2>
          <ChangeList lines={formatDiff(changes)} />
        </section>
        {sinceThen && (
          <section aria-labelledby="h-now" class="mb-6">
            <h2 id="h-now" class="mb-2 text-xl font-semibold">
              {t('admin.history.changesNow')}
            </h2>
            <ChangeList lines={formatDiff(sinceThen)} />
          </section>
        )}
        <section aria-labelledby="h-restore" class="mb-6">
          <h2 id="h-restore" class="sr-only">
            {t('admin.history.restore')}
          </h2>
          <form method="post" action={`${historyLink(doc.id)}/${revisionId}/restore`} class="flex flex-col items-start gap-2">
            <button type="submit" class="btn btn-primary" aria-describedby="restore-hint">
              {t('admin.history.restore')}
            </button>
            <p id="restore-hint" class="text-sm">
              {t('admin.history.restoreHint')}
            </p>
          </form>
        </section>
        <section id="version" aria-labelledby="h-version" class="mb-6">
          <h2 id="h-version" class="mb-2 text-xl font-semibold">
            {t('admin.history.thisVersion')}
          </h2>
          <div class="flex flex-col gap-4">
            <DocumentFields ctx={{ registry, type: doc.type, locale: doc.locale, refs, readOnly: true }} data={revision.data} />
          </div>
        </section>
        <p>
          <a href={historyLink(doc.id)} class="link">
            {t('admin.history.backToList')}
          </a>
        </p>
      </>
    )
    const page = await adminPage(
      ctx,
      {
        title: t('admin.history.title', { title: doc.title }),
        actor,
        section,
        breadcrumbs: [...breadcrumbs, { label: doc.title, href: editorLink(doc.id) }, { label: t('admin.editor.history'), href: historyLink(doc.id) }],
        scripts: ['editor.js'],
      },
      body,
    )
    return send(reply, 200, page)
  })

  scope.post('/admin/documents/:id/history/:rev/restore', async (request, reply) => {
    const actor: Actor = adminActor(request)
    const { id, rev: rawRev } = request.params as { id: string; rev: string }
    const doc = await load(id)
    if (!doc || !REVISION.test(rawRev)) return notFound(reply, ctx, actor)
    try {
      await core.restoreRevision(doc.id, Number(rawRev), { actor, source: 'admin' })
    } catch (e) {
      if (e instanceof InlayError && (e.code === 'not_found' || e.code === 'invalid_operation')) return notFound(reply, ctx, actor)
      throw e
    }
    return reply.redirect(`${editorLink(doc.id)}?notice=restored`, 303)
  })
}
