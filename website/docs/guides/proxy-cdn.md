---
title: Behind a proxy or CDN
---

# Behind a proxy or CDN

What to set when a site runs behind a reverse proxy or a CDN: visitor addresses, rate limits and cache headers. Read this when you put anything in front of `inlaycms serve`.

## Behind a reverse proxy

If the site runs behind a reverse proxy (nginx, Caddy, a load balancer), set `INLAY_TRUST_PROXY` to the proxy's address, so Inlay takes each visitor's address from the `X-Forwarded-For` header the proxy adds:

```sh
INLAY_TRUST_PROXY=127.0.0.1                 # a proxy on the same machine
INLAY_TRUST_PROXY=10.0.0.0/8,192.168.0.0/16 # proxies in these ranges
INLAY_TRUST_PROXY=uniquelocal               # private networks, such as Docker's
```

It takes IP addresses and ranges, separated by commas, and the names `loopback`, `linklocal` and `uniquelocal`; the default is `off`. There's no setting that trusts every address.

Login attempts are rate-limited per visitor address, so this matters:

- **Without it**, every visitor seems to come from the proxy. Anyone can then use up the shared limit with wrong passwords and keep the owner from logging in.
- **Trusting every address** would let anyone send a made-up `X-Forwarded-For` with every attempt and never hit the limit. That's why the setting only takes the proxies' own addresses: a header from anyone else is ignored.

Inlay logs a warning on the first request when `INLAY_BASE_URL` is https, Inlay isn't serving https itself, and no proxy is trusted.

## Behind a CDN

Inlay keeps rendered pages in memory and clears them on every publish, so a single server serves a site from memory on its own. In front of a CDN or caching proxy, published pages also carry the headers shared caches need, with no provider-specific setup:

- An `ETag` over the rendered page. A request with a matching `If-None-Match` gets a 304 without rendering, so unchanged pages cost the origin almost nothing to revalidate.
- `Cache-Control: public, max-age=0, s-maxage=15, stale-if-error=86400`. Browsers revalidate on every visit, so an editor who publishes and refreshes sees the change at once. Shared caches may serve a page for 15 seconds before checking back, and keep serving the last good copy for a day if the origin is down.
- Media files are content-addressed and sent with a one-year immutable lifetime.

To cache a site file for a year, link it with `ctx.asset('site.css')` in a template or route. It gives `/public/site.css?v=<hash>`, where the hash comes from the file's contents, and a `/public` URL whose `v` matches is served `immutable` for a year, so an edited file gets a new URL. Other `/public` URLs keep `INLAY_PUBLIC_MAX_AGE`. A file that isn't there gives the plain `/public` URL, with no `v`.

Tune the shared lifetime with `INLAY_CDN_MAX_AGE` (seconds, default 15) and `INLAY_CDN_STALE_IF_ERROR` (seconds, default 86400). `INLAY_CDN_MAX_AGE=0` makes shared caches revalidate on every request, which still saves bandwidth through the 304s. Preview pages are never cached (`no-store`), so a draft cannot reach a shared cache. Published pages are marked `Vary: Cookie`; if your CDN ignores that header for HTML, add a rule to bypass its cache when the `inlay_preview` cookie is present, or editors with a preview cookie may be served the cached public page.

