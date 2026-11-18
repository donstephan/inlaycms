# Changelog

All notable changes to Inlay are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Inlay uses [Semantic Versioning](https://semver.org/). Until 1.0, a minor version may include breaking changes.

## [Unreleased]

## [0.4.1] - 2026-11-17

### Changed

- The README's examples use generic placeholder values.

### Fixed

- Swapping releases under `inlaycms serve` no longer, now and then, resets a request a client sends down a kept-alive connection just as the old release stops. The old release finishes its open connections instead: each one opened before the swap may get one more answer from it, within 2 seconds, and then closes.
- The admin no longer shifts sideways when moving between short and long pages, or when the menu is taller than the window: space for the page's and the menu's scrollbars is always kept.

## [0.4.0] - 2026-11-17

### Added

- Inline code in rich text and inline text: backticks in Markdown, `<code>` in HTML, a Code button in the admin editor. It can go inside a link and in table cells, but not in bold or italic text. On by default; a field that lists its `features` gets it only by listing `'code'`.

### Fixed

- A site that ships a large set of content no longer fails to start with "Plugin did not start in time". Boot has no time limit, in `inlaycms dev`, `createTestSite`, `serve` and a release's preview.
- Applying shipped content and activating a release are about three times faster for sites with many images: images are still checked for truncation, but no longer re-encoded to do it.
- A link address holding certain private-use characters (U+E000 to U+E004) is written to Markdown as character references, so reading it back no longer turns them into bold, italic or code.

## [0.3.0] - 2026-11-17

### Added

- Default security headers on every response (`nosniff`, a referrer policy, `frame-ancestors 'self'`, and HSTS on https sites), overridable through a validated `headers` setting in `defineSite`.
- Redirect rules in a site's code (`defineSite({ redirects })`). They fire after the admin's rules and never shadow real pages, are carried in the release manifest and diff, are listed read-only in the admin and MCP, and raise `redirect_hidden` and `redirect_loop` warnings in `check` and at boot.
- Absolute `https://` redirect targets from code, the admin, CSV, MCP and export (export format version 2). They are sent only as checked external targets, without the visitor's query string.
- A lowercase fallback: a mixed-case path that would 404 redirects once to wherever its lowercase form leads.
- Site-wide SEO defaults: code `seo` options and an owner-editable `f.seoDefaults()` global, title templates, default share images, per-template `og:type` and Twitter card tags.
- `ctx.head`, for templates to add JSON-LD, meta and link tags to the head, merged with Inlay's own and kept `noindex` in preview.
- `sitemap: true` on GET routes, which lists them in the sitemap with a canonical and records them in the release manifest and diff.
- `ctx.asset`, for content-hashed `/public` URLs; matching `?v=` requests are served as immutable for a year.
- Soft suggested lengths on text fields, with a character counter and hint in the admin.
- Tables in rich text: schema, HTML, plain text, GFM Markdown in both directions, MCP, refs and table editing in the admin.
- `f.inlineText`, with a one-line admin editor, `ctx.inline` and `plainText`, indexed in search.
- `f.multiSelect`. Options no longer offered are dropped on read; export keeps what is stored.
- `publishedAt`: each document's first publish time, carried through export and import, sortable, and emitted as `article:published_time`.
- Images in shipped Markdown, named by path or `file:` URL inside the site folder, imported as media and packed into releases.
- `.md` imports in site code, as strings, with image paths resolved against the file's folder.
- The `inlaycms/testing` entry point. `createTestSite` boots a site the way `inlaycms dev` does, in a temporary folder, and answers requests in process, so a site can test its routes, redirects and sitemap.
- A `fetch` option on `createSiteApp` and the site plugin, passed to routes as `ctx.fetch` (defaults to the global `fetch`).
- A `group` setting on collections, which gives them their own heading in the admin menu. Ungrouped collections are split into Content and Building blocks.

### Changed

- `f.seo()` suggests 70 and 160 characters, with maximums of 300 and 500.
- Each admin menu group is a list labelled by its heading, for screen readers.
- The admin sidebar logo is smaller, so a wide wordmark no longer fills the sidebar. The sign-in cards keep the full size.

### Fixed

- Deleting a redirect is refused, with an error in the admin and MCP, when it would send visitors round a new loop.
- Processes sharing a database wait for each other instead of failing with "database is locked": the write lock is taken at the start of every transaction, release migrations included.
- The page cache is cleared when another process commits to the database, so a `serve` swap or a second dev server can't leave stale pages cached.
- A push whose connection is cut after its last byte was sent now says the push may have gone through, instead of saying the server could not be reached.

## [0.2.0] - 2026-11-16

### Added

- CI on pushes and pull requests: typecheck, tests, pack-test and image-test.
- A tag-driven release workflow that stages the package on npm with provenance and pushes the image to `ghcr.io/donstephan/inlaycms`.

## [0.1.0] - 2026-11-16

First release.

[Unreleased]: https://github.com/donstephan/inlaycms/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/donstephan/inlaycms/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/donstephan/inlaycms/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/donstephan/inlaycms/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/donstephan/inlaycms/compare/abf587e...v0.2.0
[0.1.0]: https://github.com/donstephan/inlaycms/tree/abf587e
