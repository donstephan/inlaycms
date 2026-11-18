# inlay

Inlay is a CMS for content sites. You build the site in code: its templates, the blocks they're made of, its collections, site-wide content and languages. The site's owner fills in the content, in the slots you cut for it. Everything lives in one SQLite file. Inlay is the whole server: you pack the site into a signed release, push it to a host running `inlaycms serve`, preview it on the live content and activate it when it's ready.

It's built for owners who run their site mostly by talking to an AI assistant, without ever being able to break the design the developer built:

- **No page builder.** Editors fill slots, so every arrangement a page can take is one the developer designed.
- **Problems are caught before deploy.** `inlaycms check` tells you whether the content fits new site code before you ship it.
- **The site belongs to its owner.** It runs on their server, with their data and their backups, and a documented export format.
- **One install per site.** An agency with ten clients runs ten installs, and can come back months later to push an update.

Read [why we made it](https://donstephan.github.io/inlaycms/why).

## Quickstart

Inlay needs Node 24 or newer, and Fastify 5. Or skip Node altogether and run every command through the Docker image: see [Without Node: the Docker image](https://donstephan.github.io/inlaycms/docs/docker).

```sh
npm install inlaycms fastify
npm install --save-dev typescript
```

Templates render with JSX, so point your `tsconfig.json` at Inlay's runtime:

```json
{
  "compilerOptions": {
    "module": "preserve",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "inlaycms",
    "strict": true
  }
}
```

Define the site in `site.tsx`. A template says which fields a page has and how it renders, and a singleton is one page built from it:

```tsx
import { defineContent, defineSingleton, defineSite, defineTemplate, f, z } from 'inlaycms/site'

const Page = defineTemplate({
  name: 'page',
  label: 'Page',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    body: f.richText({ label: 'Body' }),
  }),
  render: ({ fields }, ctx) => (
    <html lang={ctx.locale}>
      <head><title>{fields.title}</title></head>
      <body>
        <h1>{fields.title}</h1>
        {ctx.richText(fields.body)}
      </body>
    </html>
  ),
})

export const site = defineSite({
  locales: ['en'],
  defaultLocale: 'en',
  singletons: [
    defineSingleton({
      name: 'home',
      label: 'Home page',
      help: 'The front page of the site.',
      template: Page,
      path: '/',
    }),
  ],
  content: [
    defineContent('home', {
      edition: 1,
      content: { en: { fields: { title: 'Hello', body: 'Your first page. Ask your assistant to change it.' } } },
    }),
  ],
})
```

Point Inlay at it with `inlay.config.ts`, next to `site.tsx`:

```ts
import { defineConfig } from 'inlaycms/site'
import { site } from './site.js'

export default defineConfig({ site })
```

Then run it from source, and open `http://localhost:3000/admin` to create the owner account:

```sh
npx inlaycms dev
```

The [full quickstart](https://donstephan.github.io/inlaycms/docs/quickstart) explains each step, and what happens next.

## Documentation

The docs are at [donstephan.github.io/inlaycms](https://donstephan.github.io/inlaycms/):

- **Get started**: the quickstart, running Inlay through the Docker image without Node, and why Inlay exists.
- **Guides**: the content model, rich text, shipped content, releases and hosting, testing, connecting an assistant, the admin, search and sharing, backups, redirects, integrations and consent, security, proxies and CDNs, and the site password.
- **Reference**: every CLI command, config option, field type and environment variable.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
