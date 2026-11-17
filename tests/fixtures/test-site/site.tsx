import { defineContent, defineRoute, defineSingleton, defineSite, defineTemplate, f, z } from 'inlaycms/site'

function field(body: unknown, name: string): string {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined
  return typeof value === 'string' ? value : ''
}

const Home = defineTemplate({
  name: 'home',
  label: 'Home',
  fields: z.object({ title: f.text({ label: 'Title' }) }),
  render: ({ fields }) => (
    <html>
      <body>
        <h1>{fields.title}</h1>
      </body>
    </html>
  ),
})

export const site = defineSite({
  locales: ['en'],
  defaultLocale: 'en',
  secrets: ['HOOK'],
  singletons: [defineSingleton({ name: 'home', label: 'Home', template: Home, path: '/' })],
  routes: [
    defineRoute({
      method: 'POST',
      path: '/hook',
      handler: async (request, ctx) => {
        if (ctx.secrets.HOOK) await ctx.fetch(ctx.secrets.HOOK, { method: 'POST', body: field(request.body, 'text') })
        return { json: { hook: ctx.secrets.HOOK ?? null, other: ctx.secrets.OTHER ?? null } }
      },
    }),
  ],
  content: [defineContent('home', { edition: 1, content: { en: { fields: { title: 'Hello' } } } })],
})
