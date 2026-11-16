import {
  defineBlock,
  defineCollection,
  defineGlobal,
  defineSingleton,
  defineSite,
  defineTemplate,
  f,
  z,
} from 'inlaycms/site'
import type { RenderContext, Renderable } from 'inlaycms/site'
import { content } from './content.js'
import { migrations } from './migrations.js'
import { contactRoutes } from './routes.js'

async function Layout({ ctx, children }: { ctx: RenderContext; children?: Renderable }) {
  const nav = await ctx.global(navGlobal)
  const footer = await ctx.global(footerGlobal)
  const links = (nav?.links ?? []).flatMap((item) => {
    const link = ctx.link(item.link)
    return link ? [link] : []
  })
  const other = ctx.alternates.filter((a) => a.locale !== ctx.locale && !a.fallback)
  return (
    <html lang={ctx.locale}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="stylesheet" href="/public/site.css" />
      </head>
      <body>
        <header class="site-header">
          <nav>
            {links.map((l) => (
              <a href={l.href}>{l.text}</a>
            ))}
          </nav>
          <span class="locales">
            {other.map((a) => (
              <a href={a.path} hreflang={a.locale}>
                {a.locale.toUpperCase()}
              </a>
            ))}
          </span>
        </header>
        {children}
        <footer class="site-footer">
          <p>{footer?.text ?? ''}</p>
        </footer>
      </body>
    </html>
  )
}

const Hero = defineBlock({
  name: 'hero',
  label: 'Hero',
  schema: z.object({
    headline: f.text({ label: 'Headline' }),
    intro: f.textarea({ label: 'Introduction' }).optional(),
    image: f.image({ label: 'Image' }).optional(),
    cta: f.link({ label: 'Button' }).optional(),
  }),
  render: (p, ctx) => {
    const image = ctx.image(p.image)
    const cta = ctx.link(p.cta)
    return (
      <section class="hero">
        {image && (
          <img
            src={image.src(960)}
            srcset={image.srcset()}
            sizes="100vw"
            alt={image.alt}
            width={image.width}
            height={image.height}
          />
        )}
        <h1>{p.headline}</h1>
        {p.intro && <p class="lead">{p.intro}</p>}
        {cta && (
          <a class="button" href={cta.href}>
            {cta.text}
          </a>
        )}
      </section>
    )
  },
})

const Features = defineBlock({
  name: 'features',
  label: 'Features',
  schema: z.object({
    items: f.list(
      z.object({
        title: f.text({ label: 'Title' }),
        text: f.textarea({ label: 'Text' }),
      }),
      { label: 'Features', itemLabel: 'Feature' },
    ),
  }),
  render: (p) => (
    <section class="features">
      {p.items.map((item) => (
        <div class="feature">
          <h2>{item.title}</h2>
          <p>{item.text}</p>
        </div>
      ))}
    </section>
  ),
})

const Testimonials = defineBlock({
  name: 'testimonials',
  label: 'Testimonials',
  schema: z.object({
    items: f.ref('testimonials', { label: 'Testimonials', many: true }),
  }),
  render: async (p, ctx) => {
    const items = await ctx.entries<{ quote: string; author: string }>(p.items)
    return (
      <section class="testimonials">
        {items.map((e) => (
          <blockquote>
            <p>{e.fields.quote}</p>
            <cite>{e.fields.author}</cite>
          </blockquote>
        ))}
      </section>
    )
  },
})

const Home = defineTemplate({
  name: 'home',
  label: 'Home page',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    seo: f.seo().optional(),
  }),
  slots: {
    hero: { block: Hero },
    features: { block: Features },
    testimonials: { block: Testimonials, optional: true },
  },
  render: ({ slots }, ctx) => (
    <Layout ctx={ctx}>
      <main>
        {slots.hero}
        {slots.features}
        {slots.testimonials}
      </main>
    </Layout>
  ),
})

function ContactForm({ ctx }: { ctx: RenderContext }) {
  const es = ctx.locale === 'es'
  return (
    <form class="contact" method="post" action="/contact">
      <h2>{es ? 'Escribenos' : 'Get in touch'}</h2>
      <input type="hidden" name="locale" value={ctx.locale} />
      <label>
        {es ? 'Tu email' : 'Your email'}
        <input type="email" name="email" required={true} />
      </label>
      <label>
        {es ? 'Mensaje' : 'Message'}
        <textarea name="message" rows="5"></textarea>
      </label>
      <button type="submit">{es ? 'Enviar' : 'Send'}</button>
    </form>
  )
}

const Page = defineTemplate({
  name: 'page',
  label: 'Page',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    body: f.richText({ label: 'Body' }),
    seo: f.seo().optional(),
  }),
  render: ({ fields, page }, ctx) => (
    <Layout ctx={ctx}>
      <main>
        <article>
          <h1>{fields.title}</h1>
          {ctx.richText(fields.body)}
        </article>
        {page.type === 'about' && <ContactForm ctx={ctx} />}
      </main>
    </Layout>
  ),
})

/** The answer to the contact form; rendered by the `/contact` route only. */
const ThankYou = defineTemplate({
  name: 'thankYou',
  label: 'Thank you',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    note: f.textarea({ label: 'Note' }),
  }),
  render: ({ fields }, ctx) => (
    <Layout ctx={ctx}>
      <main>
        <h1>{fields.title}</h1>
        <p>{fields.note}</p>
        <p>
          <a href={ctx.locale === 'es' ? '/es' : '/'}>{ctx.locale === 'es' ? 'Inicio' : 'Home'}</a>
        </p>
      </main>
    </Layout>
  ),
})

