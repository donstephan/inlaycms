---
title: Rich text
---

# Rich text

What `f.richText` and `f.inlineText` fields can hold, and how to render them in a template. Read it when you build a template that shows an editor's formatted text.

## Inline code

Rich text and inline text hold inline code, on by default: a command, a file name or a placeholder, shown in a monospace font. In Markdown it is text between backticks (`` Run `npm test` first ``); a span holding a backtick is fenced with more of them (``` ``a`b`` ```). It renders as `<code>`. Code can go inside a link (``[`npm test`](/docs/testing)``) and in table cells, but it can't be bold or italic: Markdown that puts code inside bold or italic text is refused with the line it is on. For longer code, see [Code blocks](#code-blocks). To leave code out of a field, list its `features` without `'code'`.

## Code blocks

Rich text holds code blocks, on by default. In Markdown a block is a fence of three or more backticks (` ``` `) or tildes (`~~~`) with an optional language after it, like ` ```ts `, and the same fence, or a longer one, after the code to close it. A language is up to 32 letters, digits and `_ + # . -`, kept as written (`C#` stays `C#`). Indented code blocks, a fence that is never closed and a fence with anything else after the language (`ts title="x"`) are refused with the line they are on. A code block keeps its text, newlines and spaces exactly; it can't hold bold, italic, links, images or line breaks. A block renders as `<pre><code class="language-ts">`, and without a language as `<pre><code>`. In the admin, the Code block button turns the current paragraph into one, and a language box appears while the cursor is inside it. To leave code blocks out of a field, list its `features` without `'codeBlock'`.

Inlay ships no highlighter. To use one, pass `highlight` to `ctx.richText`: it gets the code and the language (or `undefined`) and returns the inside of the `<code>` element as `raw(...)`, or `null` to leave the code plain. Its output is trusted as written, so it must escape the code; Inlay writes the `<pre><code>` around it.

```tsx
import { raw } from 'inlaycms/site'

{ctx.richText(fields.body, {
  highlight: (code, language) => (language === 'ts' ? raw(myHighlighter(code)) : null),
})}
```

## Heading links

Pass `headingIds` to `ctx.richText` to give each heading an `id`, so a page can link to it: `{ headingIds: true }`, or `{ headingIds: { prefix: 'intro-' } }` to start every id with a prefix. An id is the heading's text in lowercase, with spaces turned to hyphens and anything but letters, digits and hyphens dropped (`section` if nothing is left). Repeats are numbered (`a`, `a-2`). Numbering is per call, so when one page renders several rich-text values, give each its own prefix. Without the option, headings have no `id`.

`richTextHeadings(doc, { prefix })` lists a value's headings with the same ids, for a contents list on the page:

```tsx
import { richTextHeadings } from 'inlaycms/site'

const toc = richTextHeadings(fields.body, { prefix: 'body-' }) // [{ level, text, id }, ...]
```

## Tables

Rich text holds tables, on by default. In Markdown (what assistants send and get back, and what shipped content is written in) a table is a GitHub-style table:

```md
| Plan | Price |
| --- | --- |
| **Pro** | [Buy](https://example.com/buy) |
| *Lite* | free |
```

The first row is always the header row. A cell holds one line of text with bold, italic, code and links; images and line breaks can't go in a cell, and a table can't go inside a list or a quote. Write a `|` inside a cell as `\|`. Alignment markers (`:---:`) are accepted and dropped, short rows are padded with empty cells, and cells past the header's width are dropped. To leave tables out of a field, list its `features` without `'table'`: `f.richText({ label: 'Body', features: ['bold', 'italic', 'link'] })`.

A table renders as plain HTML with no attributes, for your site's CSS to style: `<table>`, a `<thead>` holding the header row's `<th>` cells, and a `<tbody>` of `<td>` cells when there are rows below the header.

## Inline text

`f.inlineText({ label, maxLength })` is one line of formatted text, for a headline or a tagline that may need a word in bold or a link: bold, italic, code and links, and nothing else. It is stored as rich text holding a single paragraph, and the admin edits it on one line. `maxLength` counts the characters of the text, not of its formatting.

Assistants and shipped content write it as one line of Markdown, such as `'**Big** news, see [the plans](inlay:key/pages/pricing)'`. A blank line (a second paragraph), a heading, a list, a line break or an image is refused.

In a template, `ctx.inline(fields.headline)` renders the text without a `<p>`, so it fits inside an `<h1>`; a string is escaped, and `null` gives nothing. `ctx.richText` renders it with its `<p>`. `plainText(fields.headline)`, imported from `inlaycms/site`, gives the text without its formatting, for a `<title>` or an `alt`.

An inline-text field can't be a collection's `titleField`, which must be plain text. Keep a plain `f.text` title beside it:

```ts
fields: z.object({
  title: f.text({ label: 'Title' }),
  headline: f.inlineText({ label: 'Headline', maxLength: 80 }),
}),
```


## Nested lists

Lists can hold lists, to any depth, and the admin shows every level with its own add, remove and move buttons. A mega menu is three deep: menu items hold columns, and columns hold links.

```ts
const Menu = defineTemplate({
  name: 'menu',
  label: 'Menu',
  fields: z.object({
    menu: f.list(
      z.object({
        title: f.text({ label: 'Title' }),
        columns: f.list(
          z.object({
            heading: f.text({ label: 'Heading' }),
            links: f.list(
              z.object({
                label: f.text({ label: 'Label' }),
                href: f.text({ label: 'Address' }),
                description: f.textarea({ label: 'Description' }).optional(),
              }),
              { label: 'Links', itemLabel: 'Link' },
            ),
          }),
          { label: 'Columns', itemLabel: 'Column' },
        ),
      }),
      { label: 'Menu', itemLabel: 'Menu item' },
    ),
    promo: f.group({ text: f.text({ label: 'Text' }), link: f.link({ label: 'Link' }) }, { label: 'Promo' }),
  }),
})
```

A template loops over each level:

```tsx
<nav>
  {fields.menu.map((item) => (
    <div>
      <span>{item.title}</span>
      {item.columns.map((column) => (
        <section>
          <h3>{column.heading}</h3>
          <ul>
            {column.links.map((link) => (
              <li><a href={link.href}>{link.label}</a></li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  ))}
</nav>
```

