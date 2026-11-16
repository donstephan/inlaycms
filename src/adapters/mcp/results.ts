import type { CallToolResult, InputRequiredResult } from '@modelcontextprotocol/server'
import { InlayError } from '../../core/errors.js'
import { t } from '../../core/messages/index.js'
import type { ContentIssue, Usage } from '../../core/types.js'

/** Where unexpected tool failures are reported. */
export type ErrorLog = (err: unknown) => void

/** A successful result: `value` as a single JSON text block. */
export function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

export type IssueJson = { field: string; path: string; message: string }

/** An issue as tools report it: its field's labels, its dotted path and its message. */
export function issueJson(issue: ContentIssue, prefix: string[] = []): IssueJson {
  const labels = [...prefix, ...issue.labels]
  return {
    field: labels.length > 0 ? labels.join(' → ') : t('label.content'),
    path: issue.path.join('.'),
    message: issue.message,
  }
}

const issueLine = (issue: IssueJson): string =>
  issue.path === '' ? t('mcp.issueGeneral', { message: issue.message }) : t('mcp.issue', issue)

const USAGE_STATE = { draft: 'mcp.usage.draft', published: 'mcp.usage.published', 'draft-and-published': 'mcp.usage.both' } as const

const usageLine = (u: Usage): string =>
  t('mcp.usage', { state: t(USAGE_STATE[u.in]), title: u.title, locale: u.locale, id: u.documentId })

/**
 * A failed result (`isError`): the catalog message, one line per issue and per usage, then the JSON
 * `{ error: { code, message, issues, usages } }`. Anything but an `InlayError` gives a generic message and is logged.
 */
export function toolError(e: unknown, log: ErrorLog): CallToolResult {
  if (!(e instanceof InlayError)) {
    log(e)
    const message = t('mcp.unexpected')
    return { isError: true, content: [{ type: 'text', text: `${message}\n${JSON.stringify({ error: { code: 'unexpected', message } })}` }] }
  }
  const { details } = e
  const issues = [
    ...(details.issues ?? []).map((issue) => issueJson(issue)),
    ...(details.documents ?? []).flatMap((doc) => doc.issues.map((issue) => issueJson(issue, [doc.title]))),
  ]
  const usages = (details.usages ?? []).map((u) => ({
    id: u.documentId,
    groupId: u.groupId,
    type: u.type,
    locale: u.locale,
    title: u.title,
    in: u.in,
  }))
  const lines = [
    e.message,
    ...issues.map(issueLine),
    ...(details.lines ?? []).map((l) => t('mcp.issueGeneral', { message: t('import.line', l) })),
    ...(details.usages ?? []).map(usageLine),
    JSON.stringify({ error: { code: e.code, message: e.message, issues, usages } }),
  ]
  return { isError: true, content: [{ type: 'text', text: lines.join('\n') }] }
}

/** Wraps a tool handler so anything it throws becomes a `toolError` result. */
export function tool<A, C>(
  fn: (args: A, ctx: C) => Promise<CallToolResult | InputRequiredResult>,
  log: ErrorLog,
): (args: A, ctx: C) => Promise<CallToolResult | InputRequiredResult> {
  return async (args, ctx) => {
    try {
      return await fn(args, ctx)
    } catch (e) {
      return toolError(e, log)
    }
  }
}
