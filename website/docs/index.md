---
title: Overview
---

# Inlay docs

The docs come in three parts: getting started takes you to a running site, the guides each cover one part of building and running it, and the reference lists every command, option, field and setting.

## Get started

- [Quickstart](/docs/quickstart): install Inlay, define a page in `site.tsx` and run it with `inlaycms dev`.
- [Without Node: the Docker image](/docs/docker): run every `inlaycms` command through Docker, with no Node or npm on your computer.
- [Why Inlay](/why): why Inlay exists, and what follows from building a site for its owner to run through an assistant.

## Guides

- [Content model](/docs/guides/content-model): what a site's fields can hold, from inline code and tables to publish dates and multi-select.
- [Rich text](/docs/guides/rich-text): code blocks, heading links, tables, inline text and nested lists in rich text fields.
- [Shipped content](/docs/guides/shipped-content): content that ships with the site's code, its editions and keys, images and Markdown files.
- [Releases and hosting](/docs/guides/releases): pack a signed release, run a host with `inlaycms serve` and deploy with `inlaycms push`.
- [Testing your site](/docs/guides/testing): boot the site in a test with `inlaycms/testing` and check what its pages return.
- [Connect your assistant](/docs/guides/assistant): create the owner account and connect an AI assistant through the MCP server.
- [Admin](/docs/guides/admin): the admin at `/admin`, its Releases screen, and how to brand and arrange it.
- [Search and sharing](/docs/guides/seo): titles, descriptions, share images and the other tags Inlay writes, and the sitemap.
- [Backups, export and restore](/docs/guides/backups): daily and post-publish backups, restoring from the command line, and moving content between installs.
- [Redirects](/docs/guides/redirects): redirects that ship in the site's code, and the ones editors add in the admin.
- [Integrations and consent](/docs/guides/integrations): third-party scripts the developer ships and the owner switches on, and holding them back until a visitor agrees.
- [Security](/docs/guides/security): signed releases and trusted keys, security headers, push tokens and the first-run setup step, in one place.
- [Behind a proxy or CDN](/docs/guides/proxy-cdn): trusting a reverse proxy, and the caching headers a CDN uses.
- [Site password](/docs/guides/site-password): lock the whole public site behind one shared password.

## Reference

- [CLI](/docs/reference/cli): every `inlaycms` command and its options.
- [Config](/docs/reference/config): the options of `defineConfig` and `defineSite`.
- [Field types](/docs/reference/fields): the `f.*` field builders and their options.
- [Environment variables](/docs/reference/environment): every `INLAY_*` setting a host reads.
