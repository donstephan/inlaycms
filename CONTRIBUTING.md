# Contributing

## Working on Inlay

The repo uses pnpm, not npm.

- `pnpm test` runs the tests and `pnpm run typecheck` checks the types. `pnpm run build` builds the package into `dist/`.
- `pnpm run dev` runs the example site in `example/` through `inlaycms dev` at `http://localhost:3000`, with its data in `example/data/`: it restarts the site when a file in `example/` changes and rebuilds the admin's assets when `client/admin/` changes. A change to Inlay's own code in `src/` restarts `inlaycms dev` itself. Reload the page to see a change. `docker compose up dev` does the same in a container. It joins the external `inlay-dev` network, which you create once with `docker network create inlay-dev`.
- The admin's CSS and JavaScript are built from `client/admin/` into `assets/admin/`, which ships in the package. `pnpm run build:admin` builds them once. `pnpm run build` runs it first, and `pnpm test` runs it when the files are missing.
- `pnpm run example:pack` packs the example site into `example/data/release.tgz`, signed with the development key in `example/keys/`.
- `docker compose run --rm pack-test` packs Inlay, installs the tarball into a fresh copy of `example/`, packs the example into a release, activates it offline into a fresh data folder, runs `inlaycms serve` on it, pushes a second release to the running host and rolls back, and checks the site, admin, MCP and every CLI command. Run it before a release.
- Docs: `pnpm run docs:dev` runs the docs site at `http://localhost:5173/inlaycms/`, with its pages in `website/`. Without Node on your machine, `docker compose up docs` does the same at `http://localhost:5180/inlaycms/` (`INLAY_DOCS_PORT` changes the port). See `website/README.md` for building, the anchor rule and publishing.

### Trying the deploy path locally

`docker compose run --rm pack-test` is the deploy path end to end: it makes the first release and an owner offline, mints a push key with `inlaycms create-token --push`, starts `inlaycms serve`, pushes a second release with `inlaycms push --activate`, checks the diff and the site, confirms that a `--dry-run` push changes nothing, and rolls back with `inlaycms activate <host> <id>`. To try it by hand, run `docker compose up serve` (see [Running a host](https://donstephan.github.io/inlaycms/docs/guides/releases#running-a-host)), create a push key in the same container, and push to `http://localhost:3000`.

The manual checks in a real browser and against Claude clients are in `docs/admin-acceptance.md` and `docs/mcp-acceptance.md`.
