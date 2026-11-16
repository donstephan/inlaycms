import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { formatDiff } from '../../../core/content/diff.js'
import { InlayError } from '../../../core/errors.js'
import { t } from '../../../core/messages/index.js'
import type { Ctx } from '../../../core/types.js'
import { previewLink } from '../../site/preview.js'
import { documentOf, EDIT, livePath, READ_ONLY } from '../documents.js'
import { ok, tool } from '../results.js'
import type { McpDeps } from '../server.js'

const listInput = z.object({
  id: z.string().describe(t('mcp.param.id')),
  limit: z.number().int().min(1).max(100).describe(t('mcp.param.revisionsLimit')).optional(),
})

const diffInput = z.object({
  from: z.number().int().describe(t('mcp.param.diffFrom')).optional(),
  to: z.number().int().describe(t('mcp.param.diffTo')),
})

const restoreInput = z.object({
  id: z.string().describe(t('mcp.param.id')),
  revisionId: z.number().int().describe(t('mcp.param.restoreRevisionId')),
  message: z.string().describe(t('mcp.param.message')).optional(),
})

async function listRevisions(deps: McpDeps, args: z.infer<typeof listInput>) {
  const doc = await documentOf(deps, args.id)
  const revisions = (await deps.core.listRevisions(doc.id)).sort((a, b) => b.id - a.id).slice(0, args.limit ?? 20)
  return {
    revisions: revisions.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      author: r.authorName,
      source: r.source,
      message: r.message,
      isHead: r.id === doc.headRev,
      isPublished: r.id === doc.publishedRev,
    })),
  }
}

async function diffRevisions(deps: McpDeps, args: z.infer<typeof diffInput>) {
  for (const revisionId of [args.from, args.to]) {
    if (revisionId !== undefined && !(await deps.core.getRevision(revisionId))) {
      throw new InlayError('not_found', 'mcp.revisionNotFound', { revisionId })
    }
  }
  return { changes: formatDiff(await deps.core.diffRevisions(args.from ?? null, args.to)) }
}

async function restoreRevision(deps: McpDeps, args: z.infer<typeof restoreInput>, ctx: Ctx) {
  const doc = await documentOf(deps, args.id)
  const revision = await deps.core.getRevision(args.revisionId)
  if (!revision || revision.documentId !== doc.id) {
    throw new InlayError('not_found', 'mcp.revisionNotFound', { revisionId: args.revisionId })
  }
  const result = await deps.core.restoreRevision(doc.id, args.revisionId, ctx, {
    ...(args.message !== undefined && { message: args.message }),
  })
  const { document } = result
  const path = await livePath(deps, document)
  return {
    id: document.id,
    revisionId: document.headRev,
    changed: result.changed,
    changes: formatDiff(result.diff),
    previewUrl: previewLink(deps, path ?? '/'),
  }
}

/** `list_revisions`, `diff_revisions` and `restore_revision`. */
export function register(server: McpServer, deps: McpDeps, ctx: Ctx): void {
  const run = <A>(fn: (args: A) => Promise<unknown>) => tool<A, unknown>(async (args) => ok(await fn(args)), deps.log)

  server.registerTool(
    'list_revisions',
    {
      title: t('mcp.tool.list_revisions.title'),
      description: t('mcp.tool.list_revisions.description'),
      inputSchema: listInput,
      annotations: READ_ONLY,
    },
    run((args: z.infer<typeof listInput>) => listRevisions(deps, args)),
  )
  server.registerTool(
    'diff_revisions',
    {
      title: t('mcp.tool.diff_revisions.title'),
      description: t('mcp.tool.diff_revisions.description'),
      inputSchema: diffInput,
      annotations: READ_ONLY,
    },
    run((args: z.infer<typeof diffInput>) => diffRevisions(deps, args)),
  )
  server.registerTool(
    'restore_revision',
    {
      title: t('mcp.tool.restore_revision.title'),
      description: t('mcp.tool.restore_revision.description'),
      inputSchema: restoreInput,
      annotations: EDIT,
    },
    run((args: z.infer<typeof restoreInput>) => restoreRevision(deps, args, ctx)),
  )
}
