import { t } from '../messages/index.js'
import type { SiteDefinition } from '../registry/define.js'
import type { CspSources } from '../registry/integration.js'
import type { CheckWarning } from '../report.js'

/** A bare scheme such as `https:` or `data:`, which allows every address under it. */
const SCHEME = /^[a-z][a-z0-9+.-]*:$/

/** Warnings about the policy a site's code asks for. */
export function policyWarnings(site: SiteDefinition): CheckWarning[] {
  const warnings: CheckWarning[] = []
  const declared: { who: string | null; csp: CspSources }[] = [
    { who: null, csp: site.csp },
    ...site.integrations.map((i) => ({ who: i.name, csp: i.csp })),
  ]
  for (const { who, csp } of declared) {
    const sources = csp['script-src'] ?? []
    const owner = who === null ? t('definition.cspOwnerSite') : t('definition.cspOwnerIntegration', { name: who })
    if (sources.includes("'unsafe-inline'")) {
      warnings.push({ code: 'csp_unsafe_inline', message: t('report.cspUnsafeInline', { owner }) })
    }
    if (sources.includes("'unsafe-eval'")) {
      warnings.push({ code: 'csp_unsafe_eval', message: t('report.cspUnsafeEval', { owner }) })
    }
    for (const source of sources) {
      if (SCHEME.test(source)) warnings.push({ code: 'csp_script_scheme', message: t('report.cspScriptScheme', { owner, source }) })
    }
  }
  const overrides = Object.keys(site.headers).some((h) => h.toLowerCase() === 'content-security-policy')
  if (overrides && site.integrations.length > 0) warnings.push({ code: 'csp_overridden', message: t('report.cspOverridden') })
  return warnings
}
