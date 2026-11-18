---
title: Quickstart
---

# Quickstart

This page takes you from an empty folder to a site running on your computer: install Inlay, define one page in code and run it with `inlaycms dev`. It's the place to start if you're building a site on Inlay.

Inlay needs Node 24 or newer, and Fastify 5. Or skip Node altogether and run every command through the Docker image: see [Without Node: the Docker image](/docs/docker).

## Install

```sh
npm install inlaycms fastify
npm install --save-dev typescript
```

TypeScript is optional: `inlaycms pack` type-checks the site when it's installed. The CLI loads the site's TypeScript and JSX itself, so no loader such as tsx is needed.

Templates render with JSX, so point your `tsconfig.json` at Inlay's runtime. Inlay bundles the site's code itself, so type-check it as bundled code, which also needs no `"type": "module"` in `package.json`:

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

## Define the site

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

Labels and `help` are what editors and their assistants see, so write them for the owner, not for yourself. `content` is the content shipped with the site, here the home page's first text; [Shipped content](/docs/guides/shipped-content) explains editions, keys and shipping a collection's entries. Collections, globals, blocks, slots and more languages work the same way. [`example/site.tsx`](https://github.com/donstephan/inlaycms/blob/main/example/site.tsx) uses all of them, and the [content model](/docs/guides/content-model) guide covers what fields can hold.

## Point Inlay at it

Point Inlay at it with `inlay.config.ts`, next to `site.tsx`:

```ts
import { defineConfig } from 'inlaycms/site'
import { site } from './site.js'

export default defineConfig({ site })
```

## Run it

Then run it from source:

```sh
npx inlaycms dev
```

`inlaycms dev` serves the site at `http://localhost:3000` (`--port` changes the port, `--config` the config file) and restarts it whenever you save a file in the site's folder. Its database, media and backups go in `data/` next to the config file; keep that folder out of git. It needs no settings: `INLAY_BASE_URL` defaults to the local address and `INLAY_SECRET` to a fixed development value, and any other `INLAY_` setting from [Running a host](/docs/guides/releases#running-a-host) can still be set. Set the secrets the site declares in the environment, as on a host.

On each start, Inlay brings the database up to date and applies the shipped content: documents that don't exist yet are created, and ones with a newer edition are replaced. Stored content is read against the current code: values that fit are used and the rest take their defaults, so a schema change never stops the site from starting. Open `http://localhost:3000` for the site and `http://localhost:3000/admin` to create the owner account. To run the site from an AI assistant, see [Connect your assistant](/docs/guides/assistant).

## Put it online

To put the site online, pack it into a release and run it on a host with `inlaycms serve`: see [Packing a release](/docs/guides/releases#packing-a-release) and [Running a host](/docs/guides/releases#running-a-host). The [CLI reference](/docs/reference/cli) lists every command, including `inlaycms check`, which you run before every deploy.

## Type-checking your site

If your site's `tsconfig.json` has `skipLibCheck: false`, `tsc` reports one error from better-auth's own type files, which Inlay depends on: `Cannot find module 'bun:sqlite'`. It comes from types for running under Bun, has no effect on a Node site, and isn't something your code or Inlay can fix. Leave `skipLibCheck` on (`true`), or ignore that one error.
