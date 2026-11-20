import { sql } from 'kysely'
import { nextHops, pathTarget, ruleIndex, type RuleCandidate, type RuleIndex, type RuleSets } from '../redirects/collapse.js'
import { isUrlTarget } from '../redirects/rule.js'
import type { CoreDeps, LiveDocument, LiveState, MatchRule, RouteMatch } from '../types.js'
import { liveDocuments, liveQuery, liveSingleton, type LiveOpts } from './live.js'
import { encodePath, lowercaseFallback, normalizePath, routeRegExp, singletonPath, splitLocale } from './paths.js'

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

type Target = { target: string; external: boolean }

/**
 * Where a rule sends a request in `locale`: a document target is its URL in `locale` (`null` when it
 * isn't live there); a URL target is that URL as stored, on another site; a path target gets its params
 * filled in, and the locale prefix when the rule matched the unprefixed rest.
 */
async function ruleTarget(
  deps: CoreDeps,
  candidate: RuleCandidate<MatchRule>,
  locale: string,
  opts: LiveOpts,
): Promise<Target | null> {
  const { rule } = candidate
  if (rule.to_group_id !== null) {
    const path = (await liveDocuments(deps, [rule.to_group_id], locale, opts)).get(rule.to_group_id)?.path ?? null
    return path === null ? null : { target: path, external: false }
  }
  if (rule.to_path === null) return null
  if (isUrlTarget(rule.to_path)) return { target: rule.to_path, external: true }
  return { target: pathTarget(deps.registry, locale, rule.to_path, candidate), external: false }
}

type Fired = { rule: MatchRule } & Target

/**
 * The rules that would answer a request for `path`, in `nextHops` order: admin rules then code
 * rules, each with exact rules before pattern rules, and last the lowercase fallback when `path`
 * has one. Rules whose target isn't live, or is `path` itself, are skipped.
 */
async function* firing(
  deps: CoreDeps,
  sets: RuleSets<MatchRule>,
  path: string,
  locale: string,
  opts: LiveOpts,
): AsyncGenerator<Fired | { fallback: string }> {
  for (const hop of nextHops(deps.registry, sets, path)) {
    if ('fallback' in hop) {
      yield hop
      continue
    }
    const to = await ruleTarget(deps, hop.candidate, locale, opts)
    if (to !== null && to.target !== path) yield { rule: hop.candidate.rule, ...to }
  }
}

/** The most redirects followed when checking that a redirect doesn't lead round in a loop. */
const MAX_HOPS = 32

/**
 * Follows a visitor sent from `start` to `fired.target`, answering each request as `resolvePath`
 * would (a GET code route, pages, normalizing redirects, then the first rule that fires or else the
 * lowercase fallback), and gives the `from` of the rules passed if a path comes round again, or
 * `null` when the chain ends (at a code route, a page, a not-found or another site) or runs past
 * `MAX_HOPS`.
 */
async function loopFrom(
  deps: CoreDeps,
  sets: RuleSets<MatchRule>,
  start: string,
  fired: Fired,
  opts: LiveOpts,
): Promise<string[] | null> {
  if (fired.external) return null
  const seen = new Set([start])
  const rules = [fired.rule.from]
  let path = fired.target
  for (let hops = 0; hops < MAX_HOPS; hops++) {
    if (deps.registry.getRoutePaths.has(path)) return null
    if (seen.has(path)) return rules
    seen.add(path)
    const res = await resolveSite(deps, encodePath(path), opts)
    if (res.kind === 'page' || res.kind === 'not_found') return null
    if (res.kind === 'canonical') {
      path = res.canonical
      continue
    }
    if (res.kind === 'redirect') {
      const next = normalizePath(res.location)
      if (next === null) return null
      path = next
      continue
    }
    const { value: next } = await firing(deps, sets, res.path, res.locale, opts).next()
    if (!next) return null
    if ('fallback' in next) {
      path = next.fallback
      continue
    }
    if (next.external) return null
    rules.push(next.rule.from)
    path = next.target
  }
  return null
}

/**
 * The first redirect rule that applies, as `firing` gives them up to the lowercase fallback, skipping
 * any that would send the visitor round in a loop. `not_found` with `loop` when only such rules fire.
 */
