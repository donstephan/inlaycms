import { sql } from 'kysely'
import { pathTarget, ruleCandidates, ruleIndex, type RuleCandidate, type RuleIndex } from '../redirects/collapse.js'
import type { CoreDeps, LiveDocument, LiveState, MatchRule, RouteMatch } from '../types.js'
import { liveDocuments, liveQuery, liveSingleton, type LiveOpts } from './live.js'
import { encodePath, normalizePath, routeRegExp, singletonPath, splitLocale } from './paths.js'

const notFound = (locale: string): RouteMatch => ({ kind: 'not_found', locale })
const page = (document: LiveDocument): RouteMatch => ({ kind: 'page', document })
const redirect = (path: string): RouteMatch => ({ kind: 'redirect', location: encodePath(path), status: 301 })

/**
 * The document of a group in `locale`, given the group was found at `path`: a page when the group's
 * live path is `path`, a redirect when it lives elsewhere, `null` when it isn't live in `locale`.
 */
async function groupAt(
  deps: CoreDeps,
  groupId: string,
  locale: string,
  path: string,
  opts: LiveOpts,
): Promise<RouteMatch | null> {
  const doc = (await liveDocuments(deps, [groupId], locale, opts)).get(groupId)
  if (!doc || doc.path === null) return null
  return doc.path === path ? page(doc) : redirect(doc.path)
}

/** Of rows found in `locale` and the default locale, the one in `locale` first. */
function preferLocale<R extends { locale: string }>(rows: R[], locale: string): R | undefined {
  return rows.find((r) => r.locale === locale) ?? rows[0]
}

/**
 * The redirect rules ready for matching. The index is kept in `deps.rules` and reused while the
 * database's change counters stand still: `total_changes()` moves with every write on this
 * connection (committed or rolled back), and `data_version` with every commit from another one. The
 * counters are read before the rules, so a stored index is never older than its key.
 */
async function matchIndex(deps: CoreDeps): Promise<RuleIndex<MatchRule>> {
  const cache = deps.rules
  let key: string | null = null
  if (cache) {
    const { rows } = await sql<{ changes: number; version: number }>`
      select total_changes() as changes, (select data_version from pragma_data_version) as version
    `.execute(deps.db)
    key = `${rows[0]?.changes} ${rows[0]?.version}`
    if (cache.current?.key === key) return cache.current.index
  }
  const rules = await deps.db
    .selectFrom('redirects')
    .select(['from_path as from', 'to_path', 'to_group_id', 'status'])
    .orderBy('id')
    .execute()
  const index = ruleIndex(rules)
  if (cache && key !== null) cache.current = { key, index }
  return index
}

/**
 * Where a rule sends a request in `locale`: a document target is its URL in `locale` (`null` when it
 * isn't live there); a path target gets its params filled in, and the locale prefix when the rule
 * matched the unprefixed rest.
 */
async function ruleTarget(
  deps: CoreDeps,
  candidate: RuleCandidate<MatchRule>,
  locale: string,
  opts: LiveOpts,
): Promise<string | null> {
  const { rule } = candidate
  if (rule.to_group_id !== null) {
    return (await liveDocuments(deps, [rule.to_group_id], locale, opts)).get(rule.to_group_id)?.path ?? null
  }
  if (rule.to_path === null) return null
  return pathTarget(deps.registry, locale, rule.to_path, candidate)
}

type Fired = { rule: MatchRule; target: string }

/**
 * The rules that would answer a request for `path`, in `ruleCandidates` order: exact rules before
 * pattern rules. Rules whose target isn't live, or is `path` itself, are skipped.
 */
async function* firing(
  deps: CoreDeps,
  index: RuleIndex<MatchRule>,
  path: string,
  locale: string,
  opts: LiveOpts,
): AsyncGenerator<Fired> {
  for (const candidate of ruleCandidates(deps.registry, index, path)) {
    const target = await ruleTarget(deps, candidate, locale, opts)
    if (target !== null && target !== path) yield { rule: candidate.rule, target }
  }
}

/** The most redirects followed when checking that a redirect doesn't lead round in a loop. */
const MAX_HOPS = 32

/**
 * Follows a visitor sent from `start` to `fired.target`, answering each request as `resolvePath`
 * would (pages, normalizing redirects, then the first rule that fires), and gives the `from` of the
 * rules passed if a path comes round again, or `null` when the chain ends or runs past `MAX_HOPS`.
 */
async function loopFrom(
  deps: CoreDeps,
  index: RuleIndex<MatchRule>,
  start: string,
  fired: Fired,
  opts: LiveOpts,
): Promise<string[] | null> {
  const seen = new Set([start])
  const rules = [fired.rule.from]
  let path = fired.target
  for (let hops = 0; hops < MAX_HOPS; hops++) {
    if (seen.has(path)) return rules
    seen.add(path)
    const res = await resolveSite(deps, encodePath(path), opts)
    if (res.kind === 'page' || res.kind === 'not_found') return null
    if (res.kind === 'redirect') {
      const next = normalizePath(res.location)
      if (next === null) return null
      path = next
      continue
    }
    const { value: next } = await firing(deps, index, res.path, res.locale, opts).next()
    if (!next) return null
    rules.push(next.rule.from)
    path = next.target
  }
  return null
}

