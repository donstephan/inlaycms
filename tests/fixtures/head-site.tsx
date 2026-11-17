import { z } from 'zod'
import { f } from '../../src/core/fields/builtins.js'
import { defineContent } from '../../src/core/registry/content.js'
import {
  defineBlock,
  defineCollection,
  defineGlobal,
  defineSingleton,
  defineSite,
  defineTemplate,
  type SeoSettings,
  type SiteDefinition,
} from '../../src/core/registry/define.js'
import type { Renderable } from '../../src/jsx/html.js'

function Layout({ children }: { children?: Renderable }) {
  return (
    <html>
      <head>
        <meta charset="utf-8" />
      </head>
      <body>{children}</body>
    </html>
  )
}

/** Adds an FAQPage to the head through `ctx.head.jsonLd`. */
const Faq = defineBlock({
  name: 'faq',
  label: 'FAQ',
  schema: z.object({
    question: f.text({ label: 'Question' }),
    answer: f.text({ label: 'Answer' }),
  }),
  render: (p, ctx) => {
    ctx.head.jsonLd({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [{ '@type': 'Question', name: p.question, acceptedAnswer: { '@type': 'Answer', text: p.answer } }],
    })
    return (
      <section class="faq">
        <h2>{p.question}</h2>
        <p>{p.answer}</p>
      </section>
    )
  },
})

const Page = defineTemplate({
  name: 'page',
  label: 'Page',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    seo: f.seo().optional(),
  }),
  slots: { faq: { block: Faq, optional: true } },
  render: ({ fields, slots }) => (
    <Layout>
      <h1>{fields.title}</h1>
      {slots.faq}
    </Layout>
  ),
})

const Post = defineTemplate({
  name: 'post',
  label: 'Post',
  ogType: 'article',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    seo: f.seo().optional(),
  }),
  render: ({ fields }) => (
    <Layout>
      <article>{fields.title}</article>
    </Layout>
  ),
})

const Settings = defineTemplate({
  name: 'settings',
  label: 'Site settings',
  fields: z.object({ defaults: f.seoDefaults().optional() }),
})

/** A two-locale site with SEO defaults in code (`seo`) and in its `settings` global. */
export function headSite(seo: SeoSettings = {}): SiteDefinition {
  return defineSite({
    locales: ['en', 'es'],
    defaultLocale: 'en',
    seo,
    singletons: [
      defineSingleton({ name: 'home', label: 'Home', template: Page, path: '/' }),
      defineSingleton({ name: 'about', label: 'About', template: Page, path: { en: '/about', es: '/acerca' } }),
      defineSingleton({ name: 'notFound', label: 'Not found', template: Page, path: null }),
    ],
    collections: [defineCollection({ name: 'posts', label: 'Posts', template: Post, route: '/blog/:slug' })],
    globals: [defineGlobal({ name: 'settings', label: 'Site settings', template: Settings })],
    notFound: 'notFound',
    content: [
      defineContent('home', {
        edition: 1,
        content: { en: { fields: { title: 'Home' } }, es: { fields: { title: 'Inicio' } } },
      }),
      defineContent('about', {
        edition: 1,
        content: { en: { fields: { title: 'About' } }, es: { fields: { title: 'Acerca' } } },
      }),
      defineContent('notFound', {
        edition: 1,
        content: { en: { fields: { title: 'Not found' } }, es: { fields: { title: 'No encontrado' } } },
      }),
      defineContent('settings', { edition: 1, content: { en: { fields: {} }, es: { fields: {} } } }),
    ],
  })
}
