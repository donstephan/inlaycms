import type { z } from 'zod'
import { DATE_CHECK, DATETIME_CHECK, INLINE_TEXT_MAX, NON_BLANK, TITLE_TEMPLATE_CHECK } from '../fields/builtins.js'
import { isRecord } from '../fields/zod-internals.js'
import { t, type MessageId } from '../messages/index.js'
import type { Registry } from '../registry/registry.js'
import type { ContentIssue, DocumentData, IssueCode, PathSegment } from '../types.js'
import { docLabels, documentSchema, type Level } from './schema.js'

export type ValidationResult = { ok: true; data: DocumentData } | { ok: false; issues: ContentIssue[] }

type ZodIssue = z.core.$ZodIssue

function valueAt(data: unknown, path: PathSegment[]): unknown {
  let current = data
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<PathSegment, unknown>)[segment]
  }
  return current
}

/** `value` with every object key whose value is `null` or `''` removed, at any depth. List elements are kept. */
function withoutBlanks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutBlanks)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (child !== null && child !== '') out[key] = withoutBlanks(child)
  }
  return out
}

/** The document with `null` and `''` in its fields and slot data treated as absent. */
function blanksRemoved(data: unknown): unknown {
  if (!isRecord(data)) return data
  const out = { ...data }
  if (isRecord(out.fields)) out.fields = withoutBlanks(out.fields)
  if (isRecord(out.slots)) {
    const slots: Record<string, unknown> = {}
    for (const [key, slot] of Object.entries(out.slots)) {
      slots[key] = isRecord(slot) && isRecord(slot.data) ? { ...slot, data: withoutBlanks(slot.data) } : slot
    }
    out.slots = slots
  }
  return out
}

const isRequired = (issue: ZodIssue, value: unknown): boolean =>
  value === undefined || (issue.code === 'custom' && issue.params?.check === NON_BLANK)

interface Mapped {
  code: IssueCode
  messageId: MessageId
  params: Record<string, string | number>
}

function bound(value: unknown): string | number {
  return typeof value === 'number' || typeof value === 'string' ? value : String(value)
}

/** The message for a value of the wrong type, by the type the field expects. */
const EXPECTED: Partial<Record<string, MessageId>> = {
  string: 'issue.expectedText',
  number: 'issue.expectedNumber',
  boolean: 'issue.expectedBoolean',
  array: 'issue.expectedList',
}

function mapIssue(issue: ZodIssue, value: unknown): Mapped {
  if (issue.code === 'too_big') {
    const max = bound(issue.maximum)
    if (issue.origin === 'string') return { code: 'too_long', messageId: 'issue.tooLong', params: { max } }
    if (issue.origin === 'array') return { code: 'too_many', messageId: 'issue.tooMany', params: { max } }
    if (issue.origin === 'number' || issue.origin === 'bigint') {
      return { code: 'out_of_range', messageId: 'issue.tooHigh', params: { max } }
    }
  }
  if (issue.code === 'custom' && issue.params?.check === INLINE_TEXT_MAX) {
    return { code: 'too_long', messageId: 'issue.tooLong', params: { max: bound(issue.params.max) } }
  }
  if (isRequired(issue, value)) return { code: 'required', messageId: 'issue.required', params: {} }
  if (issue.code === 'too_small') {
    const min = bound(issue.minimum)
    if (issue.origin === 'string') return { code: 'too_short', messageId: 'issue.tooShort', params: { min } }
    if (issue.origin === 'array') return { code: 'too_few', messageId: 'issue.tooFew', params: { min } }
    if (issue.origin === 'number' || issue.origin === 'bigint') {
      return { code: 'out_of_range', messageId: 'issue.tooLow', params: { min } }
    }
  }
  if (issue.code === 'custom' && issue.params?.check === DATE_CHECK) {
    return { code: 'invalid', messageId: 'issue.date', params: {} }
  }
  if (issue.code === 'custom' && issue.params?.check === DATETIME_CHECK) {
    return { code: 'invalid', messageId: 'issue.datetime', params: {} }
  }
  if (issue.code === 'custom' && issue.params?.check === TITLE_TEMPLATE_CHECK) {
    return { code: 'invalid', messageId: 'issue.titleTemplate', params: {} }
  }
  if (issue.code === 'invalid_type') {
    const messageId = EXPECTED[issue.expected]
    if (messageId) return { code: 'invalid', messageId, params: {} }
  }
  if (issue.code === 'invalid_value' && issue.values.every((v) => typeof v === 'string')) {
    return { code: 'invalid', messageId: 'issue.choice', params: { options: issue.values.join(', ') } }
  }
  return { code: 'invalid', messageId: 'issue.invalid', params: {} }
}

/** A plain-language issue for `path`, naming the field by its labels ("Hero → Headline is required."). */
export function contentIssue(
  path: PathSegment[],
  labels: string[],
  code: IssueCode,
  messageId: MessageId,
  params: Record<string, string | number> = {},
): ContentIssue {
  const field = labels.length > 0 ? labels.join(' → ') : t('label.content')
  return { path, labels, code, message: t(messageId, { ...params, field }) }
}

/** `first`, then each issue of `more` that isn't at or under the path of an issue already listed (general ones aside). */
export function mergeIssues(first: ContentIssue[], more: ContentIssue[]): ContentIssue[] {
  const out = [...first]
  const covered = (path: PathSegment[]) =>
    out.some((i) => i.path.length > 0 && i.path.every((segment, n) => path[n] === segment))
  for (const issue of more) if (!covered(issue.path)) out.push(issue)
  return out
}

/**
 * Validates `data` against `type` at `level`. A `null` or `''` value for a key
 * in fields or slot data counts as the key being absent. On success returns
 * the parsed data (defaults filled, unknown and blank keys stripped).
 */
export function validateContent(
  registry: Registry,
  type: string,
  data: unknown,
  level: Level,
): ValidationResult {
  const input = blanksRemoved(data)
  const result = documentSchema(registry, type, level).safeParse(input)
  if (result.success) return { ok: true, data: result.data }
  const issues = result.error.issues.map((issue) => {
    const path = issue.path.filter((s): s is PathSegment => typeof s !== 'symbol')
    const labels = docLabels(registry, type, path) ?? path.map(String)
    const { code, messageId, params } = mapIssue(issue, valueAt(input, path))
    return contentIssue(path, labels, code, messageId, params)
  })
  return { ok: false, issues }
}
