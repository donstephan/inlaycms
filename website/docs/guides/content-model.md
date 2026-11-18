---
title: Content model
---

# Content model

How a site's content is shaped, and what its fields can hold. Read it once you have a site running and want to model your own content; the full option lists are in [Config](/docs/reference/config) and [Field types](/docs/reference/fields).

A site is made of a few kinds of parts, all defined in code:

- A **template** (`defineTemplate`) holds a document's fields and renders them to HTML.
- A **singleton** is a content type with one document, such as a home page.
- A **collection** is a content type with many entries, such as posts, each with its own slug.
- A **global** is a single document shared by every page, such as a footer or site settings.
- A **block** (`defineBlock`) is a group of fields with its own rendering, which fills a template's slot.
- A **slot** is a named place in a template that holds exactly one block, chosen in code. An optional slot can be switched off in the admin.
- **Languages** are the site's translations: each document can hold content in every language the site declares.

`example/site.tsx` in the repository uses all of them. Shipped content for these parts is covered in [Shipped content](/docs/guides/shipped-content). For formatted text, code and tables, see [Rich text](/docs/guides/rich-text).

## Publish dates

`entry.publishedAt` (from `ctx.entries` and `ctx.query`) and `page.publishedAt` (in a template) are when Inlay first published the document, as an ISO time, or `null` for a draft that was never published (seen in preview) and for a route's page. It is set once and never moves, however often the document is edited or republished. A page of `ogType: 'article'` gets it as `article:published_time`.

`ctx.query('posts', { sort: 'published' })` lists the newest first-publish first, with never-published entries last; ties keep the newest-created first. A post migrated from another site keeps its original date in its own `f.date` field, which you can sort by with `{ sort: { field: 'date', direction: 'desc' } }`.

## Multi-select

`f.multiSelect(options, { label, min, max })` picks any number of a fixed list of options, such as tags:

```ts
tags: f.multiSelect(['green', 'blue', 'red'] as const, { label: 'Tags', min: 0, max: 3 }),
```

The value is an array of the options, saved in the options' order without duplicates, and `[]` when nothing is chosen. A draft may hold any number of them; `min` and `max` are checked when it is published. The admin shows one checkbox per option, labelled with the option itself, as `f.select` does. Assistants read and write the array as it is.

To list the entries with a tag, filter them in a template:

```ts
const faqs = await ctx.query('faqs', { filter: (e) => e.fields.tags.includes('green') })
```

An option you remove from the code drops out of the value when it is read, in the admin, on the site and over MCP, while the other options stay; the next save stores the value without it. Export keeps what is stored, so a backup loses nothing.


## Designed pages

Some pages are designed around their exact words: a home page whose headline has to fit on two lines, or a landing page with three columns of equal length. Letting the owner edit that text would break the design, so write the words straight into the template and give it no fields and no slots:

```tsx
const copy = {
  en: { headline: 'Websites for small businesses', lead: 'Designed, built and looked after by one studio.' },
  es: { headline: 'Webs para pequeños negocios', lead: 'Diseñadas, hechas y cuidadas por un solo estudio.' },
}

const Home = defineTemplate({
  name: 'home',
  fields: z.object({}),
  render: (_props, ctx) => {
    const text = copy[ctx.locale as keyof typeof copy] ?? copy.en
    return (
      <main>
        <h1>{text.headline}</h1>
        <p>{text.lead}</p>
      </main>
    )
  },
})
```

Make it a singleton, and ship its document once so the page exists and is published, in each language the site has:

```ts
defineContent('home', { edition: 1, content: { en: { fields: {} }, es: { fields: {} } } })
```

From then on, changing the words is a change to the code: there is no edition to bump, and a release (or a restart of `inlaycms dev`) shows it. The owner still sees the page in the admin, can link to it and publish or unpublish it, but its editor says the page is designed in code and that the developer changes it, and the Pages list marks it **Designed in code**. Assistants are told the same, and their edits to it are refused with that message.

For long text such as an "about this site" page, keep it in a `.md` file and render it with [`ctx.markdown`](/docs/guides/shipped-content#rendering-a-markdown-file-from-a-template). If the owner should change one part of a designed page, such as an announcement line, put that part in a global the template reads, and leave the rest in code.

### Images in a designed page

Import an image into the template and show it with `ctx.image`. The file must be inside the site's folder, and end in `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` or `.avif`:

```tsx
import hero from './hero.jpg'

render: (_props, ctx) => {
  const img = ctx.image(hero, { alt: 'The studio at dusk' })
  return (
    <img
      src={img.src(1280)}
      srcset={img.srcset()}
      sizes="100vw"
      alt={img.alt}
      width={img.width}
      height={img.height}
    />
  )
}
```

`ctx.image` returns the same kind of image as for a media library image: `url`, `src(width, format?)`, `srcset(format?)`, `width`, `height`, `alt` and `mime`. Variants are made at 320 to 2560 pixels wide, as WebP unless you ask for another format, and are served at `/media/files/`. The width and height let the browser keep room for the image before it loads. `alt` also replaces the alt text of a library image, if you pass one.

For a different crop on phones, import two images and use a `<picture>`:

```tsx
<picture>
  <source media="(max-width: 600px)" srcset={narrow.srcset()} sizes="100vw" />
  <img src={wide.src(1280)} srcset={wide.srcset()} sizes="100vw" alt={wide.alt} width={wide.width} height={wide.height} />
</picture>
```

The import is checked when the site loads, and `inlaycms dev`, `check` and `pack` refuse it if the file is outside the site's folder, is an SVG, or isn't the kind of picture its extension says. `pack` ships the file in the release.
