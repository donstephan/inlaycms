import type { z } from 'zod'
import { validateContent } from '../../core/content/validate.js'
import type { Core } from '../../core/core.js'
import { InlayError } from '../../core/errors.js'
import { fieldMeta } from '../../core/fields/define.js'
import { t, type MessageId } from '../../core/messages/index.js'
import type { TemplateDef } from '../../core/registry/define.js'
import type { PageInfo } from '../../core/registry/render.js'
import type { ContentIssue, DocumentData, ImageValue, LiveDocument, LiveState } from '../../core/types.js'
import { escapeHtml, raw, renderToString, toHtml, type SafeHtml } from '../../jsx/html.js'
import type { PublicAssets } from './assets.js'
import { createRenderContext, type PreloadingRenderContext } from './context.js'
import { buildHead, injectHead } from './head.js'
import { injectIntegrations, type IntegrationPageInfo, type SiteIntegrations } from './integrations.js'
import { isHomePath, mediaShareImage, pageTitle, resolveSeoDefaults } from './seo.js'

const DOCTYPE = /^\s*<!doctype\s/i
const BODY = /<body\b[^>]*>/i

export const PREVIEW_EXIT_PATH = '/_inlay/preview/exit'
const PREVIEW_PUBLISH_PATH = '/admin/publish'

const STYLE =
  'body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#111827;background:#f9fafb}' +
  'main{max-width:32rem;margin:3rem auto;padding:0 1rem}h1{font-size:1.5rem}' +
  'label{display:block;margin-top:1rem;font-weight:600}' +
  'input:not([type=hidden]){display:block;box-sizing:border-box;width:100%;margin-top:.25rem;padding:.5rem;font:inherit}' +
  'button{margin-top:1.25rem;padding:.5rem 1rem;font:inherit;cursor:pointer}' +
  '.inlay-error{color:#b91c1c}.inlay-hint{color:#4b5563;font-size:.875rem;margin:.25rem 0 0}'

/** A page Inlay renders itself (in the catalog's language), with `body` (Inlay-built HTML) under its `title` heading. */
export function inlayPage(title: string, body: SafeHtml): string {
  const heading = escapeHtml(title)
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
    `<title>${heading}</title><style>${STYLE}</style></head><body><main><h1>${heading}</h1>${body.value}</main></body></html>`
  )
}

function catalogDocument(titleId: MessageId, body: SafeHtml): string {
  return inlayPage(t(titleId), body)
}

/** A page Inlay renders itself, in the catalog's language. */
export function catalogPage(titleId: MessageId, bodyId: MessageId): string {
  return catalogDocument(titleId, raw(`<p>${escapeHtml(t(bodyId))}</p>`))
}

/**
 * `html` with the preview banner inserted after its opening `<body>` tag, or at the end when it has none. The banner
 * of a staged release's preview names the release and has no link to publish.
 */
function withPreviewBanner(html: string, release?: string): string {
  const publish = ` <a href="${PREVIEW_PUBLISH_PATH}" style="color:#fff">${escapeHtml(t('preview.publish'))}</a>`
  const banner =
    '<div class="inlay-preview" role="status" style="position:sticky;top:0;z-index:2147483647;padding:8px 16px;' +
    'background:#1f2937;color:#fff;font:14px/1.4 system-ui,sans-serif">' +
    (release === undefined ? `${escapeHtml(t('preview.banner'))}${publish}` : escapeHtml(t('preview.bannerRelease', { name: release }))) +
    ` <a href="${PREVIEW_EXIT_PATH}" style="color:#fff">${escapeHtml(t('preview.exit'))}</a></div>`
  const body = BODY.exec(html)
  if (!body) return `${html}${banner}`
  const at = body.index + body[0].length
  return `${html.slice(0, at)}${banner}${html.slice(at)}`
}

/** A rendered page and the `'sha256-…'` hashes of the inline scripts it wrote through `ctx.script`. */
export interface RenderedPage {
  html: string
  scriptHashes: string[]
}

type PageOptions = {
  state: LiveState
  page: number
  baseUrl: string
  release?: string
  assets?: PublicAssets
  /** Renders the site's active integrations into the page; without it, none are. */
  integrations?: SiteIntegrations
}

/**
 * Renders `doc` through its template, with its enabled slots rendered by their blocks. Render errors propagate.
 * In preview the page gets the preview banner (naming `release`, the name of the staged release previewed, when
 * given), and a draft that fails strict validation gets a list of its problems instead of its template.
 */
export async function renderPage(core: Core, doc: LiveDocument, opts: PageOptions): Promise<string> {
  return (await renderPageResult(core, doc, opts)).html
}

