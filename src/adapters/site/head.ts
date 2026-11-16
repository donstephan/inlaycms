import type { ResolvedImage } from '../../core/registry/render.js'
import { encodePath } from '../../core/site/paths.js'
import type { ImageValue } from '../../core/types.js'
import { escapeHtml, raw, type SafeHtml } from '../../jsx/html.js'

export interface HeadInput {
  title: string
  seo: { title?: string; description?: string; image?: ImageValue } | null
  /** Decoded site path, with `?page=N` when paginated; `null` for a page with no URL of its own, which gets noindex. */
  canonical: string | null
  alternates: Array<{ locale: string; path: string }>
  defaultLocale: string
  image: ResolvedImage | null
  baseUrl: string
  preview: boolean
}

const RASTER = /^image\/(jpeg|png|webp|gif|avif|tiff)$/

function absolute(baseUrl: string, path: string): string {
  const [p = '', query] = path.split('?')
  return `${baseUrl}${p === '/' ? '/' : encodePath(p)}${query === undefined ? '' : `?${query}`}`
}

export function buildHead(input: HeadInput): SafeHtml {
  const title = input.seo?.title || input.title
  const description = input.seo?.description || ''
  const e = escapeHtml
  const url = input.canonical === null ? null : absolute(input.baseUrl, input.canonical)
  const tags = [`<title>${e(title)}</title>`]
  if (description) tags.push(`<meta name="description" content="${e(description)}">`)
  if (url !== null) tags.push(`<link rel="canonical" href="${e(url)}">`)
  if (input.alternates.length >= 2) {
    for (const a of input.alternates) {
      tags.push(`<link rel="alternate" hreflang="${e(a.locale)}" href="${e(absolute(input.baseUrl, a.path))}">`)
    }
    const def = input.alternates.find((a) => a.locale === input.defaultLocale)
    if (def) tags.push(`<link rel="alternate" hreflang="x-default" href="${e(absolute(input.baseUrl, def.path))}">`)
  }
  tags.push(`<meta property="og:type" content="website">`)
  tags.push(`<meta property="og:title" content="${e(title)}">`)
  if (description) tags.push(`<meta property="og:description" content="${e(description)}">`)
  if (url !== null) tags.push(`<meta property="og:url" content="${e(url)}">`)
  if (input.image && RASTER.test(input.image.mime)) {
    tags.push(`<meta property="og:image" content="${e(`${input.baseUrl}/media/${encodeURIComponent(input.image.id)}/1280.jpeg`)}">`)
  }
  if (input.preview || url === null) tags.push(`<meta name="robots" content="noindex">`)
  return raw(tags.join(''))
}

export function injectHead(html: string, head: SafeHtml): string {
  const i = html.search(/<\/head>/i)
  if (i < 0) return html
  return `${html.slice(0, i)}${head.value}${html.slice(i)}`
}
