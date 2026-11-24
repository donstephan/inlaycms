---
title: Security
---

# Security

This page gathers what Inlay does to keep a site safe and what it leaves to you, the site's developer. Read it before you put a site on the internet; each section links to the guide with the details.

Out of the box, a host runs only releases signed with a key it trusts, and secret values never travel in a release. Every response carries security headers, and public pages get a strict Content-Security-Policy that allows inline scripts only by their hash. Login attempts are rate-limited per visitor address (unless `INLAY_RATE_LIMIT` is `off`), and `inlaycms push` won't send its token over plain `http://` to another computer unless you pass `--insecure`.

What stays with you: keeping your signing key private and trusting only keys you control, creating the owner account before the site is public, declaring what the site loads from outside, deciding which scripts wait for a visitor's consent, and setting `INLAY_TRUST_PROXY` when the site runs behind a proxy (see [Behind a reverse proxy](/docs/guides/proxy-cdn#behind-a-reverse-proxy)).

## Signed releases and trusted keys

A release is your whole site in one signed file: the bundled site code, the shipped content and its images, and the files in `public/`. Secret values are never in it; it lists only the secret names the site declares (`secrets` in `defineSite`), and the host provides the values.

Make a signing key pair once, on the machine you release from:

```sh
npx inlaycms keygen --out keys --name release
```

This writes `keys/release.key` (the private key: keep it secret and out of the repo) and `keys/release.pub`, a one-line public key such as `ed25519:...`. Give the public key to every host that should run your releases, in `INLAY_TRUSTED_KEYS` or `INLAY_TRUSTED_KEYS_FILE`: a host only accepts a release whose signature verifies against one of its trusted keys, and refuses it before reading anything else in it.

What makes a release trusted is its signature: a host runs only releases signed with a key it trusts, so trust a key only if you trust everyone who can sign with it. A push runs the release's code on the host straight away, a dry run too: the host starts the release's preview to work out what it would change in your content. So the signature is what stands between the host and the code it runs: only trust keys whose private half you control, and keep that half out of the repository.

A release is checked when it arrives, so taking a key off the trusted list doesn't remove the releases it signed. The host keeps serving a live one and says so in its log when it starts; the Releases screen marks each such release, and an owner can still activate one there. A push token can't: `inlaycms activate <host> <id>` is refused for a release whose key is no longer trusted. If you removed the key because it leaked, delete those releases, then push the site again signed with a new key.

The example site in `example/` commits a key pair in `example/keys/` for development only: never trust `example/keys/dev.pub` on a real host.

How to pack and sign a release: [Packing a release](/docs/guides/releases#packing-a-release).

## What `pack` refuses

Site code imports Inlay from `inlaycms/site` (and JSX from `inlaycms/jsx-runtime`), never from `inlaycms` itself, which is the host's side. `pack` refuses a site that imports anything else it can't bundle, such as Node's built-in modules or `inlaycms`, and site code that uses `process`, `require`, `eval` or `Function` (also as `globalThis.eval` and the like) or an `import()` of a computed name. An `import()` of a template under a relative folder, such as ``import(`./locales/${lang}.js`)``, is fine: every matching file is bundled.

Those checks catch mistakes; they don't make a release safe to run. The signature is what makes a release trusted (see [Signed releases and trusted keys](#signed-releases-and-trusted-keys)).

## Preview links

A preview link shows unpublished changes without signing in, for 24 hours. A link made for a page (from the editor, or by an assistant) shows drafts on that page only, so a link that gets forwarded or lands in a log shows one page, not every draft on the site. Every other page stays as visitors see it, and on a site with a [site password](/docs/guides/site-password) stays behind the password screen. A link to a staged release, which only an owner or a push can make, previews that whole release.

## Push tokens

`inlaycms push` sends releases to a running host and needs a push token: an owner's API key that can push, activate, list and delete releases and do nothing else (it is refused on `/mcp`, so it can't read or change content). An owner makes one in the admin (an API key with "For pushing releases only" turned on), or on the host with the CLI, which prints the key once (alone on standard output, so a script can capture it) and works whether the server is running or not:

```sh
npx inlaycms create-token --email owner@example.com --name ci --push [--data <dir>]
```

