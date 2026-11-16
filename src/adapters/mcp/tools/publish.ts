import { randomUUID } from 'node:crypto'
import {
  acceptedContent,
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type ClientCapabilities,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server'
import { z } from 'zod'
import { t } from '../../../core/messages/index.js'
import type { Ctx } from '../../../core/types.js'
import { pageUrl } from '../agent-refs.js'
import { DESTRUCTIVE, IDEMPOTENT_EDIT, livePath } from '../documents.js'
import { requestStateCodec } from '../request-state.js'
import { ok, tool } from '../results.js'
import type { McpDeps } from '../server.js'

type Action = 'publish' | 'unpublish'

/** What the user was asked to confirm, signed into the request state so the second call can't change it. */
interface ConfirmState {
  action: Action
  actorId: string | null
  ids: string[]
  /** Document id → the head revision the user saw. Only `publish` checks it. */
  expect: Record<string, number>
  message?: string
  /** Makes the state single-use: `deps.confirmations` remembers it once it has been answered. */
  nonce: string
}

const MAX_CHANGE_LINES = 3

const publishInput = z.object({
  ids: z.array(z.string()).min(1).max(50).describe(t('mcp.param.publishIds')),
  message: z.string().describe(t('mcp.param.message')).optional(),
})

const unpublishInput = z.object({
  ids: z.array(z.string()).min(1).max(50).describe(t('mcp.param.unpublishIds')),
})

const confirmSchema = z.object({ confirm: z.boolean().describe(t('mcp.confirm.field')) })

const COPY = {
  publish: {
    key: 'published',
    confirm: 'mcp.confirm.publish',
    declined: 'mcp.publishDeclined',
    byLink: 'mcp.confirmByLink',
    nothing: 'mcp.nothingToPublish',
  },
  unpublish: {
    key: 'unpublished',
    confirm: 'mcp.confirm.unpublish',
    declined: 'mcp.unpublishDeclined',
    byLink: 'mcp.confirmUnpublishByLink',
    nothing: 'mcp.nothingToUnpublish',
  },
} as const

/** Whether the client said, on this very request, that it can show a form to the user. */
function canElicit(mcpCtx: ServerContext): boolean {
  // The published typings declare the envelope as `{}`; its client-capabilities key holds `ClientCapabilities`.
  const envelope = mcpCtx.mcpReq.envelope as Partial<Record<string, ClientCapabilities>> | undefined
  const elicitation = envelope?.[CLIENT_CAPABILITIES_META_KEY]?.elicitation
  if (elicitation === undefined) return false
  return elicitation.form !== undefined || elicitation.url === undefined
}

/** The question the user is asked: a heading, then each document with its first few changes. */
async function confirmMessage(deps: McpDeps, action: Action, ids: string[]): Promise<string> {
  const lines = [t(COPY[action].confirm, { count: ids.length })]
  for (const { document, isNew, lines: changes } of await deps.core.describeChanges(ids)) {
    const item = { title: document.title, locale: document.locale }
    lines.push(isNew && action === 'publish' ? t('mcp.confirm.itemNew', item) : t('mcp.confirm.item', item))
    if (action === 'unpublish') continue
    for (const line of changes.slice(0, MAX_CHANGE_LINES)) lines.push(t('mcp.confirm.change', { line }))
    if (changes.length > MAX_CHANGE_LINES) lines.push(t('mcp.confirm.moreChanges'))
  }
  return lines.join('\n')
}

/** The page where the user can confirm in their browser instead. */
function confirmUrl(deps: McpDeps, action: Action, ids: string[]): string {
  return `${deps.baseUrl}/admin/publish?ids=${ids.map(encodeURIComponent).join(',')}&action=${action}`
}

/** Each document `ids` names, with its live URL after publishing. */
async function describeDone(deps: McpDeps, action: Action, ids: string[]) {
  const out = []
  for (const id of ids) {
    const doc = await deps.core.getDocument(id)
    if (!doc) continue
    const item = { id, title: doc.title, locale: doc.locale }
    if (action === 'unpublish') {
      out.push(item)
      continue
    }
    out.push({ ...item, url: pageUrl(deps.baseUrl, await livePath(deps, doc, 'published')) })
  }
  return out
}

/**
 * The second call: the user answered. Publishes exactly what the signed state says they were shown, once: the
 * state's nonce is used up before anything is published, and a state whose nonce was already used counts as declined.
 */
async function confirmed(deps: McpDeps, ctx: Ctx, state: ConfirmState, mcpCtx: ServerContext): Promise<CallToolResult> {
  const { action } = state
  const fresh = typeof state.nonce === 'string' && deps.confirmations.consume(state.nonce)
  const answer = acceptedContent(mcpCtx.mcpReq.inputResponses, 'confirm', confirmSchema)
  if (!fresh || answer?.confirm !== true) return ok({ [COPY[action].key]: [], note: t(COPY[action].declined) })
  const result =
    action === 'publish'
      ? await deps.core.publish(state.ids, ctx, {
          expect: state.expect,
          ...(state.message !== undefined && { message: state.message }),
        })
      : await deps.core.unpublish(state.ids, ctx)
  const done = result.items.map((item) => item.documentId)
  return ok({ [COPY[action].key]: await describeDone(deps, action, done) })
}

/** The first call: check everything with a dry run, then ask the user, or hand back a link. */
async function ask(
  deps: McpDeps,
  ctx: Ctx,
  action: Action,
  args: { ids: string[]; message?: string },
  mcpCtx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  const expect: Record<string, number> = {}
  if (action === 'publish') {
    for (const id of new Set(args.ids)) {
      const doc = await deps.core.getDocument(id)
      if (doc) expect[id] = doc.headRev
    }
  }
  const dry =
    action === 'publish'
      ? await deps.core.publish(args.ids, ctx, { dryRun: true, expect })
      : await deps.core.unpublish(args.ids, ctx, { dryRun: true })
  const ids = dry.items.map((item) => item.documentId)
  if (ids.length === 0) return ok({ [COPY[action].key]: [], note: t(COPY[action].nothing) })

  if (!canElicit(mcpCtx)) {
    return ok({ [COPY[action].key]: [], confirmUrl: confirmUrl(deps, action, ids), note: t(COPY[action].byLink) })
  }
  const state: ConfirmState = {
    action,
    actorId: ctx.actor.id,
    ids,
    expect: Object.fromEntries(ids.flatMap((id) => (expect[id] === undefined ? [] : [[id, expect[id]]]))),
    ...(args.message !== undefined && { message: args.message }),
    nonce: randomUUID(),
  }
  return inputRequired({
    inputRequests: {
      confirm: inputRequired.elicit({
        message: await confirmMessage(deps, action, ids),
        requestedSchema: confirmSchema,
      }),
    },
    requestState: await requestStateCodec<ConfirmState>(deps.secret).mint(state),
  })
}

async function run(
  deps: McpDeps,
  ctx: Ctx,
  action: Action,
  args: { ids: string[]; message?: string },
  mcpCtx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  const answered = inputResponse(mcpCtx.mcpReq.inputResponses, 'confirm').kind !== 'missing'
  // The state was verified (signature and expiry) before the handler ran; it must also be this tool's, for this user.
  const state = mcpCtx.mcpReq.requestState<ConfirmState>()
  if (answered && state?.action === action && state.actorId === ctx.actor.id) {
    return confirmed(deps, ctx, state, mcpCtx)
  }
  return ask(deps, ctx, action, args, mcpCtx)
}

/** `publish` and `unpublish`: both need the user's confirmation, through elicitation or the publish page. */
export function register(server: McpServer, deps: McpDeps, ctx: Ctx): void {
  server.registerTool(
    'publish',
    {
      title: t('mcp.tool.publish.title'),
      description: t('mcp.tool.publish.description'),
      inputSchema: publishInput,
      annotations: IDEMPOTENT_EDIT,
    },
    tool<z.infer<typeof publishInput>, ServerContext>((args, mcpCtx) => run(deps, ctx, 'publish', args, mcpCtx), deps.log),
  )
  server.registerTool(
    'unpublish',
    {
      title: t('mcp.tool.unpublish.title'),
      description: t('mcp.tool.unpublish.description'),
      inputSchema: unpublishInput,
      annotations: DESTRUCTIVE,
    },
    tool<z.infer<typeof unpublishInput>, ServerContext>((args, mcpCtx) => run(deps, ctx, 'unpublish', args, mcpCtx), deps.log),
  )
}
