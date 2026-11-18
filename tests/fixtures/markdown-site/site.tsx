import { defineCollection, defineRoute, defineSite, defineTemplate, f, z } from 'inlaycms/site'
import { content } from './content.js'
import links from './links.md'
import page from './page.md'

/** Rendered by routes only: an imported `.md` through `ctx.markdown`. */
const Page = defineTemplate({
  name: 'page',
  fields: z.object({ title: f.text({ label: 'Title' }), prefix: f.text({ label: 'Heading id prefix' }) }),
  render: ({ fields }, ctx) => (
    <html>
      <body>
        <main>{ctx.markdown(page, fields.prefix ? { headingIds: { prefix: fields.prefix } } : undefined)}</main>
      </body>
    </html>
  ),
})

const Plain = defineTemplate({
  name: 'plain',
  fields: z.object({ title: f.text({ label: 'Title' }) }),
  render: ({ fields }) => (
    <html>
      <body>{fields.title}</body>
    </html>
  ),
})

const Note = defineTemplate({
  name: 'note',
  fields: z.object({ title: f.text({ label: 'Title' }), body: f.richText({ label: 'Body', headings: [1, 2, 3] }) }),
  render: ({ fields }, ctx) => (
    <html>
      <body>
        <main>{ctx.richText(fields.body)}</main>
      </body>
    </html>
  ),
})

/** Rendered by routes only: `ctx.markdown` of the given text. */
const Text = defineTemplate({
  name: 'text',
  fields: z.object({ title: f.text({ label: 'Title' }), text: f.text({ label: 'Text' }) }),
  render: ({ fields }, ctx) => (
    <html>
      <body>
        <main>{ctx.markdown(fields.text)}</main>
      </body>
    </html>
  ),
})

export const site = defineSite({
  locales: ['en'],
  defaultLocale: 'en',
  collections: [
    defineCollection({ name: 'page', label: 'Pages', template: Plain, route: '/pages/:slug' }),
    defineCollection({ name: 'note', label: 'Notes', template: Note, route: '/notes/:slug' }),
  ],
  content,
  routes: [
    defineRoute({
      method: 'GET',
      path: '/links',
      handler: (_request, ctx) => ctx.render(Text, { fields: { title: 'Links', text: links } }),
    }),
    defineRoute({
      method: 'GET',
      path: '/broken',
      handler: (_request, ctx) => ctx.render(Text, { fields: { title: 'Broken', text: 'ok\n\n<div>x</div>\n' } }),
    }),
    defineRoute({ method: 'GET', path: '/page', handler: (_request, ctx) => ctx.render(Page, { fields: { title: 'Page' } }) }),
    defineRoute({
      method: 'GET',
      path: '/page-ids',
      handler: (_request, ctx) => ctx.render(Page, { fields: { title: 'Page', prefix: 'h-' } }),
    }),
  ],
})
