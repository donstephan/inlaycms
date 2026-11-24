import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { documentSchema } from '../../../core/content/schema.js'
import { t } from '../../../core/messages/index.js'
import type { SiteDefinition } from '../../../core/registry/define.js'
import type { ContentIssue, DocumentData, DocumentSummary, LiveDocument } from '../../../core/types.js'
import { escapeHtml } from '../../../jsx/html.js'
import { buildCsp } from '../../site/csp.js'
import { renderPane } from '../../site/render.js'
import { adminActor, formValues, HTML, notFound, type AdminContext } from '../context.js'
import { parseDocumentForm } from '../form/walk.js'

/** The address of a document's live preview pane. */
export const panePath = (id: string): string => `/admin/documents/${id}/preview`

/** An empty page with the pane's headers. Each update loads it into the hidden frame before writing the page into it, so the page's scripts start in a fresh window. */
export const blankPath = (id: string): string => `/admin/documents/${id}/preview/blank`

const FRAMED_BY_ADMIN = "frame-ancestors 'self'"

/** The response header a rendered pane page names its inline-script hashes in, for the empty page it is written into. */
export const HASHES_HEADER = 'x-inlay-script-hashes'

/** A hash as `ctx.script` writes it, without its quotes: the only thing the empty page takes into its policy. */
const HASH = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/
const MAX_HASHES = 64

/**
 * The pane's policy: the public page's, so a script the public site would refuse doesn't run beside the admin either,
 * and framed only by the admin. The pane renders no integrations, so none of their sources are allowed. A site that
 * sets its own policy gets that one; a site that removes the policy gets only the framing rule. Set only on pane
 * documents, so the admin's 404 page keeps the admin's.
 */
export function panePolicy(site: SiteDefinition, hashes: readonly string[]): string {
  const own = Object.entries(site.headers).find(([name]) => name.toLowerCase() === 'content-security-policy')?.[1]
  if (own === undefined) return buildCsp({ site: site.csp, integrations: [], hashes })
  if (own === false) return FRAMED_BY_ADMIN
  const kept = own
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !/^frame-ancestors(\s|$)/i.test(part))
  return [...kept, FRAMED_BY_ADMIN].join('; ')
}

/** The hashes the empty page was asked to allow (`?h=sha256-…`, once per hash), quoted for the policy. */
function askedHashes(query: unknown): string[] {
  const h = typeof query === 'object' && query !== null ? (query as { h?: unknown }).h : undefined
  const list = Array.isArray(h) ? h : h === undefined ? [] : [h]
  return list
    .filter((value): value is string => typeof value === 'string' && HASH.test(value))
    .slice(0, MAX_HASHES)
    .map((value) => `'${value}'`)
}

const BLANK = '<!doctype html><html><head><meta charset="utf-8"><title></title></head><body></body></html>'

/** The document's live (head) version when the editor shows a preview pane for it: its template has `render` and its live path is not null. */
export async function paneDocument(ctx: AdminContext, doc: DocumentSummary): Promise<LiveDocument | null> {
  const { core } = ctx
  if (!core.registry.getType(doc.type).template.render) return null
  const live = (await core.liveDocuments([doc.groupId], doc.locale, { state: 'preview' })).get(doc.groupId)
  if (!live || live.documentId !== doc.id || live.path === null) return null
  return live
}

const page = (title: string, items: string[] = []): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1>${
    items.length > 0 ? `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''
  }</body></html>`

export function registerPreviewPane(scope: FastifyInstance, ctx: AdminContext): void {
  const { core } = ctx
  const { registry } = core

  async function paneOf(id: string): Promise<LiveDocument | null> {
    const summary = await core.getDocument(id)
    if (!summary || summary.deletedAt !== null) return null
    return paneDocument(ctx, summary)
  }

  async function respond(
    request: FastifyRequest,
    reply: FastifyReply,
    submitted: boolean,
  ): Promise<FastifyReply> {
    const actor = adminActor(request)
    const { id } = request.params as { id: string }
    const live = await paneOf(id)
    if (!live) return notFound(reply, ctx, actor)
    reply.header('content-security-policy', panePolicy(registry.site, []))

    let data: DocumentData = live.data
    if (submitted) {
      const parsed = parseDocumentForm(registry, live.type, formValues(request))
      const result = documentSchema(registry, live.type, 'draft').safeParse(parsed)
      data = result.success ? result.data : parsed
    }

    const fail = (status: number, message: string, items?: string[]) =>
      submitted
        ? reply.code(status).type('application/json; charset=utf-8').send({ message })
        : reply.code(status === 422 ? 200 : status).type(HTML).send(page(message, items))

    try {
      const result = await renderPane(core, { ...live, data }, { page: 1, baseUrl: ctx.baseUrl })
      if (result.ok) {
        reply.header('content-security-policy', panePolicy(registry.site, result.scriptHashes))
        // Without their quotes: the client sends them back as they are, in the empty page's address.
        if (submitted) reply.header(HASHES_HEADER, result.scriptHashes.map((hash) => hash.slice(1, -1)).join(' '))
        return reply.code(200).type(HTML).send(result.html)
      }
      const issues: ContentIssue[] = result.issues
      const problem = issues[0]?.message ?? ''
      const message =
        issues.length > 1
          ? t('admin.preview.incompleteMore', { problem, n: issues.length - 1 })
          : t('admin.preview.incomplete', { problem })
      return fail(422, submitted ? message : t('admin.preview.notReady'), issues.map((i) => i.message))
    } catch (e) {
      request.log.error(e)
      return fail(500, t('admin.preview.failed'))
    }
  }

  scope.get('/admin/documents/:id/preview', (request, reply) => respond(request, reply, false))
  scope.post('/admin/documents/:id/preview', (request, reply) => respond(request, reply, true))
  scope.get('/admin/documents/:id/preview/blank', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!(await paneOf(id))) return notFound(reply, ctx, adminActor(request))
    return reply
      .code(200)
      .header('content-security-policy', panePolicy(registry.site, askedHashes(request.query)))
      .type(HTML)
      .send(BLANK)
  })
}
