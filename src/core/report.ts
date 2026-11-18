import type { ShippedReport } from './content/shipped.js'
import { t } from './messages/index.js'
import type { ContentIssue } from './types.js'

export type ProblemCode = 'shipped_content' | 'release_import' | 'release_forbidden'

/** One thing that stops the database from being brought up to date. `message` is written for the developer. */
export interface CheckProblem {
  code: ProblemCode
  message: string
  issues?: ContentIssue[]
}

/** Something the developer should fix that doesn't stop boot. `message` is written for the developer. */
export type CheckWarning =
  | { code: 'slug_shadowed'; message: string; document: { id: string; type: string; locale: string; title: string } }
  | { code: 'redirect_hidden' | 'redirect_loop'; message: string; redirect: { from: string } }
  | { code: 'csp_unsafe_inline' | 'csp_unsafe_eval' | 'csp_script_scheme' | 'csp_overridden'; message: string }

/** What boot or `inlaycms check` did (or would do) to a database. */
export interface CheckReport {
  ok: boolean
  systemMigrations: string[]
  /** What applying shipped content did. */
  shipped: ShippedReport
  problems: CheckProblem[]
  warnings: CheckWarning[]
}

/** The report as lines a person reads: a summary, then one line per problem with its issues indented underneath. */
export function formatReport(report: CheckReport): string[] {
  const lines: string[] = []
  if (report.systemMigrations.length > 0) {
    lines.push(t('report.systemMigrations', { names: report.systemMigrations.join(', ') }))
  }
  const { created, replaced, skipped, deletedRefs } = report.shipped
  if (created.length > 0) lines.push(t('report.shippedCreated', { count: created.length }))
  if (replaced.length > 0) lines.push(t('report.shippedReplaced', { count: replaced.length }))
  if (skipped.length > 0) lines.push(t('report.shippedSkipped', { count: skipped.length }))
  for (const { item, target, field } of deletedRefs) {
    lines.push(
      t('report.shippedDeletedRefs', {
        type: item.type,
        key: item.key,
        locale: item.locale,
        field,
        targetType: target.type,
        targetKey: target.key,
      }),
    )
  }
  for (const warning of report.shipped.warnings) lines.push(t('report.warning', { message: warning.message }))
  if (report.ok && lines.length === 0) lines.push(t('report.upToDate'))
  for (const problem of report.problems) {
    lines.push(t('report.problem', { message: problem.message }))
    for (const issue of problem.issues ?? []) lines.push(t('report.issue', { message: issue.message }))
  }
  for (const warning of report.warnings) lines.push(t('report.warning', { message: warning.message }))
  return lines
}