const BlogIndex = defineTemplate({
  name: 'blogIndex',
  label: 'Blog',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    seo: f.seo().optional(),
  }),
  render: async ({ fields }, ctx) => {
    const posts = await ctx.query('posts', { limit: 5, page: ctx.page, sort: { field: 'date', direction: 'desc' } })
    return (
      <Layout ctx={ctx}>
        <main>
          <h1>{fields.title}</h1>
          <ul class="posts">
            {posts.items.map((e) => (
              <li>
                <a href={e.url}>{e.title}</a> <time>{e.fields.date}</time>
              </li>
            ))}
          </ul>
          {posts.pages > 1 && (
            <p class="pager">
              {posts.page > 1 && <a href={`?page=${posts.page - 1}`}>Newer</a>}
              {` Page ${posts.page} of ${posts.pages} `}
              {posts.page < posts.pages && <a href={`?page=${posts.page + 1}`}>Older</a>}
            </p>
          )}
        </main>
      </Layout>
    )
  },
})

const Post = defineTemplate({
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
      <main>
        <article>
          <h1>{fields.title}</h1>
          <time>{fields.date}</time>
          {ctx.richText(fields.body)}
        </article>
      </main>
    </Layout>
  ),
})

const Service = defineTemplate({
  name: 'service',
  label: 'Service',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    summary: f.textarea({ label: 'Summary' }),
    seo: f.seo().optional(),
  }),
  render: ({ fields }, ctx) => (
    <Layout ctx={ctx}>
      <main>
        <article>
          <h1>{fields.title}</h1>
          <p>{fields.summary}</p>
        </article>
      </main>
    </Layout>
  ),
})

const NotFound = defineTemplate({
  name: 'notFound',
  label: 'Not found',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    message: f.textarea({ label: 'Message' }),
  }),
  render: ({ fields }, ctx) => (
    <Layout ctx={ctx}>
      <main>
        <h1>{fields.title}</h1>
        <p>{fields.message}</p>
        <p>
          <a href="/">Home</a>
        </p>
      </main>
    </Layout>
  ),
})

const Testimonial = defineTemplate({
  name: 'testimonial',
  label: 'Testimonial',
  fields: z.object({
    quote: f.textarea({ label: 'Quote' }),
    author: f.text({ label: 'Author' }),
  }),
})

const Nav = defineTemplate({
  name: 'nav',
  label: 'Navigation',
  fields: z.object({
    links: f.list(z.object({ link: f.link({ label: 'Link' }) }), { label: 'Links' }),
  }),
})

const Footer = defineTemplate({
  name: 'footer',
  label: 'Footer',
  fields: z.object({
    text: f.text({ label: 'Text' }),
  }),
})

const navGlobal = defineGlobal({
  name: 'nav',
  label: 'Navigation',
  help: 'The links across the top of every page.',
  template: Nav,
})

const footerGlobal = defineGlobal({
  name: 'footer',
  label: 'Footer',
  help: 'The short line at the bottom of every page.',
  template: Footer,
})

const posts = defineCollection({
  name: 'posts',
  label: 'Posts',
  help: 'Blog posts, newest first on the Blog page. Give each one a date.',
  template: Post,
  route: '/blog/:slug',
})

const services = defineCollection({
  name: 'services',
  label: 'Services',
  help: 'What the studio offers, one page per service with a short summary.',
  template: Service,
  route: '/services/:slug',
  customPaths: true,
})

const testimonials = defineCollection({
  name: 'testimonials',
  label: 'Testimonials',
  help: 'Quotes from happy clients, shown on the home page when its Testimonials section is switched on.',
  template: Testimonial,
  titleField: 'author',
})

export const guide = `A small web design studio's site, read by owners of small businesses looking for help with their website.
Write in a warm, plain and confident voice: short sentences, no jargon, no hype, and "we" for the studio.
Pages: Home (/), About (/about), Blog (/blog) and one page per service (/services/:slug).
Posts and services are collections; testimonials are quotes shown on the home page when that section is switched on.
The site is in English and Spanish (under /es). Spanish should read naturally, not word for word.
Keep headlines under about eight words and give every image a short, useful description.`

export const site = defineSite({
  locales: ['en', 'es'],
  defaultLocale: 'en',
  guide,
  admin: { name: 'Example Studio', logo: '/public/logo.svg' },
  notFound: 'notFound',
  secrets: ['SLACK_WEBHOOK'],
  routes: contactRoutes(ThankYou),
  migrations,
  singletons: [
    defineSingleton({
      name: 'home',
      label: 'Home',
      help: 'The front page: a hero with the main headline, a few features, and optional testimonials.',
      template: Home,
      path: '/',
    }),
    defineSingleton({
      name: 'about',
      label: 'About',
      help: 'Who we are and how we work.',
      template: Page,
      path: { en: '/about', es: '/acerca' },
    }),
    defineSingleton({
      name: 'blog',
      label: 'Blog',
      help: 'The blog index page. The list of posts fills itself in; only the title is edited here.',
      template: BlogIndex,
      path: '/blog',
    }),
    defineSingleton({
      name: 'notFound',
      label: 'Page not found',
      help: 'Shown when someone follows a broken link.',
      template: NotFound,
      path: null,
    }),
  ],
  collections: [posts, services, testimonials],
  globals: [navGlobal, footerGlobal],
  content,
})
