import type { Core } from '../../core/core.js'
import type { ActiveIntegration } from '../../core/integrations/integrations.js'
import { t } from '../../core/messages/index.js'
import type { SiteDefinition } from '../../core/registry/define.js'
import type { IntegrationPage } from '../../core/registry/integration.js'
import type { ScriptApi } from '../../core/registry/render.js'
import { escapeHtml, renderToString } from '../../jsx/html.js'
import { buildCsp } from './csp.js'

/** The page an integration renders for, without its `script`. */
export type IntegrationPageInfo = Omit<IntegrationPage, 'script'>

/** The active integrations' output for one page, by slot. */
export interface RenderedIntegrations {
  head: string
  bodyStart: string
  bodyEnd: string
}

export interface SiteIntegrations {
  /** The integrations switched on with valid settings, read once per page-cache generation. */
  active(): Promise<ActiveIntegration[]>
  /** The header value, or null when the site sets or removes content-security-policy itself. */
  policy(hashes?: readonly string[]): Promise<string | null>
  /** The versioned URL of the consent script a page with a gated integration loads. */
  consentUrl: string
  /** The active integrations rendered for `page`; a failure to read or render them is logged and left out. */
  render(page: IntegrationPageInfo, script: ScriptApi): Promise<RenderedIntegrations>
}

/**
 * `generation`: changes on every live change (the page cache's), so a change to the settings is seen on the next call.
 * `log`: where render failures go.
 */
export function createSiteIntegrations(opts: {
  core: Core
  site: SiteDefinition
  generation: () => number
  consentUrl: string
  log: (error: unknown, message: string) => void
}): SiteIntegrations {
  const { core, site, generation, consentUrl, log } = opts
  const ownPolicy = Object.keys(site.headers).some((name) => name.toLowerCase() === 'content-security-policy')
  let memo: { generation: number; active: Promise<ActiveIntegration[]> } | null = null

  function active(): Promise<ActiveIntegration[]> {
    const current = generation()
    if (memo !== null && memo.generation === current) return memo.active
    const read = core.activeIntegrations()
    memo = { generation: current, active: read }
    // A failed read isn't remembered: the next call tries again.
    read.catch(() => {
      if (memo?.active === read) memo = null
    })
    return read
  }

  return {
    active,
    async policy(hashes) {
      if (ownPolicy) return null
      // When the settings can't be read, no integration's sources are allowed: the policy fails closed.
      const integrations = (await active().catch(() => [])).map((a) => a.def.csp)
      return buildCsp({ site: site.csp, integrations, ...(hashes && { hashes }) })
    },
    consentUrl,
    async render(page, script) {
      let list: ActiveIntegration[]
      try {
        list = await active()
      } catch (error) {
        log(error, t('log.integrationsUnreadable'))
        return { head: '', bodyStart: '', bodyEnd: '' }
      }
      return renderIntegrations(list, page, script, {
        consentUrl,
        log: (name, error) => log(error, t('log.integrationFailed', { name })),
      })
    },
  }
}

const SLOTS = ['head', 'bodyStart', 'bodyEnd'] as const

/**
 * Each of `active`'s slots rendered for `page`, in order, skipping in preview the ones without `preview: true`. A
 * gated integration's output is wrapped in an inert `<template data-inlay-consent>`, and `head` then ends with the
 * consent script. An integration whose render throws is logged and left out of this page.
 */
export async function renderIntegrations(
  active: readonly ActiveIntegration[],
  page: IntegrationPageInfo,
  script: ScriptApi,
  opts: { consentUrl: string; log: (name: string, error: unknown) => void },
): Promise<RenderedIntegrations> {
  const out: RenderedIntegrations = { head: '', bodyStart: '', bodyEnd: '' }
  let gated = false
  for (const { def, values } of active) {
    if (page.preview && !def.preview) continue
    const own: RenderedIntegrations = { head: '', bodyStart: '', bodyEnd: '' }
    try {
      for (const slot of SLOTS) {
        const render = def[slot]
        if (render) own[slot] = await renderToString(render(values, { ...page, script }))
      }
    } catch (error) {
      opts.log(def.name, error)
      continue
    }
    for (const slot of SLOTS) {
      const html = own[slot]
      if (html === '') continue
      if (def.consent === undefined) {
        out[slot] += html
      } else {
        out[slot] += `<template data-inlay-consent="${escapeHtml(def.consent)}">${html}</template>`
        gated = true
      }
    }
  }
  if (gated) out.head += `<script src="${escapeHtml(opts.consentUrl)}" defer></script>`
  return out
}

const BODY = /<body\b[^>]*>/i

/**
 * `html` with `rendered.head` before its first `</head>`, `bodyStart` right after its `<body>` and `bodyEnd` before
 * its last `</body>`. A slot whose marker is missing is left out.
 */
export function injectIntegrations(html: string, rendered: RenderedIntegrations): string {
  const inserts: Array<{ at: number; text: string }> = []
  const head = html.search(/<\/head>/i)
  if (head >= 0 && rendered.head !== '') inserts.push({ at: head, text: rendered.head })
  const body = BODY.exec(html)
  if (body && rendered.bodyStart !== '') inserts.push({ at: body.index + body[0].length, text: rendered.bodyStart })
  let end = -1
  for (const match of html.matchAll(/<\/body>/gi)) end = match.index
  if (end >= 0 && rendered.bodyEnd !== '') inserts.push({ at: end, text: rendered.bodyEnd })
  inserts.sort((a, b) => a.at - b.at)
  let out = ''
  let from = 0
  for (const { at, text } of inserts) {
    out += html.slice(from, at) + text
    from = at
  }
  return out + html.slice(from)
}
