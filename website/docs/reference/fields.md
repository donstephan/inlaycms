---
title: Field types
---

# Field types

Every `f.*` field builder, its options and the value it stores, plus `defineField` for a field type of your own. Fields go in a template's or block's `z.object({ ... })`; see [Config](/docs/reference/config#definetemplate) for where those live and the [Content model](/docs/guides/content-model) guide for how they fit together.

```ts
import { f, z } from 'inlaycms/site'

fields: z.object({
  title: f.text({ label: 'Title', maxLength: 120 }),
  intro: f.textarea({ label: 'Intro' }).optional(),
  tags: f.multiSelect(['green', 'blue', 'red'] as const, { label: 'Tags', max: 3 }),
})
```

## Options every field takes

- `label`: what editors and their assistants see. Required.
- `help`: a line of help shown under the field and given to assistants. Write it for the owner.
- `setting`: `true` marks a field that changes how something looks, not what it says, such as a layout choice. The admin shows it under Settings, and assistants are told what it is.

Every field is required unless it ends in `.optional()`. Drafts are checked loosely: a required field can be left empty, a list can hold fewer items than its `min`, and `pattern` and the multi-select limits wait. Everything is checked when the document is published.

## f.text

```ts
f.text({ label, help?, maxLength?, suggestedLength?, pattern?, patternHint? })
```

One line of plain text. Stores a string. A required text field can't be blank.

- `maxLength`: the most characters it may hold.
- `suggestedLength`: a soft limit beside `maxLength`: the admin shows a counter and a hint past it, and never blocks saving or publishing. See [Suggested length](/docs/guides/admin#suggested-length).
- `pattern`: a regular expression the text must match, such as `/^GTM-[A-Z0-9]+$/`. It's checked when the field isn't blank, at publish (and when an integration is switched on). Its `g` and `y` flags are ignored.
- `patternHint`: what to say when the text doesn't match, such as `'It looks like GTM-ABC123.'`.

## f.textarea

```ts
f.textarea({ label, help?, maxLength?, suggestedLength?, pattern?, patternHint? })
```

Several lines of plain text. Stores a string. Its options are the same as `f.text`'s.

## f.number

```ts
f.number({ label, help?, min?, max?, integer? })
```

Stores a number. `min` and `max` bound it, and `integer: true` allows only whole numbers.

## f.boolean

```ts
f.boolean({ label, help? })
```

A checkbox. Stores `true` or `false`, and is `false` when not set.

## f.select

```ts
f.select(['left', 'right'] as const, { label, help? })
```

One of a fixed list of options. Stores the chosen option as a string.

## f.multiSelect

```ts
f.multiSelect(['green', 'blue', 'red'] as const, { label, help?, min?, max? })
```

Any number of a fixed list of options. Stores an array of the options, in the options' order without duplicates, and `[]` when nothing is chosen. `min` and `max` are checked at publish. An option removed from the code drops out of the value when it's read. See [Multi-select](/docs/guides/content-model#multi-select).

## f.date

```ts
f.date({ label, help? })
```

A calendar date. Stores a string such as `'2026-11-18'`.

## f.datetime

```ts
f.datetime({ label, help? })
```

A date and time. Stores an ISO 8601 string with a time zone, such as `'2026-11-18T09:30:00Z'` or `'2026-11-18T09:30+01:00'`.

## f.link

```ts
f.link({ label, help? })
```

A link to a page of the site or to an address. Stores `{ document, text? }`, where `document` is a page's ID, or `{ url, text? }`. A `url` is a path on the site or an `http:`, `https:`, `mailto:` or `tel:` address.

## f.ref

```ts
f.ref('posts', { label, help?, many?, min?, max? })
```

A reference to entries of a collection, named by the first argument. Stores an entry's ID, or with `many: true` an array of IDs, which `min` and `max` bound.

## f.image

```ts
f.image({ label, help? })
```

An image from the media library. Stores `{ media, alt? }`, where `media` is the image's ID in the library.

## f.file

```ts
f.file({ label, help? })
```

A file from the media library. Stores `{ media }`.

## f.richText

```ts
f.richText({ label, help?, features?, headings? })
```

Formatted text. Stores a rich-text document (a JSON tree); assistants and shipped content read and write it as Markdown. A required rich-text field can't be blank.

- `features`: what it may hold, from `'heading'`, `'bold'`, `'italic'`, `'code'`, `'link'`, `'bulletList'`, `'orderedList'`, `'blockquote'`, `'codeBlock'`, `'image'`, `'hardBreak'` and `'table'`. Default: all of them.
- `headings`: the heading levels allowed, from 1 to 6. Default: `[2, 3, 4]`.

Render it with `ctx.richText(fields.body)`. See [Rich text](/docs/guides/rich-text).

## f.inlineText

```ts
f.inlineText({ label, help?, maxLength? })
```

One line of formatted text: bold, italic, code and links, and nothing else. Stores a rich-text document holding a single paragraph. `maxLength` counts the characters of the text, not of its formatting. It can't be a collection's `titleField`. See [Inline text](/docs/guides/rich-text#inline-text).

## f.list

```ts
f.list(z.object({ ... }), { label, help?, min?, max?, itemLabel? })
```

A list of items, each an object of fields. Lists can hold lists. Stores an array of objects.

- `min`, `max`: how many items it may hold. `min` is checked at publish.
- `itemLabel`: what one item is called in the admin, such as `'Link'`.

See [Nested lists](/docs/guides/rich-text#nested-lists).

## f.group

```ts
f.group({ text: f.text({ label: 'Text' }), link: f.link({ label: 'Link' }) }, { label, help?, seo? })
```

Fields kept together under one heading. Takes a shape (the object you'd pass to `z.object`) and stores an object of its fields. `seo: true` marks the group whose values fill the page's search and sharing tags; `f.seo()` sets it for you.

## f.seo

```ts
f.seo({ label? })
```

A group holding the page's own search and sharing settings: `title` (suggested 70 characters, at most 300), `description` (suggested 160, at most 500) and `image`, each optional. See [Search and sharing](/docs/guides/seo).

## f.seoDefaults

```ts
f.seoDefaults({ label? })
```

The site's search and sharing defaults, editable in the admin: `titleTemplate` (with `%s` exactly once, at most 100 characters), `description` (suggested 160, at most 500) and `image`, each optional. It goes once per site, as a top-level field of a global, usually with `.optional()`. See [Search and sharing](/docs/guides/seo).

## defineField

`defineField(schema, meta)` makes a field type of your own from a Zod schema:

```ts
import { defineField, z } from 'inlaycms/site'

export const color = (opts: { label: string; help?: string }) =>
  defineField(z.string().regex(/^#[0-9a-f]{6}$/i), { kind: 'color', ...opts, admin: colorWidget })
```

`meta` takes:

- `kind`: a name for the field type. Required.
- `label`, `help`, `setting`: as for every field. `label` is required.
- `admin`: the admin control, `{ render, parse, fieldset? }`. Without it, the admin shows a text box holding the value as JSON. See [Custom field widgets](/docs/guides/admin#custom-field-widgets).
- `empty`: the value a required field renders with while it has none.
