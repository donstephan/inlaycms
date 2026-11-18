---
title: Redirects
---

# Redirects

How a site ships redirects in its code, and how they interact with pages, routes and redirects set in the admin.

Redirects that belong to the site go in its code, so they ship with each release:

```ts
export const site = defineSite({
  ...,
  redirects: [
    { from: '/about-us', to: '/about' },
    { from: '/blog/:slug', to: '/:slug' },
    { from: '/g2', to: 'https://www.g2.com/products/example/reviews' },
    { from: '/old-landing', to: '/', status: 302 },
  ],
})
```

`from` is a path or a pattern with `:name` segments, `to` is a site path (with those names filled in) or an `https://` address, and `status` is `301` (the default) or `302`.

- A published page at a rule's `from` wins over the rule, and so does a code route. An admin redirect with the same `from` overrides a code rule, and deleting it brings the code rule back. A delete that would leave visitors going round in a loop is refused, as a new redirect that would loop is. The admin's Redirects screen and the `list_redirects` tool show code rules read-only.
- Rules ship with each release, so they follow activation and rollback: a rule is live only while its release is.
- `inlaycms check` warns about rules that loop, and about rules that never fire because published pages answer at their `from` (in every language the rule applies in), without failing.
- A redirect to an `https://` address, whether it comes from code, the admin, a CSV import or the MCP tools, doesn't pass the visitor's query string on. Redirects within the site still do.
- Paths are case-sensitive. The one exception: a path with an uppercase letter that would otherwise be a 404 is redirected when something answers at its lowercase form. A page or a code route there gets a 301 to the lowercase path. A redirect rule there sends the visitor straight to the rule's target with the rule's own status, so a `302` rule stays a 302. That doesn't apply to reserved paths (`/admin`, `/media`, `/public` and the like) or to paths whose last segment contains a `.`.