`push`, `inlaycms activate <host> <id>` and `inlaycms releases <host>` take the token from `--token` or `INLAY_PUSH_TOKEN`. They exit 1 when the host refuses (printing its reason, such as a release signed with a key it doesn't trust, or a token that may not push) and 2 when the token, signing key or release file is missing.

The token is only sent over plain `http://` to this computer (`localhost`, `127.0.0.1`, `[::1]`), unless you add `--insecure`; and it is never sent on to another address the host redirects to. Use an `https://` address for any other host.

The whole push flow, with staging, previews and rollback, is in [Deploying](/docs/guides/releases#deploying).

## The first owner

On a site with no users yet, opening `/admin` sends anyone to `/admin/setup`, where they can create the owner account. Once an owner exists, the setup page only sends visitors to the login page. So on a public host, whoever gets there first becomes the owner.

Create the owner with `inlaycms create-owner --email <email> --name <name>` (it reads the password from stdin) before the site is public, or at `/admin/setup` while only you can reach it. If you can't do that, keep the site off the internet until the owner exists. If you are locked out of the only owner account, run `inlaycms reset-password --email <email>` on the server to set a new password.

See [Connect your assistant](/docs/guides/assistant) for the first run, and [Running a host](/docs/guides/releases#running-a-host) for how these commands find the host's data folder.

## Two-step login

Each person can ask for a code from an authenticator app after their password. Under Account in the admin, they enter their password, scan the QR code (or type the key) and enter a six-digit code. It works with any authenticator app that supports the standard time-based codes. Turning it on signs that person out of their other sessions, and turning it off needs their password.

At login, the code is asked for after the password. Five wrong codes end that login attempt, and ten wrong codes in a row lock the second step for 15 minutes. Owners see who has it on in the Users screen, but the admin's screens have no way to require it or to reset it for someone else.

API keys, push tokens and assistants that are already connected don't ask for a code. Connecting a new assistant asks for a code only when the person has to log in first, because that goes through the login page; someone already logged in to the admin goes straight to the consent page.

If someone loses their phone, run `inlaycms reset-two-factor --email <email>` on the server. It turns two-step login off for that person and signs them out everywhere, and leaves their password, API keys and connected assistants alone. They log in with their password and set it up again. `reset-password` and an owner setting a password never turn it off.

The keys are encrypted with `INLAY_SECRET`. If the secret changes, no code is accepted any more, so run `reset-two-factor` for each person who had it on.

## Consent and third-party scripts

A third-party script (a tag manager, analytics, a chat widget) is an integration: the site's developer ships it in the release and the site's owner switches it on in the admin. An owner or an editor can never paste a script into a page, so Inlay knows every script the site uses. That is what lets public pages carry the strict policy in [Security headers](#security-headers).

An integration with `consent` stays inert until the visitor agrees to its category: its output is written inside a `<template>`, so no script, pixel, image or frame starts before then. The choice is kept in the visitor's browser; nothing is sent to the server and no cookie is set. The banner is the site's, and Inlay provides the gate, not the legal advice: which scripts need consent, and what the banner says, is up to the site.

What an owner enters in an integration's fields is written into the page, so it is public. A field that needs a secret belongs in `secrets`, read by a code route. Write any value you put into inline code through `js`, so a value can't end its script or run as code.

Details: [Integrations](/docs/guides/integrations#integrations), [Scripts](/docs/guides/integrations#scripts) and [Consent](/docs/guides/integrations#consent).

## Security headers

Every response carries `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`. Public responses (pages, files, routes, redirects, and the auth, MCP and push paths) also carry this `Content-Security-Policy`:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; media-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'
```

This is strict on purpose: the public site shares an origin with `/admin`, so a script on a page could act as whoever is signed in. It means a site's pages can load only from the site itself, so:

- an inline script goes through `ctx.script` (see [Scripts](/docs/guides/integrations#scripts)), which adds its hash to `script-src` for that page. Each page's header is made with the page and cached with it, and a `304` carries the same header;
- anything from outside the site (a font, an external image, a video embed) is declared in `defineSite({ csp })`;
- inline `style` attributes and `<style>` elements still work (`style-src 'unsafe-inline'`).

```ts
export const site = defineSite({
  ...,
  csp: {
    'img-src': ['https://images.example.com'],
    'font-src': ['https://fonts.gstatic.com'],
    'frame-src': ['https://www.youtube-nocookie.com'],
  },
})
```

The directives you can declare are `script-src`, `style-src`, `img-src`, `font-src`, `connect-src`, `frame-src`, `media-src`, `form-action` and `worker-src` (`worker-src 'self'` is added only when something declares it). A source is an origin (`https://images.example.com`, `https://*.example.com`, `wss://live.example.com`: lowercase, no path), a bare scheme such as `data:` or `blob:`, or one of the keywords `'unsafe-inline'`, `'unsafe-eval'` and `'wasm-unsafe-eval'`. Anything else, an unknown directive included, fails `inlaycms check`, `pack` and boot. A switched-on integration's `csp` is merged in beside the site's, each source once.

Browsers ignore `'unsafe-inline'` in `script-src` when a hash is present. So when the site or a switched-on integration declares it, Inlay leaves the hashes out and inline scripts are simply allowed. `inlaycms check` warns about that, and about `'unsafe-eval'`, and the Integrations screen says so on the integration concerned. Public SVG files and the admin keep their own stricter policies. The editor's preview pane gets the public page's policy without the integrations' sources (it renders none), and only the admin may frame it.

When the site's base URL is `https://`, responses also carry `Strict-Transport-Security: max-age=31536000`, so browsers keep to https for a year. A response that sets one of these headers itself keeps its own.

A site changes or adds headers with `headers` in `defineSite`. A value replaces Inlay's default and `false` leaves the default out:

```ts
export const site = defineSite({
  ...,
  headers: {
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https://images.example.com; frame-ancestors 'none'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  },
})
```

A CSP set here replaces the whole policy: Inlay then adds no hashes and no declared sources (the site's `csp` and its integrations'), so list what the site needs yourself and include `frame-ancestors`. `inlaycms check` warns when a site does this and also defines integrations. The release diff on push and on the Releases screen shows an integration added or removed and any change to what the site may load. If your reverse proxy already sends HSTS, set `'Strict-Transport-Security': false` so browsers don't get it twice.

## Site password

An owner can lock the whole public site behind one shared password from the admin's **Security** page, for a site that isn't launched yet or a staging copy. Visitors then get a password screen instead of pages, media, the sitemap and the site's own routes, while the admin, sign-in, MCP, the files under `/public/` and Inlay's own `/_inlay/*` paths stay reachable. A CDN keeps whatever it cached while the site was public until it's purged, so turn the lock on before the site is ever public. Details, including `publicPaths` for routes such as a health check: [Site password](/docs/guides/site-password).