async function matchRedirect(deps: CoreDeps, at: RulesNext, opts: LiveOpts): Promise<RouteMatch | null> {
  const sets: RuleSets<MatchRule> = [await matchIndex(deps), deps.registry.redirectIndex]
  const loop = new Set<string>()
  for await (const fired of firing(deps, sets, at.path, at.locale, opts)) {
    if ('fallback' in fired) break
    const rules = await loopFrom(deps, sets, at.path, fired, opts)
    if (rules === null) {
      const { target, rule } = fired
      return fired.external
        ? { kind: 'redirect', location: target, status: rule.status, external: true }
        : { kind: 'redirect', location: encodePath(target), status: rule.status }
    }
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
  if (res.kind === 'canonical') {
    const { canonical } = res
    const at = await atCanonical(deps, canonical, opts)
    if (at?.kind === 'redirect') return at
    // A mixed-case path that would 404 once canonical goes where the lowercase fallback lands, in one 301.
    const lower = lowercaseFallback(canonical)
    if (lower !== null && at?.kind === 'not_found') return (await landing(deps, lower, opts)) ?? redirect(canonical)
    return redirect(canonical)
  }
  if (res.kind !== 'rules') return res

  // 7. Redirect rules: the admin's (7a), then the site's code rules (7b).
  const rule = await matchRedirect(deps, res, opts)
  if (rule?.kind === 'redirect') return rule

  // 8. Lowercase fallback.
  const lower = lowercaseFallback(res.path)
  const landed = lower === null ? null : await landing(deps, lower, opts)
  if (landed) return landed

  // 9. Not found.
  return rule ?? notFound(res.locale)
}

/** Steps 1–7b of `resolvePath`: everything but the lowercase fallback. */
async function resolveRules(deps: CoreDeps, rawPath: string, opts: LiveOpts): Promise<RouteMatch> {
  const res = await resolveSite(deps, rawPath, opts)
  if (res.kind === 'canonical') return redirect(res.canonical)
  if (res.kind !== 'rules') return res
  return (await matchRedirect(deps, res, opts)) ?? notFound(res.locale)
}

/**
 * What steps 1–7b answer at the target of a step 2–3 redirect, so a rule there is reached in the
 * same 301; `null` at a GET code route, which no rule can shadow.
 */
async function atCanonical(deps: CoreDeps, canonical: string, opts: LiveOpts): Promise<RouteMatch | null> {
  return deps.registry.getRoutePaths.has(canonical) ? null : resolveRules(deps, encodePath(canonical), opts)
}

/**
 * Where the lowercase fallback for a request lands, given its lowercase form `lower`: a GET code
 * route or a page there, a redirect that steps 2–6 or a rule would give, or `null` when nothing
 * answers there. A step 2–3 redirect lands only when something answers at its canonical path.
 */
async function landing(deps: CoreDeps, lower: string, opts: LiveOpts): Promise<RouteMatch | null> {
  if (deps.registry.getRoutePaths.has(lower)) return redirect(lower)
  const res = await resolveSite(deps, encodePath(lower), opts)
  if (res.kind === 'page') return redirect(lower)
  if (res.kind === 'canonical') {
    const at = await atCanonical(deps, res.canonical, opts)
    if (at?.kind === 'redirect') return at
    return (await answers(deps, res.canonical, opts)) ? redirect(res.canonical) : null
  }
  if (res.kind === 'redirect') return res
  if (res.kind !== 'rules') return null
  const rule = await matchRedirect(deps, res, opts)
  return rule?.kind === 'redirect' ? rule : null
}

/** Whether a GET code route, a page, a redirect from steps 2–6 or a firing rule answers at a decoded `path`. */
async function answers(deps: CoreDeps, path: string, opts: LiveOpts): Promise<boolean> {
  if (deps.registry.getRoutePaths.has(path)) return true
  const res = await resolveSite(deps, encodePath(path), opts)
  if (res.kind === 'canonical') return answers(deps, res.canonical, opts)
  if (res.kind !== 'rules') return res.kind !== 'not_found'
  return (await matchRedirect(deps, res, opts))?.kind === 'redirect'
}

/**
 * What `resolvePath` answers before it looks at redirect rules (steps 1–6, then 9): a redirect rule
 * can only fire where this is `not_found`.
 */
export async function resolveWithoutRules(deps: CoreDeps, rawPath: string, opts: LiveOpts = {}): Promise<RouteMatch> {
  const res = await resolveSite(deps, rawPath, opts)
  if (res.kind === 'canonical') return redirect(res.canonical)
  return res.kind === 'rules' ? notFound(res.locale) : res
}

type RulesNext = { kind: 'rules'; path: string; locale: string; rest: string }

/** The step 2–3 redirect, to the canonical path. */
type Canonical = { kind: 'canonical'; canonical: string }

/** Steps 1–6 of `resolvePath`, or where redirect rules are tried next. */
async function resolveSite(deps: CoreDeps, rawPath: string, opts: LiveOpts): Promise<RouteMatch | RulesNext | Canonical> {
  const state: LiveState = opts.state ?? 'published'
  const { registry } = deps

  // 1. Invalid paths, including anything that could leave the site.
  const path = normalizePath(rawPath)
  if (path === null) return notFound(registry.defaultLocale)

  // 2–3. Trailing slash and default-locale prefix: one 301 to the canonical path.
  const [, first = '', ...tail] = path.split('/')
  const canonical = first === registry.defaultLocale ? `/${tail.join('/')}` : path
  if (canonical !== path || decodeURIComponent(rawPath) !== path) return { kind: 'canonical', canonical }

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
