import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { contentIssue } from '../../../core/content/validate.js'
import { InlayError } from '../../../core/errors.js'
import { t } from '../../../core/messages/index.js'
import type { Ctx, Redirect } from '../../../core/types.js'
import { DESTRUCTIVE, EDIT, READ_ONLY } from '../documents.js'
import { ok, tool } from '../results.js'
import type { McpDeps } from '../server.js'

const createInput = z.object({
  from: z.string().describe(t('mcp.param.redirectFrom')),
  to: z.union([z.string(), z.object({ document: z.string() })]).describe(t('mcp.param.redirectTo')),
  status: z.union([z.literal(301), z.literal(302)]).describe(t('mcp.param.redirectStatus')).optional(),
  note: z.string().describe(t('mcp.param.redirectNote')).optional(),
})

const deleteInput = z.object({ id: z.number().int().describe(t('mcp.param.redirectId')) })

/** Redirects as tools show them; document targets carry the document's title (`null` if it has none). */
async function redirectsJson(deps: McpDeps, redirects: Redirect[]) {
  const groupIds = redirects.flatMap((r) => ('document' in r.to ? [r.to.document] : []))
  const live =
    groupIds.length === 0
      ? new Map()
      : await deps.core.liveDocuments(groupIds, deps.core.registry.defaultLocale, { state: 'preview' })
  return redirects.map(({ id, from, to, status, source, note }) => ({
    id,
    from,
    to: 'document' in to ? { document: to.document, title: live.get(to.document)?.title ?? null } : 'url' in to ? to.url : to.path,
    status,
    source,
    note,
  }))
}

/** Refuses a document id where the target's `groupId` belongs, naming the right one. */
async function checkGroupId(deps: McpDeps, id: string): Promise<void> {
  const doc = await deps.core.getDocument(id)
  if (!doc || doc.groupId === id) return
  const issue = contentIssue(['to'], [t('label.redirect.to')], 'invalid', 'mcp.useGroupId', { id, groupId: doc.groupId })
  throw new InlayError('validation', 'error.redirectInvalid', {}, { issues: [issue] })
}

/** `list_redirects`, `create_redirect` and `delete_redirect`. */
export function register(server: McpServer, deps: McpDeps, ctx: Ctx): void {
  const run = <A>(fn: (args: A) => Promise<unknown>) => tool<A, unknown>(async (args) => ok(await fn(args)), deps.log)

  server.registerTool(
    'list_redirects',
    {
      title: t('mcp.tool.list_redirects.title'),
      description: t('mcp.tool.list_redirects.description'),
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    run(async () => {
      const admin = await redirectsJson(deps, await deps.core.listRedirects())
      const code = (await deps.core.listCodeRedirects()).map(({ from, to, status, overridden, hidden }) => ({
        id: null,
        from,
        to: 'url' in to ? to.url : to.path,
        status,
        source: 'code' as const,
        note: null,
        readOnly: true,
        overridden,
        hidden,
      }))
      return { redirects: [...admin, ...code] }
    }),
  )
  server.registerTool(
    'create_redirect',
    {
      title: t('mcp.tool.create_redirect.title'),
      description: t('mcp.tool.create_redirect.description'),
      inputSchema: createInput,
      annotations: EDIT,
    },
    run(async (args: z.infer<typeof createInput>) => {
      if (typeof args.to === 'object') await checkGroupId(deps, args.to.document)
      const created = await deps.core.createRedirect(
        {
          from: args.from,
          to: args.to,
          ...(args.status !== undefined && { status: args.status }),
          ...(args.note !== undefined && { note: args.note }),
        },
        ctx,
      )
      const [redirect] = await redirectsJson(deps, [created])
      if (!redirect) throw new InlayError('not_found', 'error.redirectNotFound')
      return redirect
    }),
  )
  server.registerTool(
    'delete_redirect',
    {
      title: t('mcp.tool.delete_redirect.title'),
      description: t('mcp.tool.delete_redirect.description'),
      inputSchema: deleteInput,
      annotations: DESTRUCTIVE,
    },
    run(async (args: z.infer<typeof deleteInput>) => {
      await deps.core.deleteRedirect(args.id, ctx)
      return { deleted: args.id }
    }),
  )
}
