import type { Selectable } from 'kysely'
import { assertCan } from '../auth/roles.js'
import { whereVisible } from '../content/read.js'
import { contentIssue } from '../content/validate.js'
import type { DocumentsTable, RedirectsTable } from '../db/schema.js'
import { InlayError } from '../errors.js'
import { t, type MessageId } from '../messages/index.js'
import { resolveWithoutRules } from '../site/resolve.js'
import { encodePath, isReserved, normalizePath, splitLocale, withLocale } from '../site/paths.js'
import type { Registry } from '../registry/registry.js'
import type { ContentIssue, CoreDeps, Ctx, IssueCode, LiveState, Redirect, RedirectInput, RouteMatch } from '../types.js'
import { sitePath } from '../site/live.js'
import {
  collapseTargets,
  fillParams,
  hasLocalePrefix,
  isPattern,
  localize,
  paramNames,
  pathTarget,
  patternRegExp,
  ruleCandidates,
  ruleIndex,
  type RuleIndex,
  type RuleTarget,
} from './collapse.js'
import { parseCsv } from './csv.js'
import { withTransaction } from '../content/dry-run.js'

type Row = Selectable<RedirectsTable>
type Field = 'from' | 'to' | 'status'

const LABELS: Record<Field, MessageId> = {
  from: 'label.redirect.from',
  to: 'label.redirect.to',
  status: 'label.redirect.status',
}

export function rowTarget(row: Pick<Row, 'to_path' | 'to_group_id'>): RuleTarget {
  return row.to_group_id !== null ? { document: row.to_group_id } : { path: row.to_path ?? '/' }
}

function toRedirect(row: Row): Redirect {
  return {
    id: row.id,
    from: row.from_path,
    to: rowTarget(row),
    status: row.status,
    source: row.source,
    note: row.note,
    createdBy: row.created_by_name,
    createdAt: row.created_at,
  }
}

export async function listRedirects(deps: CoreDeps): Promise<Redirect[]> {
  const rows = await deps.db.selectFrom('redirects').selectAll().orderBy('from_path').orderBy('id').execute()
  return rows.map(toRedirect)
}

