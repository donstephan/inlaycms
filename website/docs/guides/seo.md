---
title: Search and sharing
---

# Search and sharing

How Inlay writes each page's title, description, share image and other head tags, and how a template adds its own. Read this when you set up a site's SEO and social sharing.

Inlay writes the head of every page it renders, just before the template's `</head>`: the `<title>`, the meta description, the canonical link, `hreflang` alternates (with `x-default`) for a translated page, Open Graph tags (`og:type`, `og:title`, `og:description`, `og:url`, `og:image`), Twitter card tags, and `robots: noindex` in preview and on pages with no URL of their own. A template's `f.seo()` field sets the page's own title, description and share image.

Site-wide defaults go in `defineSite`:

```ts
export const site = defineSite({
  ...,
  seo: {
    titleTemplate: '%s | Example Studio', // %s exactly once, where the page's title goes
    description: 'Websites for small studios.',
    image: '/public/share.png',           // a file under public/
  },
})
```

All three are optional. To let owners and editors change them in the admin, add `f.seoDefaults()` to one of your globals (once per site, as a top-level field, with `.optional()` so the global can ship empty):

```ts
const Settings = defineTemplate({
  name: 'settings',
  label: 'Site settings',
  fields: z.object({ defaults: f.seoDefaults().optional() }),
})
```

Each default comes from the global when it's filled in, then from the code, then there's none. Preview uses the global's draft, as it does for any global, and publishing the global updates every page.

- **Title.** A page's `f.seo()` title is used exactly as written. Otherwise the page's title goes through the title template, except on the home page (`/`, or a language's root such as `/es`), which keeps its plain title. The 404 page and pages from code routes get the template too. `og:title` and `twitter:title` are the final title.
- **Description.** The page's `f.seo()` description, then the default.
- **Share image.** The page's `f.seo()` image, then the global's default image, then the code's `/public` image. Images from the media library are shared as their 1280px JPEG. A `/public` image is an absolute URL versioned like `ctx.asset`'s; if the file isn't there the URL has no version, and the page still renders.
- **`ogType`.** `defineTemplate({ ogType: 'article' })` makes the template's pages `og:type` `article`, with `article:published_time` (`publishedAt`, left out while it is `null`) and `article:modified_time` (the last change). The default is `website`.
- **Twitter cards.** `twitter:card` is `summary_large_image` when the page has a share image and `summary` when it doesn't. `twitter:title`, `twitter:description` and `twitter:image` repeat the Open Graph values.

## Tags from templates

Templates and blocks can add tags to the head through `ctx.head` while they render. They land after Inlay's own tags: metas, then links, then JSON-LD.

```tsx
const Faq = defineBlock({
  name: 'faq',
  label: 'FAQ',
  schema: z.object({ question: f.text({ label: 'Question' }), answer: f.text({ label: 'Answer' }) }),
  render: (p, ctx) => {
    ctx.head.jsonLd({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [{ '@type': 'Question', name: p.question, acceptedAnswer: { '@type': 'Answer', text: p.answer } }],
    })
    ctx.head.meta({ name: 'author', content: 'Example Studio' })
    ctx.head.link({ rel: 'alternate', type: 'application/rss+xml', href: '/feed.xml' })
    return <section>…</section>
  },
})
```

- **`jsonLd(value)`** adds a `<script type="application/ld+json">`. It's escaped so nothing in it can end the script. Each call adds its own script, and a value JSON can't write (`undefined`, a function, a BigInt) fails the render.
- **`meta({ name, content })` or `meta({ property, content })`** replaces Inlay's meta with the same name or property (`og:type`, `og:image`, `description`, `robots`…), and the last call for a key wins. `<title>` stays Inlay's.
- **`link({ rel, href, … })`** replaces Inlay's link with the same `rel` and `hreflang` (so `rel: 'canonical'` replaces the canonical link, while an RSS `alternate` without `hreflang` leaves the language alternates alone). Other links are kept in call order, once each when identical. `href` must be a path on the site or an `http(s)` URL.
- **Twitter tags** follow the final `og:*` values, so `meta({ property: 'og:image', … })` also sets `twitter:image` and the large card. A `twitter:*` meta of your own wins over the mirrored one.
- **Preview** always stays `noindex`: a `robots` meta from a template is dropped there.

Values are escaped, so `ctx.head` can only add tags to the head. For a script, use `ctx.script` (see [Scripts](/docs/guides/integrations#scripts)): a `<script>` written by hand is blocked by the page's Content-Security-Policy. Other raw HTML and styles go in the template's own `<head>`.

## Routes in the sitemap

`defineRoute({ method: 'GET', path, sitemap: true, handler })` lists the route in the sitemap. The pages its `ctx.render` returns get a canonical link and can be indexed. Other routes stay `noindex`.

