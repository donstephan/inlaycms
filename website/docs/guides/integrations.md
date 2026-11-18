---
title: Integrations and consent
---

# Integrations and consent

How a site's developer ships third-party scripts such as analytics, how owners switch them on, and how consent gates them. Read this when a site needs a tag manager, analytics or a chat widget.

## Integrations

An integration is a third-party script (a tag manager, analytics, a chat widget) that the site's developer ships in the release and the site's owner switches on in the admin. The developer writes the code, so an owner or an editor can never paste a script into a page, and Inlay knows every script the site uses. That is what lets public pages carry a strict [Content-Security-Policy](/docs/guides/security#security-headers) and keep gated scripts back until a visitor [consents](#consent).

```tsx
import { defineIntegration, defineSite, f, js, z } from 'inlaycms/site'

export const tagManager = defineIntegration({
  name: 'tag-manager',
  label: 'Google Tag Manager',
  description: 'Loads the tags set up in your Tag Manager container.',
  fields: z.object({
    containerId: f.text({ label: 'Container ID', pattern: /^GTM-[A-Z0-9]+$/, patternHint: 'It looks like GTM-ABC123.' }),
  }),
  consent: 'marketing',
  csp: {
    'script-src': ['https://www.googletagmanager.com'],
    'img-src': ['https://www.googletagmanager.com'],
    'connect-src': ['https://www.googletagmanager.com', 'https://www.google.com'],
  },
  head: ({ containerId }, page) =>
    page.script(js`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':Date.now(),event:'gtm.js'});
var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.async=true;
j.src='https://www.googletagmanager.com/gtm.js?id='+i;f.parentNode.insertBefore(j,f)})(window,document,'script','dataLayer',${containerId})`),
})

export const site = defineSite({
  ...,
  integrations: [tagManager],
})
```

The sources in `csp` above are a starting point, taken from Google's guide to Tag Manager and CSP (developers.google.com/tag-platform/security/guides/csp). What a container needs depends on the tags in it: Google Analytics, Google Ads, preview mode and the rest each need more sources, which that guide lists. Google also says that tags a container adds itself may need `'unsafe-inline'` in `script-src` (it recommends a nonce, which Inlay does not use, because a cached page can't carry one). Declaring `'unsafe-inline'` makes Inlay leave the page's script hashes out, so inline scripts are allowed (see [Security headers](/docs/guides/security#security-headers)), and `inlaycms check` warns about it.

`defineIntegration` takes:

- **`name`**: lowercase letters and digits with single hyphens, unique on the site. It is the key the settings are stored under, so renaming an integration makes a new one.
- **`label`, `description`**: shown on the Integrations screen.
- **`fields`**: what the owner fills in, as `z.object({ ... })`. Only `f.text`, `f.textarea`, `f.number`, `f.boolean` and `f.select`, at the top level. A field is required unless it ends in `.optional()`. Leave `fields` out and the integration is just an on/off switch. `pattern` on `f.text` (with an optional `patternHint` shown when it fails) is checked when an integration is switched on, and when content is published, not while an integration is saved switched off.
- **`consent`**: `'analytics'`, `'marketing'` or `'functional'`. The integration's output then stays inert until the visitor agrees to that category (see [Consent](#consent)). Left out, it loads for everyone.
- **`preview`**: `false` by default. In preview only integrations with `preview: true` render.
- **`csp`**: the sources the integration needs, by directive. They are added to the page's policy only while the integration is switched on and its settings are valid.
- **`head`, `bodyStart`, `bodyEnd`**: at least one. Each gets `(values, page)` and returns JSX or `null`, and may be async. The output goes just before `</head>`, just after `<body>` and just before `</body>`. A slot the template has no marker for is skipped. `page` is `{ path, locale, preview, script }`; on the 404 page `path` is an empty string.

Integrations render in the order `defineSite` lists them, on every page that goes through Inlay's rendering: documents, singletons, the 404 page and a code route's `ctx.render`, in preview as noted above. They never render on Inlay's own pages (the site password screen, a preview that has expired), and never in the admin's editor pane. A render function that throws is logged with the integration's name and left out of that page, which renders as usual. An integration that is off, or whose saved values don't pass the fields, is not rendered and adds no CSP sources.

