import { defineContent, defineEntries, type ShippedContent, type ShippedDocument } from '../../src/core/registry/content.js'
import { defineSite, type SiteDefinition } from '../../src/core/registry/define.js'
import { site } from './site.js'

export const maria: ShippedDocument = {
  key: 'maria',
  edition: 1,
  content: {
    en: { fields: { quote: 'Inlay just works.', author: 'Maria' } },
    es: { fields: { quote: 'Inlay simplemente funciona.', author: 'Maria' } },
  },
}

export const homeShipped = (edition: number, headline = 'Welcome', quotes: Array<{ key: string }> = [{ key: 'maria' }]): ShippedContent =>
  defineContent('home', {
    edition,
    content: {
      en: {
        fields: { title: 'Home' },
        slots: {
          hero: { headline, variant: 'light', cta: { document: { type: 'about' }, text: 'About' } },
          features: { cards: [{ title: 'Fast' }] },
          quotes: { items: quotes },
        },
      },
      es: {
        fields: { title: 'Inicio' },
        slots: { hero: { headline: 'Bienvenido', variant: 'light' }, features: { cards: [{ title: 'Rápido' }] }, quotes: false },
      },
    },
  })

export const aboutShipped = defineContent('about', {
  edition: 1,
  content: { en: { fields: { title: 'About us', body: 'We build websites.' } } },
})

export const navShipped = defineContent('nav', {
  edition: 1,
  content: {
    en: {
      fields: {
        links: [
          { link: { document: { type: 'about' }, text: 'About' } },
          { link: { document: { type: 'home' }, text: 'Home' } },
        ],
      },
    },
  },
})

export const post = (key: string, patch: Record<string, unknown> = {}, slug?: string): ShippedDocument => ({
  key,
  edition: 1,
  content: { en: { ...(slug ? { slug } : {}), fields: { title: `Post ${key}`, date: '2026-01-01', body: 'Text', ...patch } } },
})

export const DEFAULT_CONTENT: ShippedContent[] = [homeShipped(1), aboutShipped, navShipped, defineEntries('testimonials', [maria])]

export function shippedSite(content: ShippedContent[] = DEFAULT_CONTENT): SiteDefinition {
  return defineSite({ ...site, content })
}