const ORIGIN = /^https?:\/\/[^/?#]*/i

/** A clean decoded site path without a query or fragment, or `null`. */
export function cleanPath(raw: string): string | null {
  const path = normalizePath(raw)
  return path === null || path.includes('?') || path.includes('#') ? null : path
}

/**
 * The stored form of a redirect's `from` (a full http(s) URL loses its origin), or `null` if it can't be
 * used. A default-locale prefix can't be used: such a request is sent to the unprefixed path first.
 */
export function redirectFrom(registry: Registry, raw: string): string | null {
  const trimmed = raw.trim()
  const stripped = trimmed.replace(ORIGIN, '')
  const path = cleanPath(stripped === '' && stripped !== trimmed ? '/' : stripped)
  if (path === null || isReserved(path) || path.split('/')[1] === registry.defaultLocale) return null
  const names = paramNames(path)
  return new Set(names).size === names.length ? path : null
}

function isRoutable(deps: CoreDeps, target: { kind: string; type: string }): boolean {
  const def = deps.registry.types.get(target.type)
  if (!def) return false
  if (target.kind === 'singleton') return def.kind === 'singleton' && def.path !== null
  if (target.kind === 'entry') return def.kind === 'collection' && def.route !== null
  return false
}

/**
 * What a path resolves to without redirect rules, memoized for the duration of one write. A path is
 * a stop when this isn't `not_found`: a redirect rule never fires there.
 */
export type Lookup = (path: string, state?: LiveState) => Promise<RouteMatch['kind']>

function lookup(deps: CoreDeps): Lookup {
  const memo = new Map<string, RouteMatch['kind']>()
  return async (path, state = 'published') => {
    const key = `${state} ${path}`
    let kind = memo.get(key)
    if (kind === undefined) {
      kind = (await resolveWithoutRules(deps, encodePath(path), { state })).kind
      memo.set(key, kind)
    }
    return kind
  }
}

/** Whether an exact `from` is the path of a published page in any locale it matches in. */
async function isLivePage(registry: Registry, look: Lookup, from: string): Promise<boolean> {
  const paths =
    splitLocale(registry, from).locale === registry.defaultLocale
      ? registry.locales.map((l) => withLocale(registry, l, from))
      : [from]
  for (const p of paths) {
    if ((await look(p)) === 'page') return true
  }
  return false
}

export interface CheckedRule {
  from: string
  to: RuleTarget
  status: 301 | 302
  note: string | null
}

/**
 * Checks a rule on its own (not against other rules): the shape of `from`
 * and `to` (neither may start with the default locale, which a request is
 * sent away from first), the status, and that an exact `from` isn't a
 * published page.
 */
export async function checkRedirect(
  deps: CoreDeps,
  input: RedirectInput,
  look: Lookup = lookup(deps),
): Promise<{ rule: CheckedRule | null; issues: ContentIssue[] }> {
  const issues: ContentIssue[] = []
  const issue = (at: Field, code: IssueCode, messageId: MessageId, params: Record<string, string | number> = {}) =>
    issues.push(contentIssue([at], [t(LABELS[at])], code, messageId, params))

  const from = redirectFrom(deps.registry, input.from)
  if (from === null) issue('from', 'invalid', 'issue.redirectFrom', { path: input.from })
  else if (!isPattern(from) && (await isLivePage(deps.registry, look, from))) {
    issue('from', 'path_taken', 'issue.redirectLivePath', { path: from })
  }

  let to: RuleTarget | null = null
  if (typeof input.to === 'string') {
    const path = cleanPath(input.to.trim())
    const locale = deps.registry.defaultLocale
    if (path === null) issue('to', 'invalid', 'issue.redirectTo', { path: input.to })
    else if (path.split('/')[1] === locale) issue('to', 'invalid', 'issue.redirectToDefaultLocale', { path, locale })
    else {
      const allowed = from === null ? [] : paramNames(from)
      const missing = paramNames(path).find((n) => !allowed.includes(n))
      if (missing !== undefined) issue('to', 'invalid', 'issue.redirectParam', { name: missing })
      else to = { path }
    }
  } else {
    const group = input.to.document
    const target = await deps.db
      .selectFrom('documents')
      .select(['kind', 'type'])
      .where('group_id', '=', group)
      .where('deleted_at', 'is', null)
      .$call(whereVisible(deps.registry))
      .executeTakeFirst()
    if (!target) issue('to', 'not_found', 'issue.notFound')
    else if (!isRoutable(deps, target)) issue('to', 'not_routable', 'issue.notRoutable')
    else to = { document: group }
  }

  const status = input.status ?? 301
  if (status !== 301 && status !== 302) issue('status', 'invalid', 'issue.redirectStatus')

  const note = input.note?.trim() || null
  const rule = from !== null && to !== null && issues.length === 0 ? { from, to, status, note } : null
  return { rule, issues }
}

function columns(to: RuleTarget): { to_path: string | null; to_group_id: string | null } {
  return 'path' in to ? { to_path: to.path, to_group_id: null } : { to_path: null, to_group_id: to.document }
}

function invalid(issues: ContentIssue[]): InlayError {
  return new InlayError('validation', 'error.redirectInvalid', {}, { issues })
}

const MAX_HOPS = 32
/** Starts each sample param value when walking a pattern: it matches any param but no exact rule or page. */
const SAMPLE = '\u0000'

type Rule = { id: number | null; from: string; to: RuleTarget }

/** A rule being written: `to` is what was asked for; `settle` sets where it is stored. */
type Incoming = Rule & { blame: number }

function ruleOf(row: Row): Rule {
  return { id: row.id, from: row.from_path, to: rowTarget(row) }
}

/**
 * Settles a write of `incoming` rules over `rules` (every other rule, in id order, with any incoming
 * rule that updates one in its place and new ones last, as they would be numbered). Each incoming
 * exact path target is collapsed through exact rules, and existing rules whose target is an incoming
 * exact `from` are re-pointed to where that rule goes. Then every changed rule is walked as requests
 * would follow it. Rules are changed in place; `repointed` lists the existing ones that changed and
 * `loops` the `blame` of every incoming rule whose write would make a loop.
 */
async function settle(
  deps: CoreDeps,
  look: Lookup,
  rules: Rule[],
  incoming: Incoming[],
): Promise<{ repointed: Rule[]; loops: Set<number> }> {
  const { registry } = deps
  const others = registry.locales.filter((l) => l !== registry.defaultLocale)
  const before = ruleIndex(rules)
  const isStop = async (path: string, state: LiveState) => (await look(path, state)) !== 'not_found'

  /** Whether a request for `path` reaches its exact rule in every locale and state the rule fires in. */
  const reaches = async (path: string): Promise<boolean> => {
    if ((await isStop(path, 'published')) || (await isStop(path, 'preview'))) return false
    if (splitLocale(registry, path).locale !== registry.defaultLocale) return true
    for (const l of others) {
      const p = withLocale(registry, l, path)
      if (before.exact.has(p) || (await isStop(p, 'published')) || (await isStop(p, 'preview'))) return false
    }
    return true
  }
  /** Whether a rule from `from` to `path` may be stored as going straight on to `next` instead. */
  const canFollow = async (path: string, next: RuleTarget, from: string): Promise<boolean> =>
    sameHop(registry, from, path, next) && (await reaches(path))

  const settled = await collapseTargets(before.exact, incoming, canFollow, (from) => hopScope(registry, from))
  incoming.forEach((r, i) => (r.to = settled[i]!))

  const changed = new Set<Rule>(incoming)
  const blame = new Map<Rule, number>(incoming.map((r) => [r, r.blame]))
  const byTarget = new Map<string, Rule[]>()
  for (const r of rules) {
    if (!('path' in r.to) || changed.has(r)) continue
    const pointing = byTarget.get(r.to.path) ?? []
    pointing.push(r)
    byTarget.set(r.to.path, pointing)
  }
  const repointed: Rule[] = []
  for (const r of incoming) {
    const pointing = byTarget.get(r.from)
    if (!pointing || isPattern(r.from) || !(await reaches(r.from))) continue
    for (const p of pointing) {
      if (('path' in r.to && r.to.path === p.from) || !sameHop(registry, p.from, r.from, r.to)) continue
      p.to = r.to
      repointed.push(p)
      changed.add(p)
      blame.set(p, r.blame)
    }
  }

  const index = ruleIndex(rules)
  const loops = new Set<number>()
  let starts: Map<string, string[]> | undefined
  const startsAt = () => (starts ??= startsOf(registry, rules))
  for (const rule of changed) {
    for (const start of walkStarts(registry, rule, startsAt)) {
      const trail = walk(registry, index, rule, start)
      if (trail && !(await someAsync(trail, (p) => isStop(p, 'published')))) {
        loops.add(blame.get(rule)!)
        break
      }
    }
  }
  return { repointed, loops }
}

/** What `sameHop` depends on in a rule's `from`: its locale, and whether its first segment is a param. */
function hopScope(registry: Registry, from: string): string {
  return `${splitLocale(registry, from).locale}${isPattern(`/${from.split('/')[1] ?? ''}`) ? ':' : ''}`
}

/**
 * Whether a rule from `from` to the exact path `path` sends every request it answers to the same
 * place when it goes straight to `next`, the target of the rule at `path`. A rule matched through
 * the unprefixed rest of a request gives an unprefixed target the request's locale, and a document
 * target resolves in the locale of the request it answers, so the hop through `path` may change that
 * locale. A target that names a locale lands the same either way.
 */
function sameHop(registry: Registry, from: string, path: string, next: RuleTarget): boolean {
  if ('path' in next && hasLocalePrefix(registry, next.path)) return true
  const fromLocale = splitLocale(registry, from).locale
  const pathLocale = splitLocale(registry, path).locale
  const fromPrefixed = fromLocale !== registry.defaultLocale
  const pathPrefixed = pathLocale !== registry.defaultLocale
  if ('path' in next) return fromPrefixed || !pathPrefixed
  if (hopScope(registry, from).endsWith(':')) return false
  return fromPrefixed ? fromLocale === pathLocale : !pathPrefixed
}

async function someAsync<T>(items: T[], test: (item: T) => Promise<boolean>): Promise<boolean> {
  for (const item of items) if (await test(item)) return true
  return false
}

/** The keys `startsOf` files a path under: its segment count, and that with its first segment. */
function startKeys(path: string): string[] {
  const parts = path.split('/')
  return [`${parts.length}`, `${parts.length} ${parts[1] ?? ''}`]
}

/**
 * The concrete paths a rule's path target can send a request to, in every locale the rule fires in
 * when its `from` is unprefixed, keyed by segment count and by segment count and first segment (of
 * the path, and of its unprefixed rest). A pattern rule can be reached at these as well as at samples.
 */
function startsOf(registry: Registry, rules: Rule[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const add = (p: string, key: string) => {
    for (const k of startKeys(key)) {
      const list = out.get(k) ?? []
      list.push(p)
      out.set(k, list)
    }
  }
  for (const r of rules) {
    if (!('path' in r.to) || isPattern(r.to.path)) continue
    const to = r.to.path
    const locales = splitLocale(registry, r.from).locale === registry.defaultLocale ? registry.locales : [null]
    for (const l of locales) {
      const p = l === null ? to : localize(registry, l, to)
      add(p, p)
      const { rest } = splitLocale(registry, p)
      if (rest !== p) add(p, rest)
    }
  }
  return out
}

/**
 * Where to start walking a rule: its `from` in every locale it fires in (params set to samples, a
 * distinct one per name). A pattern with params in its target also starts at every concrete target
 * it matches, since an exact rule may send such a request on differently from a sample.
 */
function* walkStarts(registry: Registry, rule: Rule, starts: () => Map<string, string[]>): Generator<string> {
  const names = paramNames(rule.from)
  const from = fillParams(rule.from, Object.fromEntries(names.map((n) => [n, `${SAMPLE}${n}`])))
  const unprefixed = splitLocale(registry, rule.from).locale === registry.defaultLocale
  for (const l of unprefixed ? registry.locales : [null]) yield l === null ? from : withLocale(registry, l, from)
  if (names.length === 0 || !('path' in rule.to) || !isPattern(rule.to.path)) return
  const re = patternRegExp(rule.from)
  const [any, literal] = startKeys(rule.from)
  const seen = new Set<string>()
  const firstIsParam = isPattern(`/${rule.from.split('/')[1] ?? ''}`)
  for (const p of starts().get(firstIsParam ? any! : literal!) ?? []) {
    if (seen.has(p)) continue
    seen.add(p)
    const { locale, rest } = splitLocale(registry, p)
    if (re.test(p) || (unprefixed && locale !== registry.defaultLocale && re.test(rest))) yield p
  }
}

/**
 * Follows a request for `start` that `rule` answers, matching rules exactly as `resolvePath` does,
 * and gives the paths it passes when it goes round in a loop (or on for more than `MAX_HOPS`), or
 * `null`. It is a loop only if none of those paths is a stop, where a page or a path redirect answers
 * before any rule. A rule that would send `start` to itself is a loop. `null` when `rule` doesn't
 * answer `start`. A document target ends the walk.
 */
function walk(registry: Registry, index: RuleIndex<Rule>, rule: Rule, start: string): string[] | null {
  const trail = [start]
  const seen = new Set(trail)
  let path = start
  for (let hops = 0; ; hops++) {
    const { locale } = splitLocale(registry, path)
    let to: RuleTarget | null = null
    for (const candidate of ruleCandidates(registry, index, path)) {
      const target = candidate.rule.to
      to = 'document' in target ? target : { path: pathTarget(registry, locale, target.path, candidate) }
      if ('path' in to && to.path === path) {
        if (hops === 0 && candidate.rule === rule) return trail
        to = null
        continue
      }
      if (hops === 0 && candidate.rule !== rule) return null
      break
    }
    if (to === null || 'document' in to) return null
    if (seen.has(to.path) || hops >= MAX_HOPS) return trail
    trail.push(to.path)
    seen.add(to.path)
    path = to.path
  }
}

export async function createRedirect(deps: CoreDeps, input: RedirectInput, ctx: Ctx): Promise<Redirect> {
  assertCan(ctx, 'redirects.write')
  return withTransaction(deps, async (tdeps) => {
    const trx = tdeps.db
    const look = lookup(tdeps)
    const { rule, issues } = await checkRedirect(tdeps, input, look)
    if (!rule) throw invalid(issues)

    const existing = await trx.selectFrom('redirects').selectAll().orderBy('id').execute()
    if (existing.some((r) => r.from_path === rule.from)) {
      const at = ['from']
      throw invalid([
        contentIssue(at, [t(LABELS.from)], 'path_taken', 'issue.redirectExists', { path: rule.from }),
      ])
    }
    const added: Incoming = { id: null, from: rule.from, to: rule.to, blame: 0 }
    const { repointed, loops } = await settle(tdeps, look, [...existing.map(ruleOf), added], [added])
    if (loops.size > 0) {
      throw invalid([contentIssue(['to'], [t(LABELS.to)], 'redirect_loop', 'issue.redirectLoop', { path: rule.from })])
    }

    for (const r of repointed) {
      await trx.updateTable('redirects').set(columns(r.to)).where('id', '=', r.id!).execute()
    }
    const created = await trx
      .insertInto('redirects')
      .values({
        from_path: added.from,
        ...columns(added.to),
        status: rule.status,
        source: 'manual',
        note: rule.note,
        created_by_id: ctx.actor.id,
        created_by_name: ctx.actor.name,
        created_at: deps.now().toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return toRedirect(created)
  })
}

export async function deleteRedirect(deps: CoreDeps, id: number, ctx: Ctx): Promise<void> {
  assertCan(ctx, 'redirects.write')
  const res = await deps.db.deleteFrom('redirects').where('id', '=', id).executeTakeFirst()
  if (Number(res.numDeletedRows) === 0) throw new InlayError('not_found', 'error.redirectNotFound')
}

/**
 * Called by `publish` inside its transaction, before a document's published
 * slug and path move to its head. When its live URL changes, the old URL
 * gets an automatic 301 to the document, rules that pointed at the old URL
 * follow it to the new one, and an automatic rule from the new URL is dropped.
 * A rule that fires in the document's locale follows the document itself;
 * one that fires elsewhere keeps a path target, so its visitors stay on the
 * same translation rather than switching to the request's locale.
 */
export async function autoRedirect(
  deps: CoreDeps,
  ctx: Ctx,
  doc: Pick<
    Selectable<DocumentsTable>,
    'group_id' | 'type' | 'locale' | 'published_rev' | 'published_slug' | 'published_path' | 'head_slug' | 'head_path'
  >,
): Promise<void> {
  const def = deps.registry.types.get(doc.type)
  if (!def || def.kind !== 'collection' || (def.route === null && !def.customPaths)) return
  const newPath = sitePath(deps.registry, def, doc.locale, doc.head_slug, doc.head_path)
  if (newPath !== null) {
    await deps.db.deleteFrom('redirects').where('from_path', '=', newPath).where('source', '=', 'auto').execute()
  }
  if (doc.published_rev === null) return
  const oldPath = sitePath(deps.registry, def, doc.locale, doc.published_slug, doc.published_path)
  if (oldPath === null || oldPath === newPath) return

  const target = columns({ document: doc.group_id })
  await deps.db
    .insertInto('redirects')
    .values({
      from_path: oldPath,
      ...target,
      status: 301,
      source: 'auto',
      note: null,
      created_by_id: ctx.actor.id,
      created_by_name: ctx.actor.name,
      created_at: deps.now().toISOString(),
    })
    .onConflict((oc) => oc.column('from_path').doUpdateSet({ ...target, status: 301, source: 'auto' }))
    .execute()
  const pointing = await deps.db.selectFrom('redirects').select(['id', 'from_path']).where('to_path', '=', oldPath).execute()
  for (const r of pointing) {
    const inLocale = splitLocale(deps.registry, r.from_path).locale === doc.locale
    const to = newPath === null || inLocale ? target : columns({ path: newPath })
    await deps.db.updateTable('redirects').set(to).where('id', '=', r.id).execute()
  }
}

type LineProblem = { line: number; message: string }

/**
 * Imports `from,to[,status][,note]` rows (with an optional header row). All or
 * nothing: any problem throws `error.redirectImportFailed` with every problem
 * by line. A `from` that already has a rule updates that rule.
 */
export async function importRedirects(
  deps: CoreDeps,
  csv: string,
  ctx: Ctx,
): Promise<{ created: number; updated: number }> {
  assertCan(ctx, 'redirects.write')
  const parsed = parseCsv(csv)
  const first = parsed.rows[0]
  const rows = first && first.cells[0]?.trim().toLowerCase() === 'from' ? parsed.rows.slice(1) : parsed.rows

  return withTransaction(deps, async (tdeps) => {
    const trx = tdeps.db
    const look = lookup(tdeps)
    const problems: LineProblem[] = [...parsed.problems]
    const at = (line: number, message: string) => problems.push({ line, message: t('import.line', { line, message }) })

    const existing = await trx.selectFrom('redirects').selectAll().orderBy('id').execute()
    const seen = new Map<string, number>()
    const file: Array<CheckedRule & { line: number }> = []
    for (const { line, cells } of rows) {
      if (cells.length < 2 || cells.length > 4) {
        problems.push({ line, message: t('import.columns', { line }) })
        continue
      }
      const [from = '', to = '', status = '', note = ''] = cells
      const key = redirectFrom(deps.registry, from)
      const firstLine = key === null ? undefined : seen.get(key)
      if (key !== null && firstLine !== undefined) {
        problems.push({ line, message: t('import.repeated', { line, path: key, first: firstLine }) })
        continue
      }
      if (key !== null) seen.set(key, line)
      const input: RedirectInput = {
        from,
        to,
        note,
        ...(status.trim() !== '' && { status: Number(status.trim()) as 301 | 302 }),
      }
      const { rule, issues } = await checkRedirect(tdeps, input, look)
      for (const issue of issues) at(line, issue.message)
      if (rule) file.push({ ...rule, line })
    }

    const imported = new Map(file.map((r) => [r.from, r]))
    const incoming = new Map<string, Incoming>()
    const rules = existing.map((row): Rule => {
      const r = imported.get(row.from_path)
      if (!r) return ruleOf(row)
      const rule = { id: row.id, from: r.from, to: r.to, blame: r.line }
      incoming.set(r.from, rule)
      return rule
    })
    for (const r of file) {
      if (incoming.has(r.from)) continue
      const rule = { id: null, from: r.from, to: r.to, blame: r.line }
      incoming.set(r.from, rule)
      rules.push(rule)
    }
    const { repointed, loops } = await settle(tdeps, look, rules, [...incoming.values()])
    for (const line of loops) {
      const rule = file.find((r) => r.line === line)!
      at(line, contentIssue(['to'], [t(LABELS.to)], 'redirect_loop', 'issue.redirectLoop', { path: rule.from }).message)
    }

    if (problems.length > 0) {
      problems.sort((a, b) => a.line - b.line)
      throw new InlayError('validation', 'error.redirectImportFailed', { count: problems.length }, { lines: problems })
    }

    for (const r of repointed) {
      await trx.updateTable('redirects').set(columns(r.to)).where('id', '=', r.id!).execute()
    }
    let created = 0
    let updated = 0
    for (const r of file) {
      const rule = incoming.get(r.from)!
      const target = columns(rule.to)
      if (rule.id === null) {
        await trx
          .insertInto('redirects')
          .values({
            from_path: r.from,
            ...target,
            status: r.status,
            source: 'import',
            note: r.note,
            created_by_id: ctx.actor.id,
            created_by_name: ctx.actor.name,
            created_at: deps.now().toISOString(),
          })
          .execute()
        created++
      } else {
        await trx
          .updateTable('redirects')
          .set({ ...target, status: r.status, note: r.note, source: 'import' })
          .where('id', '=', rule.id)
          .execute()
        updated++
      }
    }
    return { created, updated }
  })
}
