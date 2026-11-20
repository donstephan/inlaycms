import { InlayError } from '../../core/errors.js'
import { isSafeUrl } from '../../core/fields/define.js'
import type { OgType } from '../../core/registry/define.js'
import { scriptJson } from '../../core/registry/js.js'
import type { HeadApi, HeadLink } from '../../core/registry/render.js'
import { encodePath, presentHref, type TrailingSlash } from '../../core/site/paths.js'
import { escapeHtml, raw, type SafeHtml } from '../../jsx/html.js'

export interface HeadInput {
  /** The final `<title>` text. */
  title: string
  description: string | null
  /** Absolute URL of the share image. */
  image: string | null
  ogType: OgType
  /** Only for `ogType: 'article'` on a document page. */
  article: { publishedTime: string | null; modifiedTime: string } | null
  /** Decoded site path, with `?page=N` when paginated; `null` for a page with no URL of its own, which gets noindex. */
  canonical: string | null
  alternates: Array<{ locale: string; path: string }>
  defaultLocale: string
  baseUrl: string
  trailingSlash: TrailingSlash
  preview: boolean
  /** What the render added through `ctx.head`. */
  collected?: CollectedHead
}

/** What templates and blocks added through `ctx.head`, in call order. */
export interface CollectedHead {
  meta: Array<{ attr: 'name' | 'property'; key: string; content: string }>
  links: HeadLink[]
  /** Each already written as JSON and escaped for a `<script>`. */
  jsonLd: string[]
}

export const NO_HEAD: CollectedHead = { meta: [], links: [], jsonLd: [] }

const LINK_ATTRS = ['rel', 'hreflang', 'type', 'sizes', 'media', 'as', 'crossorigin', 'href'] as const

/** The `ctx.head` of one render, and what it collected. */
export function createHeadCollector(): { api: HeadApi; collected(): CollectedHead } {
  const head: CollectedHead = { meta: [], links: [], jsonLd: [] }
  const api: HeadApi = {
    jsonLd(value) {
      head.jsonLd.push(scriptJson(value))
    },
    meta(attrs) {
      const tag = 'property' in attrs
        ? { attr: 'property' as const, key: String(attrs.property) }
        : { attr: 'name' as const, key: String(attrs.name) }
      head.meta.push({ ...tag, content: String(attrs.content) })
    },
    link(attrs) {
      const href = String(attrs.href)
      if (!isSafeUrl(href)) throw new InlayError('config', 'config.headHref', { href })
      const link: HeadLink = { rel: String(attrs.rel), href }
      for (const k of LINK_ATTRS) {
        const v = attrs[k]
        if (v !== undefined && v !== null) link[k] = String(v)
      }
      head.links.push(link)
    },
  }
  return { api, collected: () => ({ meta: [...head.meta], links: [...head.links], jsonLd: [...head.jsonLd] }) }
}

type HeadTag =
  | { tag: 'title'; text: string }
  | { tag: 'meta'; attr: 'name' | 'property'; key: string; content: string }
  | { tag: 'link'; attrs: Record<string, string> }
  | { tag: 'script'; json: string }

function absolute(baseUrl: string, path: string, mode: TrailingSlash): string {
  const [p = '', query] = path.split('?')
  return `${baseUrl}${p === '/' ? '/' : presentHref(encodePath(p), mode)}${query === undefined ? '' : `?${query}`}`
}

const meta = (attr: 'name' | 'property', key: string, content: string): HeadTag => ({ tag: 'meta', attr, key, content })

/** Inlay's own tags for the page, before any Twitter tags. */
function inlayTags(input: HeadInput): HeadTag[] {
  const url = input.canonical === null ? null : absolute(input.baseUrl, input.canonical, input.trailingSlash)
  const tags: HeadTag[] = [{ tag: 'title', text: input.title }]
  if (input.description) tags.push(meta('name', 'description', input.description))
  if (url !== null) tags.push({ tag: 'link', attrs: { rel: 'canonical', href: url } })
  if (input.alternates.length >= 2) {
    for (const a of input.alternates) {
      tags.push({ tag: 'link', attrs: { rel: 'alternate', hreflang: a.locale, href: absolute(input.baseUrl, a.path, input.trailingSlash) } })
    }
    const def = input.alternates.find((a) => a.locale === input.defaultLocale)
    if (def) tags.push({ tag: 'link', attrs: { rel: 'alternate', hreflang: 'x-default', href: absolute(input.baseUrl, def.path, input.trailingSlash) } })
  }
  tags.push(meta('property', 'og:type', input.ogType))
  tags.push(meta('property', 'og:title', input.title))
  if (input.description) tags.push(meta('property', 'og:description', input.description))
  if (url !== null) tags.push(meta('property', 'og:url', url))
  if (input.image) tags.push(meta('property', 'og:image', input.image))
  if (input.article) {
    if (input.article.publishedTime !== null) tags.push(meta('property', 'article:published_time', input.article.publishedTime))
    tags.push(meta('property', 'article:modified_time', input.article.modifiedTime))
  }
  if (input.preview || url === null) tags.push(meta('name', 'robots', 'noindex'))
  return tags
}

