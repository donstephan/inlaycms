import type { Registry } from '../registry/registry.js'
import { splitLocale, withLocale } from '../site/paths.js'

export type RuleTarget = { path: string } | { document: string }

const PARAM = /^:([A-Za-z_][A-Za-z0-9_]*)$/

/** The `:name` params of a path, in order. A param is a whole segment. */
export function paramNames(path: string): string[] {
  return path.split('/').flatMap((s) => {
    const name = PARAM.exec(s)?.[1]
    return name === undefined ? [] : [name]
  })
}

export function isPattern(path: string): boolean {
  return paramNames(path).length > 0
}

/** A regexp matching a pattern `from` against a decoded path; its groups are the params, in order. */
export function patternRegExp(from: string): RegExp {
  const parts = from.split('/').map((s) =>
    PARAM.test(s) ? '([^/]+)' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  )
  return new RegExp(`^${parts.join('/')}$`)
}

/** A path target with the params a rule matched filled in. */
export function fillParams(to: string, params: Record<string, string>): string {
  return to
    .split('/')
    .map((s) => (s.startsWith(':') ? (params[s.slice(1)] ?? s) : s))
    .join('/')
}

export interface RuleCandidate<R> {
  rule: R
  params: Record<string, string>
  /** Matched the unprefixed rest of a path outside the default locale, so its target gets the locale prefix. */
  viaRest: boolean
}

/** A pattern rule ready for matching; `rank` is its place in the order pattern rules are tried. */
interface PatternEntry<R> {
  rule: R
  names: string[]
  re: RegExp
  rank: number
}

/**
 * Rules ready for matching: exact rules by `from`, and pattern rules bucketed by segment count and
 * their first literal segment (`n` alone when every segment is a param), each bucket in the order
 * they are tried.
 */
export interface RuleIndex<R> {
  exact: ReadonlyMap<string, R>
  patterns: ReadonlyMap<string, ReadonlyArray<PatternEntry<R>>>
}

/** The bucket a pattern `from` goes in: its segment count and first literal segment, with its place. */
function patternKey(from: string): string {
  const parts = from.split('/')
  const at = parts.findIndex((s, i) => i > 0 && !PARAM.test(s))
  return at === -1 ? `${parts.length}` : `${parts.length} ${at} ${parts[at]}`
}

/** The buckets a path is looked up in: one per segment, and the all-param one. */
function pathKeys(path: string): string[] {
  const parts = path.split('/')
  return [`${parts.length}`, ...parts.slice(1).map((s, i) => `${parts.length} ${i + 1} ${s}`)]
}

/** Indexes `rules`, given in id order: pattern rules are tried fewest params first, then by id. */
export function ruleIndex<R extends { from: string }>(rules: Iterable<R>): RuleIndex<R> {
  const exact = new Map<string, R>()
  const sorted: Array<Omit<PatternEntry<R>, 'rank'>> = []
  for (const rule of rules) {
    const names = paramNames(rule.from)
    if (names.length === 0) exact.set(rule.from, rule)
    else sorted.push({ rule, names, re: patternRegExp(rule.from) })
  }
  sorted.sort((a, b) => a.names.length - b.names.length)
  const patterns = new Map<string, Array<PatternEntry<R>>>()
  sorted.forEach((p, rank) => {
    const key = patternKey(p.rule.from)
    const bucket = patterns.get(key) ?? []
    bucket.push({ ...p, rank })
    patterns.set(key, bucket)
  })
  return { exact, patterns }
}

/** The pattern rules that could match `path`, in the order they are tried. */
function* patternsFor<R>(index: RuleIndex<R>, path: string): Generator<PatternEntry<R>> {
  const buckets = pathKeys(path).flatMap((k) => {
    const b = index.patterns.get(k)
    return b ? [b] : []
  })
  if (buckets.length === 1) {
    yield* buckets[0]!
    return
  }
  const at = buckets.map(() => 0)
  for (;;) {
    let best = -1
    let rank = Infinity
    buckets.forEach((b, i) => {
      const entry = b[at[i]!]
      if (entry && entry.rank < rank) {
        best = i
        rank = entry.rank
      }
    })
    if (best === -1) return
    yield buckets[best]![at[best]!++]!
  }
}

/**
 * The rules that could answer a request for `path`, in the order they are tried: an exact rule on
 * `path`, then (outside the default locale) an exact rule on its unprefixed rest, then pattern rules
 * on `path` and then the rest.
 */
export function* ruleCandidates<R>(registry: Registry, index: RuleIndex<R>, path: string): Generator<RuleCandidate<R>> {
  const { locale, rest } = splitLocale(registry, path)
  const tries: Array<[string, boolean]> = locale === registry.defaultLocale ? [[path, false]] : [[path, false], [rest, true]]
  for (const [p, viaRest] of tries) {
    const rule = index.exact.get(p)
    if (rule) yield { rule, params: {}, viaRest }
  }
  for (const [p, viaRest] of tries) {
    for (const { rule, names, re } of patternsFor(index, p)) {
      const m = re.exec(p)
      if (m) yield { rule, params: Object.fromEntries(names.map((n, i) => [n, m[i + 1] ?? ''])), viaRest }
    }
  }
}

/** Whether a path's first segment is a site locale code, so it already names its locale. */
export function hasLocalePrefix(registry: Registry, path: string): boolean {
  return registry.locales.includes(path.split('/')[1] ?? '')
}

/** `path` in `locale`, unless it already names a locale. */
export function localize(registry: Registry, locale: string, path: string): string {
  return hasLocalePrefix(registry, path) ? path : withLocale(registry, locale, path)
}

/**
 * Where a rule's path target sends a request in `locale`, given the candidate it matched as. A
 * target that already names a locale is never given another prefix.
 */
export function pathTarget(registry: Registry, locale: string, to: string, candidate: RuleCandidate<unknown>): string {
  const target = fillParams(to, candidate.params)
  return candidate.viaRest ? localize(registry, locale, target) : target
}

/**
 * Where each of `rules` is stored: an exact path target is followed through exact rules, taking a
 * hop `T → U` of a rule from `F` only when `canFollow(T, U, F)`. It stops at a document, a pattern
 * path, a path with no exact rule, or before coming back to a path already passed (loops are left
 * for the caller to find). Chains shared between rules whose `from` has the same `scope` are
 * followed once, so `canFollow` may depend on `F` only through its scope.
 */
export async function collapseTargets(
  exact: ReadonlyMap<string, { to: RuleTarget }>,
  rules: ReadonlyArray<{ from: string; to: RuleTarget }>,
  canFollow: (path: string, next: RuleTarget, from: string) => boolean | Promise<boolean>,
  scope: (from: string) => string = () => '',
): Promise<RuleTarget[]> {
  const ends = new Map<string, RuleTarget>()
  const out: RuleTarget[] = []
  for (const rule of rules) {
    const key = (path: string) => `${scope(rule.from)}\u0000${path}`
    const seen = new Set([rule.from])
    const passed: string[] = []
    let end = rule.to
    while ('path' in end && !isPattern(end.path)) {
      const known = ends.get(key(end.path))
      if (known) {
        end = known
        break
      }
      const next = exact.get(end.path)?.to
      if (!next || ('path' in next && seen.has(next.path)) || !(await canFollow(end.path, next, rule.from))) break
      seen.add(end.path)
      passed.push(end.path)
      end = next
    }
    for (const p of passed) ends.set(key(p), end)
    out.push(end)
  }
  return out
}
