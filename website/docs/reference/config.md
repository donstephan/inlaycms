---
title: Config
---

# Config

The options of `defineConfig`, `defineSite` and the other `define*` functions a site imports from `inlaycms/site`. The [Content model](/docs/guides/content-model) guide explains how the parts fit together; this page lists what each one takes. Fields have their own page: [Field types](/docs/reference/fields).

A site's code is checked when it loads, by `inlaycms dev`, `check`, `pack` and on a host. A definition that breaks one of the rules below stops it with a message naming the part at fault.

## defineConfig

`inlay.config.ts` default-exports `defineConfig(...)`, which points the CLI at the site:

```ts
import { defineConfig } from 'inlaycms/site'
import { site } from './site.js'

export default defineConfig({ site, db: './data/inlay.db' })
```

| Option | What it is |
| --- | --- |
| `site` | The site, from `defineSite`. Required. |
| `db` | The database file, for the commands that work on a database (`check`, `backup`, `export`, `import`, `restore-backup`, `create-owner`, `create-token`, `reset-password`). `--db` can give it instead. |
| `backups` | The backups folder. Default: `backups/` next to the database. |
| `media` | The media folder. Default: `media/` next to the database. |

Paths are relative to the config file. `inlaycms dev` doesn't read `db`: it keeps its database at `data/inlay.db` next to the config file (or in `INLAY_DATA_DIR`), so `db: './data/inlay.db'` points the database commands at the same one. A host has no config file at all; see [Config file or data folder](/docs/reference/cli#config-file-or-data-folder).

## defineSite

```ts
export const site = defineSite({
  locales: ['en', 'es'],
  defaultLocale: 'en',
  singletons: [...],
  collections: [...],
  globals: [...],
  content: [...],
})
```

