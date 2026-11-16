import type { ImportReport } from './export/report.js'
import type { CheckProblem } from './report.js'
import type { ContentIssue, Usage } from './types.js'
import { t, type MessageId } from './messages/index.js'

export type ErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'validation'
  | 'in_use'
  | 'invalid_operation'
  | 'definition'
  | 'shipped_content'
  | 'check_failed'
  | 'config'
  | 'release'
  | 'read_only'

export interface InlayErrorDetails {
  issues?: ContentIssue[]
  usages?: Usage[]
  documents?: Array<{ documentId: string; title: string; issues: ContentIssue[] }>
  problems?: CheckProblem[]
  lines?: Array<{ line: number; message: string }>
  importReport?: ImportReport
}

export class InlayError extends Error {
  code: ErrorCode
  messageId: MessageId
  params: Record<string, string | number>
  details: InlayErrorDetails

  constructor(
    code: ErrorCode,
    messageId: MessageId,
    params: Record<string, string | number> = {},
    details: InlayErrorDetails = {},
  ) {
    super(t(messageId, params))
    this.name = 'InlayError'
    this.code = code
    this.messageId = messageId
    this.params = params
    this.details = details
  }
}
