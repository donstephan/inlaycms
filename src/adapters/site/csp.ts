import { CSP_DIRECTIVES, type CspDirective, type CspSources } from '../../core/registry/integration.js'

/** Inlay's own sources per directive, in the order the policy lists them; `worker-src` only when something declares it. */
const BASE: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['default-src', ["'self'"]],
  ['script-src', ["'self'"]],
  ['style-src', ["'self'", "'unsafe-inline'"]],
  ['img-src', ["'self'", 'data:']],
  ['font-src', ["'self'"]],
  ['connect-src', ["'self'"]],
  ['frame-src', ["'self'"]],
  ['media-src', ["'self'"]],
  ['worker-src', ["'self'"]],
  ['object-src', ["'none'"]],
  ['base-uri', ["'self'"]],
  ['form-action', ["'self'"]],
  ['frame-ancestors', ["'self'"]],
]

const UNSAFE_INLINE = "'unsafe-inline'"

const declarable = (directive: string): directive is CspDirective => (CSP_DIRECTIVES as readonly string[]).includes(directive)

/**
 * The Content-Security-Policy of a public response: Inlay's defaults, then in `script-src` the page's inline-script
 * `hashes`, then the sources the site and then each integration declare, each source once. Hashes are left out when
 * `'unsafe-inline'` is declared for `script-src`, since browsers ignore it beside a hash.
 */
export function buildCsp(input: { site: CspSources; integrations: readonly CspSources[]; hashes?: readonly string[] }): string {
  const declared = (directive: string) =>
    declarable(directive) ? [input.site, ...input.integrations].flatMap((sources) => sources[directive] ?? []) : []
  const parts: string[] = []
  for (const [directive, base] of BASE) {
    const own = declared(directive)
    if (directive === 'worker-src' && own.length === 0) continue
    const extra = directive === 'script-src' && !own.includes(UNSAFE_INLINE) ? (input.hashes ?? []) : []
    parts.push([directive, ...new Set([...base, ...extra, ...own])].join(' '))
  }
  return parts.join('; ')
}
