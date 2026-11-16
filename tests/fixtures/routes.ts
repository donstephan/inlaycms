import { defineCollection, defineSite, type SiteDefinition } from '../../src/core/registry/define.js'
import { site, Post } from './site.js'

/** The fixture site with `posts` allowing custom paths. */
export function routedSite(opts: { translationFallback?: boolean } = {}): SiteDefinition {
  return defineSite({
    locales: site.locales,
    defaultLocale: site.defaultLocale,
    singletons: site.singletons,
    globals: site.globals,
    content: site.content,
    collections: site.collections.map((c) =>
      c.name === 'posts' ? defineCollection({ name: 'posts', label: 'Posts', template: Post, route: '/blog/:slug', customPaths: true }) : c,
    ),
    ...(opts.translationFallback !== undefined && { translationFallback: opts.translationFallback }),
  })
}
