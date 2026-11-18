---
title: Admin
---

# Admin

What the admin offers owners and editors, and how a site's developer brands it, groups its menu, adds field widgets and manages releases from it.

The admin lives at `https://<your-site>/admin`. Owners and editors use it to edit pages, entries and site-wide content, preview and publish, look back through history, and manage media and redirects. Owners also manage users, backups and releases there.

When a release adds a required field, published content that leaves it empty stays live as it is, but the admin points it out: the dashboard counts it per type ("Missing information on the live site"), lists mark each page or entry with "Needs attention", and the editor says which fields to fill in before publishing again.

## Releases

Owners find every release on the host under **Releases**: its name, state (live, ready to activate, previously live or deleted), who pushed it and when, and when it was made live. A release's page shows what it would change against the live release (as `inlaycms push` reports it), the secrets it needs, the key it was signed with and its migration functions; the live release's page also lists the content it hides (types, languages, slots and fields the site no longer has, with how many documents hold them). From there an owner can:

- **Upload** a release file, which goes through the same checks as `inlaycms push` (signature, Inlay version, secrets) and is kept as staged. Without the running host (under `inlaycms dev`) the signature and Inlay version are checked on upload, and the secrets when the release is activated. A host with no trusted keys refuses uploads.
- **Preview** a staged release, which opens the preview link in a new tab.
- **Activate** a staged or earlier release, which makes it live the same way `push --activate` does; this is also how you roll back from the admin.
- **Delete** a release that isn't live, which removes its files and stops its preview.

Preview, activation and the part of the diff that looks at your content need the site to run under `inlaycms serve`. Under `inlaycms dev` the screen still lists, compares, uploads and deletes releases in the data folder, and says that activation needs the host. Inside a staged release's preview the admin is read-only, with a banner naming the release.

## Branding

Set `admin` in `defineSite` to put your name, logo and colors on it:

```ts
export const site = defineSite({
  ...,
  admin: {
    name: 'Example Studio',            // shown in the header and the page titles; defaults to "Inlay"
    logo: '/public/logo.svg',          // a URL path under /public/
    theme: 'corporate',                // or custom colors, below
  },
})
```

- **`logo`** is the URL of an image the site serves under `/public/`, shown as an image in the admin's header. The brand name is the logo's alt text.
- **`theme`** is one of daisyUI's built-in theme names (`light`, `dark`, `corporate`, `nord`, `dracula`, `emerald`, `business`, `winter` and the rest), or custom colors laid over a base theme:

  ```ts
  theme: {
    base: 'corporate',   // optional; Inlay's own `inlay` theme by default
    scheme: 'light',     // optional; 'light' or 'dark', for browser controls such as scrollbars
    colors: { primary: '#0b5fff', 'primary-content': '#ffffff' },
  }
  ```

  The color keys are daisyUI's (`base-100`, `base-200`, `base-300`, `base-content`, and `primary`, `secondary`, `accent`, `neutral`, `info`, `success`, `warning` and `error`, each with a `-content` partner). Values are hex (`#0b5fff`) or CSS color functions such as `oklch(…)`. Anything else stops the site at startup.
- **Contrast warnings.** When a text color and its background are both hex values and their contrast is below 4.5:1 (WCAG AA), Inlay logs a warning once at startup. The site still starts. Inlay's default theme passes AA.

## Menu groups

A collection's `group` puts it under its own heading in the admin's menu. Custom groups sit between Content and Building blocks, in the order the site first uses them. Without a group, a collection with pages of its own (a `route` or `customPaths`) goes under Content, and any other collection goes under Building blocks. A group named "Content" or "Building blocks" adds the collection to that heading. Pages, Site-wide content and Media always stay under Content.

```ts
collections: [
  defineCollection({ name: 'plans', label: 'Plans', template: plan, group: 'Pricing' }),
  defineCollection({ name: 'discounts', label: 'Discounts', template: discount, group: 'Pricing' }),
],
```

## Suggested length

`f.text` and `f.textarea` take `suggestedLength`, a soft limit beside `maxLength`. The admin shows a character counter under the field and, past the number, a hint that the text may be cut off where it's shown. It doesn't block saving or publishing, and the number is reported to assistants too. `f.seo()` suggests 70 characters for the title (at most 300) and 160 for the description (at most 500).

## Custom field widgets

Every built-in field brings its own control. A field you define with `defineField` can bring one too, through `admin`: `render` draws the control for one value, and `parse` reads it back from the submitted form.

```tsx
import { defineField, z, type AdminWidget } from 'inlaycms/site'

const colorWidget: AdminWidget = {
  render: ({ id, name, value, describedBy, invalid, readOnly }) => (
    <input
      type="color"
      id={id}
      name={name}
      value={typeof value === 'string' ? value : '#000000'}
      disabled={readOnly}
      aria-describedby={describedBy}
      aria-invalid={invalid ? 'true' : undefined}
      class="input input-bordered w-full"
    />
  ),
  parse: (form, name) => form.get(name),
}

export const color = (opts: { label: string; help?: string }) =>
  defineField(z.string().regex(/^#[0-9a-f]{6}$/i), { kind: 'color', ...opts, admin: colorWidget })
```

- The form supplies the label, the help text and any problems. Give the main control `id`, and pass `describedBy` and `invalid` on so screen readers hear the hints. A widget with several controls sets `fieldset: true`, and the form then wraps it in a `<fieldset>` with the label as its `<legend>`.
- `parse` returns `undefined` when the value is absent. Its `optional` argument says whether the field may be left out.
- The admin's CSS is prebuilt, so use classes the admin already uses (daisyUI's `input`, `select`, `textarea`, `btn` and so on) rather than new Tailwind classes.
- A field without `admin` gets a text box holding its value as JSON.

## JavaScript

Most of the admin is plain forms and works without JavaScript. Choosing images, files and linked pages, and editing formatted text, need it; the admin says so when it is off.