Only an owner sees the **Integrations** screen in the admin. It is listed when the site defines at least one integration, and each integration has a switch, its fields, and notes on whether it waits for consent, runs in preview or loosens script protection. An editor, an API key and the MCP tools can't read or change integration settings. A save takes effect at once and clears the page cache: there is no draft or publish step. Settings are kept in the database, so backups, `export` and `import` carry them, and an integration a later release drops keeps its settings and comes back if a release defines it again.

What an owner enters is written into the page, so it is public. A field that needs a secret belongs in `secrets`, read by a code route. Write any value you put into inline code through `js`, so a value can't end its script or run as code.

## Scripts

`ctx.script` (in templates and blocks) and `page.script` (in integrations) are the same function. A page's Content-Security-Policy allows an inline script only by its hash, and `script` records that hash:

```tsx
<>
  {ctx.script(js`window.pageLocale = ${ctx.locale}`)}
  {ctx.script({ src: 'https://widgets.example.com/chat.js', async: true })}
</>
```

- **`script(code)`**: an inline `<script>`. `code` is a string or the result of `js`. Code that contains `</script`, `<!--` or a NUL character throws during the render. Line breaks are written as `\n`, the way the browser reads them.
- **`script({ src, async?, defer?, type? })`**: an external `<script src>`. `src` must be a path on the site or an `https://` address, and `type` can be `'module'`. It doesn't add the address to the policy: declare its origin in `csp`.
- **`` js`...` ``**: a tagged template that writes every `${value}` as JSON, with `<`, `>`, `&`, U+2028 and U+2029 escaped, so a value is data whatever it contains. Build inline code with `js`, not by joining strings.

A bare `<script>` written in a template without `ctx.script` isn't hashed, so the browser blocks it. `<script src="/public/site.js">` needs no helper, because the site's own address is allowed.

## Consent

A gated integration (one with `consent`) is written into the page inside `<template data-inlay-consent="marketing">`. Nothing inside a `<template>` loads or runs, so no script, pixel, image or frame starts before the visitor agrees. Pages with at least one switched-on gated integration also load Inlay's small consent script from `/_inlay/consent.js`; other pages don't. Without JavaScript, gated integrations never load. The page itself is the same for every visitor and is cached as usual: consent is decided in the browser.

The banner is the site's. The consent script gives it three calls:

```ts
window.inlay.consent.grant(categories: string[] | 'all'): void
window.inlay.consent.revoke(categories: string[] | 'all'): void
window.inlay.consent.get(): { decided: boolean; analytics: boolean; marketing: boolean; functional: boolean }
```

- **`grant`** records the choice and releases every matching `<template>` on the page, so its scripts run in document order, though a script with `async` doesn't hold up what follows it. Only scripts at the top level of an integration's output wait for each other: one wrapped in another element doesn't hold up what follows it. A template is released once. On every page load, the templates for categories already granted are released.
- **`revoke`** records the choice. It can't unload what already ran, so it takes effect from the next page load: a banner that withdraws consent can reload the page.
- **`get`** says what is granted. `decided` is `false` until the visitor has granted or revoked something, which is when a banner should show.
- **`inlay:consent`** fires on `document` after every `grant` and `revoke`, and once on load, with the same object as `get()` in `detail`. An integration without `consent` that handles consent itself (such as Google's consent mode) can listen for it.

The choice is kept in `localStorage` under `inlay-consent`, with its time, and counts as undecided again after 365 days. Nothing is sent to the server and no cookie is set. Inlay doesn't act on Global Privacy Control or Do Not Track. A minimal banner (the example site has one in `example/site.tsx` and `example/public/consent-banner.js`):

```tsx
<div id="consent-banner" hidden>
  <p>May we count the pages you open?</p>
  <button type="button" data-consent="accept">Accept</button>
  <button type="button" data-consent="decline">Decline</button>
</div>
<script src={ctx.asset('consent-banner.js')} defer />
```

```js
const banner = document.getElementById('consent-banner')
// the consent script is only on pages with a switched-on gated integration
const consent = window.inlay && window.inlay.consent
if (banner && consent) {
  const show = () => { banner.hidden = consent.get().decided }
  show()
  document.addEventListener('inlay:consent', show)
  banner.querySelector('[data-consent="accept"]').addEventListener('click', () => consent.grant('all'))
  banner.querySelector('[data-consent="decline"]').addEventListener('click', () => consent.revoke('all'))
}
```

Inlay provides the gate, not the legal advice: which scripts need consent, and what the banner says, is up to the site.