/** `renderPage`, with the hashes of the page's inline scripts. */
export async function renderPageResult(core: Core, doc: LiveDocument, opts: PageOptions): Promise<RenderedPage> {
  const { release, ...render } = opts
  if (render.state !== 'preview') return renderTemplate(core, doc, render)
  const checked = validateContent(core.registry, doc.type, doc.data, 'strict')
  if (!checked.ok) {
    const items = checked.issues.map((issue) => `<li>${escapeHtml(issue.message)}</li>`).join('')
    const body = raw(`<p>${escapeHtml(t('preview.incomplete'))}</p><ul>${items}</ul>`)
    return { html: withPreviewBanner(catalogDocument('preview.incomplete.title', body), release), scriptHashes: [] }
  }
  const rendered = await renderTemplate(core, doc, render)
  return { html: withPreviewBanner(rendered.html, release), scriptHashes: rendered.scriptHashes }
}

export type PaneResult = { ok: true; html: string } | { ok: false; issues: ContentIssue[] }

export const SLOT_START = (key: string) => `<!--inlay:slot ${key}-->`
export const SLOT_END = (key: string) => `<!--/inlay:slot ${key}-->`

const HEAD_OPEN = /<head\b[^>]*>/i

/** `doc` rendered for the editor's live preview pane: strict-checked, no banner, slot markers, `<base href>` of the page path. Render errors propagate. */
export async function renderPane(
  core: Core,
  doc: LiveDocument,
  opts: { page: number; baseUrl: string },
): Promise<PaneResult> {
  if (doc.path === null) throw new InlayError('invalid_operation', 'error.paneNoPath', { title: doc.title })
  const checked = validateContent(core.registry, doc.type, doc.data, 'strict')
  if (!checked.ok) return { ok: false, issues: checked.issues }
  return { ok: true, html: (await renderTemplate(core, doc, { ...opts, state: 'preview' }, { pane: true })).html }
}

/** `template` rendered with `data` and its enabled slots rendered by their blocks: the page before its head is added. */
async function renderBody(
  template: TemplateDef,
  data: DocumentData,
  page: PageInfo,
  ctx: PreloadingRenderContext,
  internal: { pane?: boolean },
): Promise<string> {
  if (!template.render) throw new InlayError('config', 'config.renderMissing', { name: template.name })
  const slots: Record<string, SafeHtml | null> = {}
  const slotData: Record<string, Record<string, unknown> | null> = {}
  for (const [key, slot] of Object.entries(template.slots)) {
    const stored = data.slots[key]
    if (!stored?.enabled) {
      slots[key] = null
      slotData[key] = null
      continue
    }
    slotData[key] = stored.data
    const rendered = slot.block.render ? await toHtml(slot.block.render(stored.data, ctx)) : raw('')
    slots[key] = internal.pane ? raw(SLOT_START(key) + rendered.value + SLOT_END(key)) : rendered
  }
  return renderToString(template.render({ fields: data.fields, slots, data: slotData, page }, ctx))
}

const withDoctype = (html: string) => (DOCTYPE.test(html) ? html : `<!doctype html>${html}`)

/** `html` with the active integrations rendered for `page` through `ctx.script`, when `integrations` is given. */
async function withIntegrations(
  html: string,
  integrations: SiteIntegrations | undefined,
  page: IntegrationPageInfo,
  ctx: PreloadingRenderContext,
): Promise<string> {
  if (!integrations) return html
  return injectIntegrations(html, await integrations.render(page, ctx.script))
}