/**
 * The first redirect rule that applies, as `firing` gives them, skipping any that would send the
 * visitor round in a loop. `not_found` with `loop` when only such rules fire.
 */
async function matchRedirect(deps: CoreDeps, at: RulesNext, opts: LiveOpts): Promise<RouteMatch | null> {
  const index = await matchIndex(deps)
  const loop = new Set<string>()
  for await (const fired of firing(deps, index, at.path, at.locale, opts)) {
    const rules = await loopFrom(deps, index, at.path, fired, opts)
    if (rules === null) return { kind: 'redirect', location: encodePath(fired.target), status: fired.rule.status }
    for (const from of rules) loop.add(from)
  }
  return loop.size > 0 ? { kind: 'not_found', locale: at.locale, loop: [...loop] } : null
}

function lookupLocales(deps: CoreDeps, locale: string): string[] {
  return [...new Set([locale, deps.registry.defaultLocale])]
}

/** Resolves a still-encoded URL path (no query string) to a page, a redirect or not-found. */
export async function resolvePath(deps: CoreDeps, rawPath: string, opts: LiveOpts = {}): Promise<RouteMatch> {
  const res = await resolveSite(deps, rawPath, opts)
  if (res.kind !== 'rules') return res

  // 7. Redirect rules.
  const rule = await matchRedirect(deps, res, opts)
  if (rule) return rule

  // 8. Not found.
  return notFound(res.locale)
}

/**
 * What `resolvePath` answers before it looks at redirect rules (steps 1–6, then 8): a redirect rule
 * can only fire where this is `not_found`.
 */
export async function resolveWithoutRules(deps: CoreDeps, rawPath: string, opts: LiveOpts = {}): Promise<RouteMatch> {
  const res = await resolveSite(deps, rawPath, opts)
  return res.kind === 'rules' ? notFound(res.locale) : res
}

type RulesNext = { kind: 'rules'; path: string; locale: string; rest: string }

/** Steps 1–6 of `resolvePath`, or where redirect rules are tried next. */
async function resolveSite(deps: CoreDeps, rawPath: string, opts: LiveOpts): Promise<RouteMatch | RulesNext> {
  const state: LiveState = opts.state ?? 'published'
  const { registry } = deps

  // 1. Invalid paths, including anything that could leave the site.
  const path = normalizePath(rawPath)
  if (path === null) return notFound(registry.defaultLocale)

  // 2–3. Trailing slash and default-locale prefix: one 301 to the canonical path.
  const [, first = '', ...tail] = path.split('/')
  const canonical = first === registry.defaultLocale ? `/${tail.join('/')}` : path
  if (canonical !== path || decodeURIComponent(rawPath) !== path) return redirect(canonical)

  const { locale, rest } = splitLocale(registry, path)
  const types = [...registry.types.values()]

  // 4. Singleton paths.
  for (const def of types) {
    if (def.kind !== 'singleton' || singletonPath(def, locale, registry.defaultLocale) !== rest) continue
    const doc = await liveSingleton(deps, def.name, locale, opts)
    if (doc) return page(doc)
  }

  // 5. Custom entry paths.
  const custom = types.flatMap((d) => (d.kind === 'collection' && d.customPaths ? [d.name] : []))
  if (custom.length > 0) {
    const rows = await liveQuery(deps, state)
      .where('documents.type', 'in', custom)
      .where('documents.kind', '=', 'entry')
      .where('documents.locale', 'in', lookupLocales(deps, locale))
      .where(state === 'preview' ? 'documents.head_path' : 'documents.published_path', '=', rest)
      .execute()
    const row = preferLocale(rows, locale)
    const match = row ? await groupAt(deps, row.group_id, locale, path, opts) : null
    if (match) return match
  }

  // 6. Collection routes.
  for (const def of types) {
    if (def.kind !== 'collection' || def.route === null) continue
    const slug = routeRegExp(def.route).exec(rest)?.[1]
    if (slug === undefined) continue
    const rows = await liveQuery(deps, state)
      .where('documents.type', '=', def.name)
      .where('documents.kind', '=', 'entry')
      .where('documents.locale', 'in', lookupLocales(deps, locale))
      .where(state === 'preview' ? 'documents.head_slug' : 'documents.published_slug', '=', slug)
      .execute()
    const row = preferLocale(rows, locale)
    const match = row ? await groupAt(deps, row.group_id, locale, path, opts) : null
    if (match) return match
  }

  return { kind: 'rules', path, locale, rest }
}
