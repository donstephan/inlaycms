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

