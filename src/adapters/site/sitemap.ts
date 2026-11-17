import { escapeHtml } from '../../jsx/html.js'
import { encodePath } from '../../core/site/paths.js'

interface Item {
  path: string
  updatedAt?: string
  alternates: Array<{ locale: string; path: string }>
}

export function renderSitemap(entries: readonly Item[], baseUrl: string): string {
  const url = (path: string) => escapeHtml(`${baseUrl}${path === '/' ? '/' : encodePath(path)}`)
  const items = entries.map((e) => {
    const links = e.alternates.map(
      (a) => `<xhtml:link rel="alternate" hreflang="${escapeHtml(a.locale)}" href="${url(a.path)}"/>`,
    )
    return `<url><loc>${url(e.path)}</loc>${e.updatedAt === undefined ? '' : `<lastmod>${escapeHtml(e.updatedAt.slice(0, 10))}</lastmod>`}${links.join('')}</url>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${items.join('')}</urlset>\n`
}
