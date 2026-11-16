import type { ToolAnnotations } from '@modelcontextprotocol/server'
import { InlayError } from '../../core/errors.js'
import type { DocumentSummary, DocumentView, LiveState } from '../../core/types.js'
import type { McpDeps } from './server.js'

/** Reads only. */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
/** Adds or changes something; repeating the call does it again. */
export const EDIT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
/** Changes something; repeating the call changes nothing more. */
export const IDEMPOTENT_EDIT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
/** Removes something, or takes it off the site. */
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }

/** The head of document `id`, or a plain `not_found`. */
export async function documentOf(deps: Pick<McpDeps, 'core'>, id: string): Promise<DocumentView> {
  const doc = await deps.core.getDocument(id)
  if (!doc || doc.deletedAt !== null) throw new InlayError('not_found', 'mcp.documentNotFound', { id })
  return doc
}

/** The document's site path in `state` (preview by default), or `null` when it has no page of its own there. */
export async function livePath(
  deps: Pick<McpDeps, 'core'>,
  doc: Pick<DocumentSummary, 'id' | 'groupId' | 'locale'>,
  state: LiveState = 'preview',
): Promise<string | null> {
  const live = (await deps.core.liveDocuments([doc.groupId], doc.locale, { state })).get(doc.groupId)
  return live && live.documentId === doc.id ? live.path : null
}