| Option | What it is | Default |
| --- | --- | --- |
| `locales` | The site's languages, such as `['en', 'es']` or `['en', 'pt-BR']`: two or three lowercase letters, optionally followed by `-` parts. Each once. Required. | |
| `defaultLocale` | One of `locales`. Pages in other languages are served under their language's prefix, such as `/es`. Required. | |
| `singletons` | Content types with one document, from `defineSingleton`. | `[]` |
| `collections` | Content types with many entries, from `defineCollection`. | `[]` |
| `globals` | Single documents shared by every page, from `defineGlobal`. | `[]` |
| `translationFallback` | Serve the default language's page when a translation is missing. | `true` |
| `trailingSlash` | `'always'` serves page URLs with a trailing slash (`/about/`) and writes them that way in links, the canonical link, the sitemap and redirect targets; `'never'` leaves them as they are. See [Moving from a site with trailing slashes](/docs/guides/seo#moving-from-a-site-with-trailing-slashes). Needs Inlay 0.6.0 on the host. | `'never'` |
| `content` | Shipped content, from `defineContent` and `defineEntries`. See [Shipped content](/docs/guides/shipped-content). | `[]` |
| `guide` | Notes for assistants about the site: who reads it, its voice, its pages. Sent to every assistant that connects over MCP. | none |
| `admin` | The admin's `name`, `logo` (a URL path under `/public/`) and `theme`. See [Branding](/docs/guides/admin#branding). | `{}` |
| `seo` | Search and sharing defaults: `titleTemplate` (with `%s` exactly once), `description` and `image` (a path under `/public/`). See [Search and sharing](/docs/guides/seo). | `{}` |
| `notFound` | The name of a singleton with `path: null` and a `render`, rendered with status 404 when no page matches. | none |
| `publicPaths` | Exact paths that answer without the site password, such as `/healthz`. Each starts with `/`. See [Site password](/docs/guides/site-password). | `[]` |
| `secrets` | The names of the secrets the host provides, such as `SLACK_WEBHOOK`: uppercase letters, digits and `_`, starting with a letter. Routes read them as `ctx.secrets`. | `[]` |
| `headers` | Response headers laid over Inlay's security defaults, by name: a string replaces the default, `false` leaves it out. See [Security headers](/docs/guides/security#security-headers). | `{}` |
| `integrations` | Third-party scripts the owner can switch on, from `defineIntegration`. | `[]` |
| `csp` | Sources the site's own pages need in the Content-Security-Policy, by directive. See [Security headers](/docs/guides/security#security-headers). | `{}` |
| `routes` | The site's own routes, from `defineRoute`. | `[]` |
| `redirects` | Redirects shipped with the code: `{ from, to, status? }`. See [Redirects](/docs/guides/redirects). | `[]` |
| `migrations` | Migration functions, from `defineMigration`. | `[]` |

Type names (of singletons, collections and globals) start with a lowercase letter and hold only letters, digits and `_`, and are unique on the site. Two singletons can't have the same path in the same language.

`headers` can't set the headers Inlay manages per response: `Cache-Control`, `Connection`, `Content-Length`, `Content-Type`, `ETag`, `Location`, `Set-Cookie`, `Transfer-Encoding` and `Vary`.

The `csp` directives are `script-src`, `style-src`, `img-src`, `font-src`, `connect-src`, `frame-src`, `media-src`, `form-action` and `worker-src`. A source is an origin (`https://images.example.com`, `https://*.example.com`), a bare scheme such as `data:`, or one of `'unsafe-inline'`, `'unsafe-eval'` and `'wasm-unsafe-eval'`.

## defineTemplate

A template says which fields a document has and how it renders.

```tsx
const Page = defineTemplate({
  name: 'page',
  label: 'Page',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    body: f.richText({ label: 'Body' }),
  }),
  slots: { hero: { block: Hero, optional: true } },
  render: ({ fields, slots }, ctx) => (
    <html lang={ctx.locale}>
      <body>
        {slots.hero}
        <h1>{fields.title}</h1>
        {ctx.richText(fields.body)}
      </body>
    </html>
  ),
})
```

| Option | What it is |
| --- | --- |
| `name` | The template's name, unique on the site. Required. |
| `label` | What editors see. |
| `fields` | `z.object({ ... })` of fields from [Field types](/docs/reference/fields). Field names start with a lowercase letter and hold only letters, digits and `_`. Required. |
| `slots` | Named places that each hold one block: `{ name: { block, label?, optional? } }`. An optional slot can be switched off in the admin. Slot order is key order. |
| `ogType` | `'website'` (the default) or `'article'`, the page's Open Graph type. See [Search and sharing](/docs/guides/seo). |
| `render` | `(props, ctx)`, returning JSX. `props` holds `fields`, `slots` (each slot's rendered block, or `null` when an optional slot is off), `data` (each slot's stored data, or `null`) and `page`. Needed for any template whose documents are pages; a global's template can leave it out. |

A template used by several types is the same object each time: two different templates can't share a name.

## defineBlock

A block is a group of fields with its own rendering, placed in a template's slot.

| Option | What it is |
| --- | --- |
| `name` | The block's name, unique on the site. Required. |
| `label` | What editors see. Required. |
| `help` | A line of help for editors and assistants. |
| `schema` | `z.object({ ... })` of fields. Required. |
| `render` | `(props, ctx)`, where `props` is the slot's stored data, returning JSX. |

## defineSingleton

A content type with exactly one document, such as a home page.

| Option | What it is |
| --- | --- |
| `name` | The type's name. Required. |
| `label` | What editors see. Required. |
| `help` | What the page is for, for editors and assistants. |
| `template` | The template its document uses. Required. |
| `path` | Its address: a path such as `'/about'`, a path per language such as `{ en: '/about', es: '/acerca' }` (which must include the default language), or `null` for a document with no page of its own, such as the 404 page. Required. |

A path starts with `/`, has no `?` or `#`, doesn't start with a language code, and isn't one of Inlay's own paths: `/admin`, `/mcp`, `/media`, `/public`, `/_inlay`, `/api/auth`, `/.well-known`, `/sitemap.xml` and `/robots.txt`, and anything under them.

## defineCollection

A content type with many entries, such as posts.

| Option | What it is | Default |
| --- | --- | --- |
| `name` | The type's name. Required. | |
| `label` | What editors see. Required. | |
| `help` | What the entries are for. | none |
| `template` | The template its entries use. Required. | |
| `route` | A URL pattern with `:slug` exactly once, such as `'/blog/:slug'`, giving each entry a page. `null` for a collection of data with no pages, such as testimonials. | `null` |
| `customPaths` | Let editors give an entry a path of its own. | `false` |
| `group` | A heading for the collection in the admin's menu. See [Menu groups](/docs/guides/admin#menu-groups). | none |
| `titleField` | The field holding an entry's title. It must be an `f.text` field. | `'title'` |

## defineGlobal

A single document shared by every page, such as a footer or site settings. Templates read it with `ctx.global(name)`.

| Option | What it is |
| --- | --- |
| `name` | The type's name. Required. |
| `label` | What editors see. Required. |
| `help` | What it holds. |
| `template` | The template that holds its fields. Required. |

## defineContent

```ts
defineContent('home', {
  edition: 1,
  content: { en: { fields: { title: 'Hello' } } },
})
```

Ships the document of a singleton or global. It takes the type's name and:

- `edition`: a whole number of 1 or more. Bump it to replace what the site has with the new shipped content; an equal or lower edition leaves the owner's edits alone.
- `content`: the document by language, each with `fields`, and optionally `slots` (each slot's data, or `false` for an optional slot that's off), `slug` and `path`. Every language must be one of the site's.

Its key is the type's name. See [Shipped content](/docs/guides/shipped-content).

## defineEntries

```ts
defineEntries('posts', [
  { key: 'hello', edition: 1, content: { en: { slug: 'hello', fields: { title: 'Hello' } } } },
])
```

Ships entries of a collection. It takes the collection's name and a list of entries, each with:

- `key`: a stable name for the entry, unique in the collection: lowercase letters and digits with single hyphens, up to 100 characters.
- `edition` and `content`: as for `defineContent`.

Each type's shipped content is given once: one `defineContent` or `defineEntries` per type. See [Shipped content](/docs/guides/shipped-content).

## defineRoute

A route of the site's own, such as a form handler.

```ts
defineRoute({
  method: 'GET',
  path: '/healthz',
  handler: async () => ({ body: 'ok' }),
})
```

| Option | What it is |
| --- | --- |
| `method` | `'GET'` or `'POST'`. Required. |
| `path` | An exact path, with no `:`, `*`, `?`, `#` or `%`. It can't be `/` or one of Inlay's own paths, or hide a page of the site's. One route per method and path. Required. |
| `sitemap` | `true` lists a GET route in the sitemap; the pages its `ctx.render` returns get a canonical link and can be indexed. See [Routes in the sitemap](/docs/guides/seo#routes-in-the-sitemap). |
| `handler` | `(request, ctx)`, returning a response or a promise of one. Required. |

`request` holds `method`, `path`, `query`, `headers` (lowercased, without `cookie` and `authorization`: routes are anonymous), `body` (form fields for a form, parsed JSON for JSON, `null` otherwise) and `locale` (the `locale` query or form field when it names one of the site's languages, else the default).

`ctx` holds:

- `query`: `query`, `global` and `entries`, for published content.
- `render(template, data?, { status? })`: renders a template into a response.
- `redirect(location, status?)`: a 303 (the default) or 302 response.
- `fetch`: for outgoing requests.
- `secrets`: the values of the secrets the site declares.
- `baseUrl`, `locale`, and `asset(path)` for a versioned `/public/` URL.

A response is `{ status?, headers?, body?, json? }`. `json` wins over `body`, and `status` defaults to 200, or 204 when there's neither.

## defineMigration

A migration function changes stored content when a release changes its shape. Each runs once per release, in order, when the release is activated, inside the activation's transaction (see [Running a host](/docs/guides/releases#running-a-host)).

```ts
defineMigration({
  name: '2026-11-rename-summary',
  async run(ctx) {
    for (const doc of await ctx.list('services')) {
      const { head } = await ctx.read(doc.id)
      if (!head) continue
      const { summary, ...fields } = head.fields
      await ctx.save(doc.id, { ...head, fields: { ...fields, intro: summary } })
    }
  },
})
```

- `name`: unique among the site's migrations. Required.
- `run(ctx)`: an async function. `ctx` has `types()`, `list(type, { locale?, includeDeleted? })`, `read(id)` (the document's `head` draft and `published` data, as stored), `create(type, input)`, `save(id, data)` (writes the head draft), `publish(ids)` and `media.list()`.

## defineIntegration

A third-party script the developer ships and the owner switches on in the admin.

| Option | What it is |
| --- | --- |
| `name` | Lowercase letters and digits with single hyphens, unique on the site. Renaming it makes a new integration. Required. |
| `label`, `description` | Shown on the Integrations screen. `label` is required. |
| `fields` | What the owner fills in, as `z.object({ ... })`: only `f.text`, `f.textarea`, `f.number`, `f.boolean` and `f.select`, at the top level, and none named `enabled`. Left out, the integration is just a switch. |
| `consent` | `'analytics'`, `'marketing'` or `'functional'`: its output waits until the visitor agrees to that category. |
| `preview` | Also render in preview. Default `false`. |
| `csp` | The sources it needs, by directive, added while it's switched on. |
| `head`, `bodyStart`, `bodyEnd` | At least one. Each gets `(values, page)` and returns JSX or `null`. |

See [Integrations](/docs/guides/integrations#integrations) and [Consent](/docs/guides/integrations#consent).

## defineField

`defineField(schema, meta)` makes a field type of your own. See [Field types](/docs/reference/fields#definefield).
