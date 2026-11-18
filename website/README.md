# Inlay docs site

The public documentation, built with VitePress and published at https://donstephan.github.io/inlaycms/. `website/` is its own pnpm project: VitePress and Vue are not dependencies of the `inlaycms` package. This file is not a page (it is in `srcExclude`).

## Running and building

From the repository root:

- `pnpm run docs:dev` serves the site with live reload. Without Node, `docker compose up docs` does the same at `http://localhost:5180/inlaycms/` (`INLAY_DOCS_PORT` changes the port).
- `pnpm run docs:build` builds it into `website/.vitepress/dist`.
- `pnpm run docs:preview` serves the built site.
- `pnpm --dir website run check` checks internal links and heading anchors (CI runs it too).

Use `pnpm --dir website <command>` for anything else. Don't use npm.

## Pages and sidebar

Pages are Markdown files: `index.md` (home), `why.md`, and everything else under `docs/`. The sidebar and its order are set by hand in `website/.vitepress/config.ts`, so a new page needs an entry there.

Link between pages with absolute paths without the base or extension, for example `/docs/guides/releases#running-a-host`. VitePress adds the `/inlaycms/` base. In Vue components, wrap internal URLs and assets in `withBase()`.

## Heading text and anchors

A heading's text is its anchor: VitePress lowercases it, turns spaces into `-` and drops punctuation. Links to a heading from other pages (and from the README) break silently when its text changes, and VitePress doesn't check fragments, so keep heading text stable and run the `check` script after renaming one.

## Publishing

`.github/workflows/docs.yml` builds the site and deploys it to GitHub Pages.

- Pushing a stable release tag (`vX.Y.Z`, not a prerelease) runs it from `release.yml`, after CI passes. A failed docs publish doesn't affect the npm package or the image.
- The manual "Docs" workflow (Actions tab, Run workflow) publishes the ref you choose, `main` by default. The docs describe `main`, so use it only when `main` holds nothing unreleased in `website/`.

## One-time setup

In the repository settings:

1. Settings, Pages, Source: GitHub Actions.
2. Settings, Environments, `github-pages`, Deployment branches and tags: add the tag rule `v*` next to `main`. Without it, GitHub only allows Pages deploys from the default branch and the deploy from a release tag is refused.

Do this before the first release tag, which is the first publish. Watch that first run.
