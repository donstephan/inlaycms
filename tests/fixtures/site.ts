import { z } from 'zod'
import { f } from '../../src/core/fields/builtins.js'
import { defineContent, defineEntries } from '../../src/core/registry/content.js'
import {
  defineBlock,
  defineCollection,
  defineGlobal,
  defineSingleton,
  defineSite,
  defineTemplate,
  type SiteDefinition,
} from '../../src/core/registry/define.js'

export const Hero = defineBlock({
  name: 'hero',
  label: 'Hero',
  help: 'The large banner at the top of the page.',
  schema: z.object({
    headline: f.text({ label: 'Headline', help: 'Keep it under 8 words.', maxLength: 60 }),
    sub: f.text({ label: 'Subheading' }).optional(),
    image: f.image({ label: 'Image' }).optional(),
    cta: f.link({ label: 'Button' }).optional(),
    variant: f.select(['light', 'dark'], { label: 'Style', setting: true }).default('light'),
  }),
  render: (p) => `<section class="hero hero--${p.variant}"><h1>${p.headline}</h1></section>`,
})

export const Features = defineBlock({
  name: 'features',
  label: 'Features',
  schema: z.object({
    cards: f.list(
      z.object({
        title: f.text({ label: 'Title' }),
        body: f.textarea({ label: 'Body' }).optional(),
      }),
      { label: 'Cards', min: 1, max: 6 },
    ),
  }),
  render: (p) => `<ul>${p.cards.map((c) => `<li>${c.title}</li>`).join('')}</ul>`,
})

export const Quotes = defineBlock({
  name: 'quotes',
  label: 'Testimonials',
  schema: z.object({
    heading: f.text({ label: 'Heading' }).optional(),
    items: f.ref('testimonials', { label: 'Testimonials', many: true, max: 6 }),
  }),
  render: (p) => `<section>${p.heading ?? ''} (${p.items.length})</section>`,
})

export const HomePage = defineTemplate({
  name: 'homePage',
  label: 'Home page',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    seo: f.seo().optional(),
  }),
  slots: {
    hero: { block: Hero },
    features: { block: Features },
    quotes: { block: Quotes, optional: true },
  },
  render: (p) => `<main>${p.fields.title}</main>`,
})

export const BasicPage = defineTemplate({
  name: 'basicPage',
  label: 'Basic page',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    body: f.textarea({ label: 'Body' }),
  }),
  render: (p) => `<main><h1>${p.fields.title}</h1>${p.fields.body}</main>`,
})

export const Post = defineTemplate({
  name: 'post',
  label: 'Post',
  fields: z.object({
    title: f.text({ label: 'Title', maxLength: 120 }),
    date: f.date({ label: 'Date' }),
    body: f.textarea({ label: 'Body' }),
    related: f.ref('posts', { label: 'Related posts', many: true }).optional(),
    cta: f.link({ label: 'Call to action' }).optional(),
    seo: f.seo().optional(),
  }),
  render: (p) => `<article><h1>${p.fields.title}</h1>${p.fields.body}</article>`,
})

export const Testimonial = defineTemplate({
  name: 'testimonial',
  label: 'Testimonial',
  fields: z.object({
    quote: f.textarea({ label: 'Quote' }),
    author: f.text({ label: 'Author' }),
    photo: f.image({ label: 'Photo' }).optional(),
  }),
})

export const Nav = defineTemplate({
  name: 'nav',
  label: 'Navigation',
  fields: z.object({
    links: f.list(z.object({ link: f.link({ label: 'Link' }) }), { label: 'Links', max: 8 }),
  }),
})

export const site = defineSite({
  locales: ['en', 'es'],
  defaultLocale: 'en',
  singletons: [
    defineSingleton({
      name: 'home',
      label: 'Home',
      template: HomePage,
      path: '/',
    }),
    defineSingleton({
      name: 'about',
      label: 'About',
      template: BasicPage,
      path: { en: '/about', es: '/acerca' },
    }),
    defineSingleton({
      name: 'notFound',
      label: 'Page not found',
      template: BasicPage,
      path: null,
    }),
  ],
  collections: [
    defineCollection({ name: 'posts', label: 'Posts', template: Post, route: '/blog/:slug' }),
    defineCollection({
      name: 'testimonials',
      label: 'Testimonials',
      template: Testimonial,
      titleField: 'author',
    }),
  ],
  globals: [
    defineGlobal({ name: 'nav', label: 'Navigation', template: Nav }),
  ],
  content: [
    defineContent('home', {
      edition: 1,
      content: {
        en: {
          fields: { title: 'Home' },
          slots: {
            hero: { headline: 'Welcome to Inlay' },
            features: { cards: [{ title: 'Fast', body: 'Pages load quickly.' }] },
            quotes: false,
          },
        },
        es: {
          fields: { title: 'Inicio' },
          slots: {
            hero: { headline: 'Bienvenido a Inlay' },
            features: { cards: [{ title: 'Rápido', body: 'Las páginas cargan rápido.' }] },
            quotes: false,
          },
        },
      },
    }),
    defineContent('about', { edition: 1, content: { en: { fields: { title: 'About us', body: 'We build websites.' } } } }),
    defineContent('notFound', {
      edition: 1,
      content: { en: { fields: { title: 'Page not found', body: 'Sorry, that page does not exist.' } } },
    }),
    defineContent('nav', { edition: 1, content: { en: { fields: { links: [] } } } }),
    defineEntries('testimonials', [
      {
        key: 'maria',
        edition: 1,
        content: { en: { fields: { quote: 'Inlay made our site easy to update.', author: 'Maria' } } },
      },
    ]),
  ],
})

/** `s` without `locale`, and without the shipped content in it. */
export function withoutLocale(s: SiteDefinition, locale: string): SiteDefinition {
  return {
    ...s,
    locales: s.locales.filter((l) => l !== locale),
    content: s.content.map((c) => ({
      ...c,
      documents: c.documents.map((doc) => ({
        ...doc,
        content: Object.fromEntries(Object.entries(doc.content).filter(([l]) => l !== locale)),
      })),
    })),
  }
}
