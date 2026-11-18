---
title: Site password
---

# Site password

How an owner locks a whole site behind one shared password, for a site that isn't launched yet or a staging copy.

An owner can lock the whole public site behind one shared password from the admin's **Security** page, for a site that isn't launched yet or a staging copy. While the lock is on, every public request gets a neutral password screen instead: pages, media, the sitemap and the site's own routes. After the right password the visitor returns to the page they asked for, and stays unlocked in that browser for 30 days, or until an owner changes the password. People signed in to the admin and people opening a preview link skip the screen. `robots.txt` answers `Disallow: /` while the site is locked.

These stay reachable without the password: the admin (`/admin`), sign-in (`/api/auth`), MCP (`/mcp` and `/.well-known/*`), the site's files under `/public/`, and Inlay's own `/_inlay/*` paths. To keep one of the site's own routes open, such as a load balancer's health check, list its path in the site's `publicPaths`. Entries are exact paths, so `/healthz` doesn't open `/healthz/x`:

```ts
export const site = defineSite({
  ...,
  routes: [defineRoute({ method: 'GET', path: '/healthz', handler: async () => ({ body: 'ok' }) })],
  publicPaths: ['/healthz'],
})
```

While the lock is on, every response carries `X-Robots-Tag: noindex`, and what unlocked visitors get is sent as `Cache-Control: private` instead of `public`, so CDNs and proxies don't store it. The password screen itself is `no-store`. With the lock off, responses are exactly as described above.

A CDN keeps whatever it cached while the site was public until it's purged, and Inlay can't purge it. Turn the lock on before the site is ever public, or purge the CDN after locking a site that was public.

