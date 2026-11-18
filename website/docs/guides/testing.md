---
title: Testing your site
---

# Testing your site

How to test a site's pages, routes and redirects in process with `inlaycms/testing`, using any test runner. Read it when you want checks that run before you pack a release.

`inlaycms/testing` boots your site the way `inlaycms dev` does, with its shipped content, in a temporary folder, and answers requests in process: no ports, no child processes, and any test runner works (`fastify` is already a peer dependency). `createTestSite(options)` takes:

- `config`: your `inlay.config.ts`, as a path relative to the working directory or a `file:` URL.
- `baseUrl`: used for canonical, Open Graph and sitemap URLs. Default `http://localhost`.
- `secrets`: values for the secrets your site declares.
- `fetch`: what routes get as `ctx.fetch`. Default: the global `fetch`.
- `now`: the clock. Default: real time.

It returns `{ fetch(path, init?), paths(), close() }`. Here are three checks written for vitest:

```ts
import { createTestSite, type TestSite } from 'inlaycms/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'

let site: TestSite
beforeAll(async () => {
  site = await createTestSite({ config: './inlay.config.ts', baseUrl: 'https://example.com' })
})
afterAll(() => site.close())

it('serves every sitemap page with one <h1> and JSON-LD', async () => {
  for (const path of await site.paths()) {
    const res = await site.fetch(path)
    expect(res.status, path).toBe(200)
    const html = await res.text()
    expect(html.match(/<h1[\s>]/g)?.length, path).toBe(1)
    expect(html, path).toContain('<script type="application/ld+json">')
  }
})

it('sends old URLs to their new pages', async () => {
  const res = await site.fetch('/About-Us')
  expect(res.status).toBe(301)
  expect(res.headers.get('location')).toBe('/about')
})

it('answers unknown paths with 404', async () => {
  expect((await site.fetch('/no-such-page')).status).toBe(404)
})
```

The JSON-LD check applies to sites that add JSON-LD through `ctx.head`; Inlay doesn't add it on its own. A site whose imports `inlaycms pack` would refuse makes `createTestSite` throw. `fetch` takes a path that starts with `/` and a body that is a string or `URLSearchParams`; HEAD, 204, 205 and 304 answers have no body. Redirects aren't followed. `paths()` is the sitemap's paths, code routes with `sitemap: true` included. `secrets` and `fetch` are how a route's outgoing requests are tested. Each test site is independent.