async function renderTemplate(
  core: Core,
  doc: LiveDocument,
  opts: { state: LiveState; page: number; baseUrl: string; assets?: PublicAssets; integrations?: SiteIntegrations },
  internal: { pane?: boolean } = {},
): Promise<RenderedPage> {
  const { template } = core.registry.getType(doc.type)
  if (!template.render) throw new InlayError('config', 'config.renderMissing', { name: template.name })

  const alternates = await core.liveAlternates(doc.groupId, { state: opts.state })
  const ctx = createRenderContext(core, {
    locale: doc.locale,
    state: opts.state,
    page: opts.page,
    baseUrl: opts.baseUrl,
    alternates,
    ...(opts.assets && { assets: opts.assets }),
  })
  await ctx.preload([doc])

  const page: PageInfo = {
    title: doc.title,
    type: doc.type,
    locale: doc.locale,
    contentLocale: doc.contentLocale,
    fallback: doc.fallback,
    path: doc.path ?? '',
    publishedAt: doc.publishedAt,
    page: opts.page,
  }
  const html = await renderBody(template, doc.data, page, ctx, internal)

  const seo = seoValue(template.fields, doc.data.fields)
  const defaults = await resolveSeoDefaults(core.registry, ctx, opts.baseUrl)
  const own = doc.path
  const base = doc.fallback ? (alternates.find((a) => a.locale === core.registry.defaultLocale)?.path ?? own) : own
  const ogType = template.ogType ?? 'website'
  const head = buildHead({
    title: pageTitle(doc.title, seo?.title, defaults.titleTemplate, isHomePath(core.registry, doc.path)),
    description: seo?.description || defaults.description || null,
    image: mediaShareImage(ctx.image(seo?.image), opts.baseUrl) ?? defaults.image,
    ogType,
    // publishedAt comes with part 3 (content model): read doc.publishedAt here once LiveDocument has it.
    article: ogType === 'article' ? { publishedTime: doc.publishedAt, modifiedTime: doc.updatedAt } : null,
    canonical: own === null || base === null ? null : opts.page > 1 ? `${base}?page=${opts.page}` : base,
    alternates: doc.fallback ? [] : alternates.filter((a) => !a.fallback),
    defaultLocale: core.registry.defaultLocale,
    baseUrl: opts.baseUrl,
    preview: opts.state === 'preview',
    collected: ctx.headTags(),
  })
  let out = injectHead(html, head)
  if (internal.pane && doc.path !== null) {
    const open = HEAD_OPEN.exec(out)
    if (open) {
      const at = open.index + open[0].length
      out = `${out.slice(0, at)}<base href="${escapeHtml(doc.path)}">${out.slice(at)}`
    }
  }
  if (!internal.pane) {
    out = await withIntegrations(out, opts.integrations, { path: page.path, locale: doc.locale, preview: ctx.preview }, ctx)
  }
  return { html: withDoctype(out), scriptHashes: ctx.scriptHashes() }
}

type TemplateDataOptions = {
  locale: string
  path: string
  baseUrl: string
  canonical?: string | null
  assets?: PublicAssets
  preview?: boolean
  /** Renders the site's active integrations into the page; without it, none are. */
  integrations?: SiteIntegrations
}

/**
 * `template` rendered with `data` (already read with `fill`) as a published page at `path` that no document backs,
 * such as one a route returns: no canonical link and no alternates. Its title is the `title` field when that is
 * text, else the template's label or name. Render errors propagate.
 */
export async function renderTemplateData(
  core: Core,
  template: TemplateDef,
  data: DocumentData,
  opts: TemplateDataOptions,
): Promise<string> {
  return (await renderTemplateResult(core, template, data, opts)).html
}

/** `renderTemplateData`, with the hashes of the page's inline scripts. */
export async function renderTemplateResult(
  core: Core,
  template: TemplateDef,
  data: DocumentData,
  opts: TemplateDataOptions,
): Promise<RenderedPage> {
  const ctx = createRenderContext(core, {
    locale: opts.locale,
    state: 'published',
    page: 1,
    baseUrl: opts.baseUrl,
    alternates: [],
    ...(opts.assets && { assets: opts.assets }),
  })
  await ctx.preloadData(template, data)
  const field = data.fields.title
  const title = typeof field === 'string' && field !== '' ? field : (template.label ?? template.name)
  const page: PageInfo = {
    title,
    type: '',
    locale: opts.locale,
    contentLocale: opts.locale,
    fallback: false,
    path: opts.path,
    publishedAt: null,
    page: 1,
  }
  const html = await renderBody(template, data, page, ctx, {})
  const seo = seoValue(template.fields, data.fields)
  const defaults = await resolveSeoDefaults(core.registry, ctx, opts.baseUrl)
  const head = buildHead({
    title: pageTitle(title, seo?.title, defaults.titleTemplate, false),
    description: seo?.description || defaults.description || null,
    image: mediaShareImage(ctx.image(seo?.image), opts.baseUrl) ?? defaults.image,
    ogType: template.ogType ?? 'website',
    article: null,
    canonical: opts.canonical ?? null,
    alternates: [],
    defaultLocale: core.registry.defaultLocale,
    baseUrl: opts.baseUrl,
    preview: opts.preview === true,
    collected: ctx.headTags(),
  })
  const at = { path: opts.path, locale: opts.locale, preview: opts.preview === true }
  const out = await withIntegrations(injectHead(html, head), opts.integrations, at, ctx)
  return { html: withDoctype(out), scriptHashes: ctx.scriptHashes() }
}

type Seo = { title?: string; description?: string; image?: ImageValue }

/** The value of the first top-level field marked by `f.seo()`. */
function seoValue(fields: z.ZodObject, values: Record<string, unknown>): Seo | null {
  for (const [key, schema] of Object.entries(fields.shape)) {
    if (!fieldMeta(schema as z.ZodType)?.seo) continue
    const v = values[key]
    return v && typeof v === 'object' ? (v as Seo) : null
  }
  return null
}
