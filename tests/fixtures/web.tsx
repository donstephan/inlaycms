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
} from '../../src/core/registry/define.js'
import type { RenderContext } from '../../src/core/registry/render.js'
import type { Renderable } from '../../src/jsx/html.js'

type Quote = { quote: string; author: string }

async function Layout({ ctx, children }: { ctx: RenderContext; children?: Renderable }) {
  const nav = await ctx.global(navGlobal)
  const links = (nav?.links ?? []).flatMap((item) => {
    const link = ctx.link(item.link)
    return link ? [link] : []
  })
  return (
    <html lang={ctx.locale}>
      <head>
        <meta charset="utf-8" />
      </head>
      <body>
        <nav>
          {links.map((l) => (
            <a href={l.href}>{l.text}</a>
          ))}
        </nav>
        {children}
      </body>
    </html>
  )
}

export const Hero = defineBlock({
  name: 'hero',
  label: 'Hero',
  schema: z.object({
    headline: f.text({ label: 'Headline' }),
    image: f.image({ label: 'Image' }).optional(),
    cta: f.link({ label: 'Button' }).optional(),
  }),
  render: (p, ctx) => {
    const image = ctx.image(p.image)
    const cta = ctx.link(p.cta)
    return (
      <section class="hero">
        <h1>{p.headline}</h1>
        {image && (
          <img
            src={image.src(960)}
            srcset={image.srcset()}
            alt={image.alt}
            width={image.width}
            height={image.height}
          />
        )}
        {cta && (
          <a class="button" href={cta.href}>
            {cta.text}
          </a>
        )}
      </section>
    )
  },
})

export const Quotes = defineBlock({
  name: 'quotes',
  label: 'Testimonials',
  schema: z.object({
    items: f.ref('testimonials', { label: 'Testimonials', many: true }),
  }),
  render: async (p, ctx) => {
    const items = await ctx.entries<Quote>(p.items)
    return (
      <section class="quotes">
        {items.map((e) => (
          <blockquote>
            {e.fields.quote}
            <cite>{e.fields.author}</cite>
          </blockquote>
        ))}
      </section>
    )
  },
})

export const Home = defineTemplate({
  name: 'home',
  label: 'Home page',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    seo: f.seo().optional(),
  }),
  slots: {
    hero: { block: Hero },
    quotes: { block: Quotes, optional: true },
  },
  render: ({ fields, slots }, ctx) => (
    <Layout ctx={ctx}>
      <main>
        <h1 class="title">{fields.title}</h1>
        {slots.hero}
        {slots.quotes}
      </main>
    </Layout>
  ),
})

export const Page = defineTemplate({
  name: 'page',
  label: 'Page',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    body: f.richText({ label: 'Body' }),
    seo: f.seo().optional(),
  }),
  render: ({ fields }, ctx) => (
    <Layout ctx={ctx}>
      <article>
        <h1>{fields.title}</h1>
        {ctx.richText(fields.body)}
      </article>
    </Layout>
  ),
})

export const BlogIndex = defineTemplate({
  name: 'blogIndex',
  label: 'Blog',
  fields: z.object({ title: f.text({ label: 'Title' }) }),
  render: async ({ fields }, ctx) => {
    const posts = await ctx.query('posts', { limit: 2, page: ctx.page, sort: { field: 'date', direction: 'desc' } })
    return (
      <Layout ctx={ctx}>
        <h1>{fields.title}</h1>
        <ul class="posts">
          {posts.items.map((e) => (
            <li>
              <a href={e.url}>{e.title}</a>
            </li>
          ))}
        </ul>
        <p class="pages">{`Page ${posts.page} of ${posts.pages}`}</p>
      </Layout>
    )
  },
})

export const Post = defineTemplate({
  name: 'post',
  label: 'Post',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    date: f.date({ label: 'Date' }),
    body: f.richText({ label: 'Body' }),
    seo: f.seo().optional(),
  }),
  render: ({ fields }, ctx) => (
    <Layout ctx={ctx}>
      <article>
        <h1>{fields.title}</h1>
        <time>{fields.date}</time>
        {ctx.richText(fields.body)}
      </article>
    </Layout>
  ),
})

export const NotFound = defineTemplate({
  name: 'notFound',
  label: 'Not found',
  fields: z.object({ title: f.text({ label: 'Title' }) }),
  render: ({ fields }, ctx) => (
    <Layout ctx={ctx}>
      <h1>{fields.title}</h1>
    </Layout>
  ),
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
    links: f.list(z.object({ link: f.link({ label: 'Link' }) }), { label: 'Links' }),
  }),
})

export const navGlobal = defineGlobal({
  name: 'nav',
  label: 'Navigation',
  template: Nav,
})

export const posts = defineCollection({
  name: 'posts',
  label: 'Posts',
  template: Post,
  route: '/blog/:slug',
  customPaths: true,
})

export const testimonials = defineCollection({
  name: 'testimonials',
  label: 'Testimonials',
  template: Testimonial,
  titleField: 'author',
})

export const webSite = defineSite({
  locales: ['en', 'es'],
  defaultLocale: 'en',
  singletons: [
    defineSingleton({
      name: 'home',
      label: 'Home',
      template: Home,
      path: '/',
    }),
    defineSingleton({
      name: 'about',
      label: 'About',
      template: Page,
      path: { en: '/about', es: '/acerca' },
    }),
    defineSingleton({
      name: 'blog',
      label: 'Blog',
      template: BlogIndex,
      path: '/blog',
    }),
    defineSingleton({
      name: 'notFound',
      label: 'Page not found',
      template: NotFound,
      path: null,
    }),
  ],
  collections: [posts, testimonials],
  globals: [navGlobal],
  notFound: 'notFound',
  content: [
    defineContent('home', {
      edition: 1,
      content: {
        en: { fields: { title: 'Home' }, slots: { hero: { headline: 'Welcome to Inlay' }, quotes: false } },
        es: { fields: { title: 'Inicio' }, slots: { hero: { headline: 'Bienvenido a Inlay' }, quotes: false } },
      },
    }),
    defineContent('about', { edition: 1, content: { en: { fields: { title: 'About us', body: 'We build **websites**.' } } } }),
    defineContent('blog', { edition: 1, content: { en: { fields: { title: 'Blog' } } } }),
    defineContent('notFound', { edition: 1, content: { en: { fields: { title: 'Page not found' } } } }),
    defineContent('nav', { edition: 1, content: { en: { fields: { links: [{ link: { url: '/blog', text: 'Blog' } }] } } } }),
  ],
})
