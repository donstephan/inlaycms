import { defineCollection, defineSite, type RedirectDef, type SiteDefinition } from '../../src/core/registry/define.js'
import { defineRoute } from '../../src/core/registry/route.js'
import { Page, webSite } from './web.js'

const rootCollection = (name: string, label: string) =>
  defineCollection({ name, label, template: Page, route: '/:slug' })

export const rootCollections = [
  rootCollection('pages', 'Pages'),
  rootCollection('services', 'Services'),
  rootCollection('guides', 'Guides'),
  rootCollection('cases', 'Cases'),
  rootCollection('events', 'Events'),
]

export function rootSite(redirects: RedirectDef[] = []): SiteDefinition {
  return defineSite({ ...webSite, collections: [...webSite.collections, ...rootCollections], redirects })
}

export const redirectSite = rootSite([
  { from: '/old-post', to: '/blog' },
  { from: '/g2', to: 'https://www.g2.com/products/example/reviews' },
  { from: '/old-landing', to: '/', status: 302 },
  { from: '/2019/:slug', to: '/blog/:slug' },
])

export const badRedirectSite = rootSite([{ from: '/admin/x', to: '/about' }])

/** Code routes and rules for the lowercase fallback: a route with capitals, and rules with and without. */
export const fallbackSite = defineSite({
  ...webSite,
  routes: [
    defineRoute({ method: 'GET', path: '/contact', handler: () => ({ body: 'contact' }) }),
    defineRoute({ method: 'GET', path: '/About-Us', handler: () => ({ body: 'about us' }) }),
  ],
  redirects: [
    { from: '/company/team', to: '/team' },
    { from: '/about-us', to: '/about' },
    { from: '/old', to: '/new', status: 302 },
    { from: '/Old-Page', to: '/blog' },
    { from: '/g2', to: 'https://www.g2.com/x' },
  ],
})