const linkKey = (attrs: Record<string, string>) => JSON.stringify([attrs.rel?.toLowerCase() ?? '', attrs.hreflang ?? null])

/** The collected tags merged into Inlay's: Inlay's surviving tags, then the template's metas, links and JSON-LD. */
function merge(inlay: HeadTag[], collected: CollectedHead, preview: boolean): { inlay: HeadTag[]; template: HeadTag[] } {
  const metas = new Map<string, HeadTag>()
  for (const m of collected.meta) {
    if (preview && m.key.toLowerCase() === 'robots') continue
    metas.set(m.key, meta(m.attr, m.key, m.content))
  }
  const inlayLinks = new Set(inlay.flatMap((t) => (t.tag === 'link' ? [linkKey(t.attrs)] : [])))
  const links = new Map<string, HeadTag>()
  for (const l of collected.links) {
    const attrs: Record<string, string> = {}
    for (const k of LINK_ATTRS) {
      const v = l[k]
      if (v !== undefined) attrs[k] = v
    }
    const key = linkKey(attrs)
    if (inlayLinks.has(key)) links.set(key, { tag: 'link', attrs })
    else {
      const exact = JSON.stringify(Object.entries(attrs))
      if (!links.has(exact)) links.set(exact, { tag: 'link', attrs })
    }
  }
  const replacedLinks = new Set([...links.keys()].filter((k) => inlayLinks.has(k)))
  const kept = inlay.filter((t) => {
    if (t.tag === 'meta') return !metas.has(t.key)
    if (t.tag === 'link') return !replacedLinks.has(linkKey(t.attrs))
    return true
  })
  const scripts: HeadTag[] = collected.jsonLd.map((json) => ({ tag: 'script', json }))
  return { inlay: kept, template: [...metas.values(), ...links.values(), ...scripts] }
}

/**
 * Inlay's tags with Twitter tags mirroring the final `og:*` values (Inlay's or the template's) before Inlay's
 * `robots` (or at the end), then the template's tags. A `twitter:*` key the template set is left to it.
 */
function withTwitter({ inlay, template }: { inlay: HeadTag[]; template: HeadTag[] }): HeadTag[] {
  const all = [...inlay, ...template]
  const has = (key: string) => all.some((t) => t.tag === 'meta' && t.key === key)
  const og = (key: string) => {
    const found = all.find((t) => t.tag === 'meta' && t.key === key)
    return found?.tag === 'meta' ? found.content : null
  }
  const twitter: HeadTag[] = [meta('name', 'twitter:card', og('og:image') === null ? 'summary' : 'summary_large_image')]
  for (const key of ['title', 'description', 'image']) {
    const content = og(`og:${key}`)
    if (content !== null) twitter.push(meta('name', `twitter:${key}`, content))
  }
  const mirrored = twitter.filter((t) => t.tag === 'meta' && !has(t.key))
  const robots = inlay.findIndex((t) => t.tag === 'meta' && t.key === 'robots')
  const at = robots < 0 ? inlay.length : robots
  return [...inlay.slice(0, at), ...mirrored, ...inlay.slice(at), ...template]
}

function serialize(tag: HeadTag): string {
  const e = escapeHtml
  switch (tag.tag) {
    case 'title':
      return `<title>${e(tag.text)}</title>`
    case 'meta':
      return `<meta ${tag.attr}="${e(tag.key)}" content="${e(tag.content)}">`
    case 'link':
      return `<link${Object.entries(tag.attrs).map(([k, v]) => ` ${k}="${e(v)}"`).join('')}>`
    case 'script':
      return `<script type="application/ld+json">${tag.json}</script>`
  }
}

export function buildHead(input: HeadInput): SafeHtml {
  const tags = merge(inlayTags(input), input.collected ?? NO_HEAD, input.preview)
  return raw(withTwitter(tags).map(serialize).join(''))
}

export function injectHead(html: string, head: SafeHtml): string {
  const i = html.search(/<\/head>/i)
  if (i < 0) return html
  return `${html.slice(0, i)}${head.value}${html.slice(i)}`
}
