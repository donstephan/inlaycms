import type { McpServer, ToolAnnotations } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { createUploadToken, UPLOAD_TTL_MS } from '../../../core/auth/upload-token.js'
import { InlayError } from '../../../core/errors.js'
import { t } from '../../../core/messages/index.js'
import type { Ctx, MediaInfo } from '../../../core/types.js'
import { mediaUrl } from '../agent-refs.js'
import { DESTRUCTIVE, IDEMPOTENT_EDIT, READ_ONLY } from '../documents.js'
import { ok, tool } from '../results.js'
import type { McpDeps } from '../server.js'

const FETCH: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
const LINK: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }

const listMediaInput = z.object({
  kind: z.enum(['image', 'file']).describe(t('mcp.param.mediaKind')).optional(),
  search: z.string().describe(t('mcp.param.mediaSearch')).optional(),
  limit: z.number().int().min(1).max(100).describe(t('mcp.param.mediaLimit')).optional(),
  offset: z.number().int().min(0).describe(t('mcp.param.mediaOffset')).optional(),
})

const setMediaAltInput = z.object({
  id: z.string().describe(t('mcp.param.mediaId')),
  alt: z.string().nullable().describe(t('mcp.param.alt')),
})

const deleteMediaInput = z.object({ id: z.string().describe(t('mcp.param.mediaId')) })

const uploadFromUrlInput = z.object({
  url: z.string().describe(t('mcp.param.url')),
  filename: z.string().describe(t('mcp.param.filename')).optional(),
  alt: z.string().describe(t('mcp.param.uploadAlt')).optional(),
})

/** A media file as tools show it, with its address. */
function mediaJson(deps: McpDeps, media: MediaInfo) {
  const { id, filename, mime, size, width, height, defaultAlt } = media
  return { id, filename, mime, size, width, height, defaultAlt, url: mediaUrl(deps.baseUrl, id) }
}

async function listMedia(deps: McpDeps, args: z.infer<typeof listMediaInput>) {
  const media = await deps.core.listMedia({
    ...(args.kind !== undefined && { kind: args.kind }),
    ...(args.search !== undefined && { search: args.search }),
    limit: args.limit ?? 30,
    offset: args.offset ?? 0,
  })
  return { media: media.map((m) => mediaJson(deps, m)) }
}

async function deleteMedia(deps: McpDeps, args: z.infer<typeof deleteMediaInput>, ctx: Ctx) {
  const media = await deps.core.getMedia(args.id)
  if (!media) throw new InlayError('not_found', 'error.mediaNotFound')
  await deps.core.deleteMedia(args.id, ctx)
  return { deleted: { id: media.id, filename: media.filename } }
}

/** Adds the file at `args.url`. `alt` is set on a new file, or on a reused one without alt text; one with its own keeps it. */
async function uploadFromUrl(deps: McpDeps, args: z.infer<typeof uploadFromUrlInput>, ctx: Ctx) {
  const file = await deps.fetchFile(args.url, { maxBytes: deps.uploads.maxBytes })
  const added = await deps.core.addMedia({ data: file.data, filename: args.filename ?? file.filename }, ctx)
  const media =
    args.alt === undefined || (added.reused && added.media.defaultAlt !== null)
      ? added.media
      : await deps.core.setMediaAlt(added.media.id, args.alt, ctx)
  return { media: mediaJson(deps, media), reused: added.reused }
}

/** A link to `/admin/upload` that lets whoever opens it upload as this user for an hour. */
function requestUpload(deps: McpDeps, ctx: Ctx) {
  if (ctx.actor.id === null) throw new InlayError('forbidden', 'error.forbidden')
  // Upload links run on the real clock, like the rest of authentication; the page checks them the same way.
  const now = new Date()
  const token = createUploadToken(deps.secret, ctx.actor.id, now)
  return {
    uploadUrl: `${deps.baseUrl}/admin/upload?token=${encodeURIComponent(token)}`,
    expiresAt: new Date(now.getTime() + UPLOAD_TTL_MS).toISOString(),
    note: t('mcp.uploadNote'),
  }
}

/** `list_media`, `set_media_alt`, `delete_media`, `upload_media_from_url` and `request_media_upload`. */
export function register(server: McpServer, deps: McpDeps, ctx: Ctx): void {
  const run = <A>(fn: (args: A) => Promise<unknown> | unknown) =>
    tool<A, unknown>(async (args) => ok(await fn(args)), deps.log)

  server.registerTool(
    'list_media',
    {
      title: t('mcp.tool.list_media.title'),
      description: t('mcp.tool.list_media.description'),
      inputSchema: listMediaInput,
      annotations: READ_ONLY,
    },
    run((args: z.infer<typeof listMediaInput>) => listMedia(deps, args)),
  )
  server.registerTool(
    'set_media_alt',
    {
      title: t('mcp.tool.set_media_alt.title'),
      description: t('mcp.tool.set_media_alt.description'),
      inputSchema: setMediaAltInput,
      annotations: IDEMPOTENT_EDIT,
    },
    run(async (args: z.infer<typeof setMediaAltInput>) => mediaJson(deps, await deps.core.setMediaAlt(args.id, args.alt, ctx))),
  )
  server.registerTool(
    'delete_media',
    {
      title: t('mcp.tool.delete_media.title'),
      description: t('mcp.tool.delete_media.description'),
      inputSchema: deleteMediaInput,
      annotations: DESTRUCTIVE,
    },
    run((args: z.infer<typeof deleteMediaInput>) => deleteMedia(deps, args, ctx)),
  )
  server.registerTool(
    'upload_media_from_url',
    {
      title: t('mcp.tool.upload_media_from_url.title'),
      description: t('mcp.tool.upload_media_from_url.description'),
      inputSchema: uploadFromUrlInput,
      annotations: FETCH,
    },
    run((args: z.infer<typeof uploadFromUrlInput>) => uploadFromUrl(deps, args, ctx)),
  )
  server.registerTool(
    'request_media_upload',
    {
      title: t('mcp.tool.request_media_upload.title'),
      description: t('mcp.tool.request_media_upload.description'),
      inputSchema: z.object({}),
      annotations: LINK,
    },
    run(() => requestUpload(deps, ctx)),
  )
}
