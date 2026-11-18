---
title: Shipped content
---

# Shipped content

Content that ships inside a release: how editions and keys decide what gets replaced, and how to bring images and Markdown files along. Read it when you write the `content` of a site.

## Editions and keys

Use `defineContent` for a singleton or a global, and `defineEntries` for a collection's entries. Each document has a stable `key`: it is how Inlay knows a document in the release is the same one it already stored, so keep a key as it is once a site is live.

The `edition` decides what happens to a document that already exists. Bump it to replace what the client has with the new shipped content. An equal or lower edition leaves the owner's edits alone. A document that doesn't exist yet is created, but one the owner deleted stays deleted whatever its edition. Shipped content that is written (created or replaced) is published at once, not left as a draft.

Stored content is read against the current code: values that fit are used and the rest take their defaults, so a schema change never stops the site from starting.

Shipped content is applied on each `inlaycms dev` start and when a release is activated (see [Releases and hosting](/docs/guides/releases)). `inlaycms push` warns when a document's content changed but its edition didn't, since that change won't be applied: bump the edition to have it applied.

## Images in shipped content

Rich text in shipped content can show images from the site's folder (the folder holding `inlay.config.ts`). Name each one by its path from that folder, or by a `file:` URL:

```ts
defineContent('about', {
  edition: 1,
  content: {
    en: {
      fields: {
        body: [
          '![Our team](images/team.png)',
          '![The 2026 chart](<images/my chart (1).png>)',
          `![Logo](${new URL('./images/logo.png', import.meta.url)})`,
        ].join('\n\n'),
      },
    },
  },
})
```

The alt text is kept. Write a path with spaces or parentheses inside `<…>`. Each file is checked like an upload and added to the media library once, however many documents or ways of writing its path name it; `images/team.png`, `./images/team.png` and its `file:` URL are the same image. `inlaycms pack` puts the files in the release, so a host shows them without the site's folder.

Refused, each with the line it is on: an image on another website (`https://…`; a release never downloads anything, so download it into the folder), a path starting with `/` (that is an address on the site, not a file), a file outside the site's folder (`../`, or a link that leads out of it), a file that doesn't exist, and a file that isn't an image. An image already in the media library can still be named as `inlay:media/<id>`.

## Markdown files

Long rich text, such as a blog post, can live in its own `.md` file. Import it, and the import is the file's text:

```ts
import hello from './posts/hello.md'

defineEntries('posts', [
  { key: 'hello', edition: 1, content: { en: { slug: 'hello', fields: { title: 'Hello', body: hello } } } },
])
```

The whole file is the Markdown: there is no front matter, so the title, dates and other fields stay in your code. An image path in the file is relative to the file itself, so `posts/hello.md` names `posts/chart.png` as `![A chart](chart.png)` or `![A chart](./chart.png)`. The image must still be inside the site's folder, and is checked and packed as above. Write each image inline: an image written as a reference (`![A chart][chart]` with `[chart]: chart.png` further down) is refused, and `inlaycms dev`, `check` and `pack` name the file and line. The types for `.md` imports come with `inlaycms/site`, so TypeScript knows the import is a string.

### Rendering a Markdown file from a template

A `.md` file can also skip the content system and be rendered straight from a template with `await ctx.markdown(text)`. Choose it for text you own and keep in git: there is no edition to bump, and when you drop the file nothing is left behind in the database. The owner doesn't see it in the admin, so use shipped content when the client should be able to edit it.

```tsx
import colophon from './pages/colophon.md'

defineRoute({
  method: 'GET',
  path: '/colophon',
  handler: (_request, ctx) => ctx.render(Colophon, { fields: { title: 'Colophon' } }),
})

// in the Colophon template
render: async (_props, ctx) => <main>{await ctx.markdown(colophon, { headingIds: true })}</main>
```

Images beside the file are served from the release, at `/media/files/`. `inlay:key/<type>/<key>` links work too: they become links to the live page, and a page that doesn't exist or isn't published is shown as plain text.

Name each image by its path from the file, as above, or as `inlay:media/<id>` for an image already in the media library. Each picture file must end in `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` or `.avif`, and hold that kind of picture. SVG files are refused.

The Markdown is checked when the site loads, and `inlaycms dev`, `check` and `pack` refuse it, naming the file and the line, for raw HTML or anything else rich text can't hold, and for an image written as a reference, on another website (`https://…`; a release never downloads anything, so download it into the folder), starting with `/` (that is an address on the site, not a file), named any other way (`data:`, say, or an `inlay:` target that isn't a media library image), outside the site's folder, missing, not an image, an SVG file, ending in another extension or none, or holding another kind of picture than its extension says. Text a template passes to `ctx.markdown` that wasn't imported from a `.md` file isn't checked when the site loads: its images must come from the media library, and any other is an error when the page renders. See the [rich text guide](/docs/guides/rich-text#heading-links) for the options.
