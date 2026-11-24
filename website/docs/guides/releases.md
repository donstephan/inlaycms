---
title: Releases and hosting
---

# Releases and hosting

How to pack your site into a signed release, run a host, and send releases to it. Read it when you are ready to put a site online.

## Packing a release

A release is your whole site in one signed file: the bundled site code, the shipped content and its images, and the files in `public/`. Secret values are never in it; it lists only the secret names the site declares (`secrets` in `defineSite`), and the host provides the values.

Make a signing key pair once, on the machine you release from:

```sh
npx inlaycms keygen --out keys --name release
```

This writes `keys/release.key` (the private key: keep it secret and out of the repo) and `keys/release.pub`, a one-line public key such as `ed25519:...`. Give the public key to every host that should run your releases: a host only accepts a release whose signature verifies against one of its trusted keys, and refuses it before reading anything else in it.

Then pack:

```sh
npx inlaycms pack --key keys/release.key --out release.tgz
```

`pack` type-checks the site first when a `tsconfig.json` sits next to the config (`--no-typecheck` skips that). The key can also come from `INLAY_SIGNING_KEY`, as the key itself or a path to it.

Files in `public/` are served under `/public/` and, when the file name has a dot, also at the same path from the site root: `public/privacy-policy.pdf` is at `/privacy-policy.pdf` as well, for releases packed with 0.7.0 or later. A root address that would clash with one of Inlay's own paths, with `robots.txt` or `sitemap.xml`, or with one of the site's routes stops `check` and `pack`.

Site code imports Inlay from `inlaycms/site` (and JSX from `inlaycms/jsx-runtime`), never from `inlaycms` itself, which is the host's side. `pack` refuses a site that imports anything else it can't bundle, such as Node's built-in modules or `inlaycms`, and site code that uses `process`, `require`, `eval` or `Function` (also as `globalThis.eval` and the like) or an `import()` of a computed name. An `import()` of a template under a relative folder, such as ``import(`./locales/${lang}.js`)``, is fine: every matching file is bundled. Those checks catch mistakes; they don't make a release safe to run. What makes a release trusted is its signature: a host runs only releases signed with a key it trusts, so trust a key only if you trust everyone who can sign with it.

The example site in `example/` commits a key pair in `example/keys/` (`dev.key`, `dev.pub`) so `pnpm run example:pack` works out of the box. It is for development only: never trust `example/keys/dev.pub` on a real host.

## Running a host

`inlaycms serve` runs the site and the admin from a data folder, with its settings in `INLAY_` environment variables: `INLAY_DATA_DIR` (the folder holding `inlay.db`, `media/`, `backups/` and `releases/`), `INLAY_BASE_URL`, `INLAY_SECRET` (32 characters or more) and `INLAY_TRUSTED_KEYS` (the public keys whose releases it accepts; or `INLAY_TRUSTED_KEYS_FILE`). The secrets a release declares are read from the host's environment by name. The optional ones are `INLAY_PORT` (default 3000), `INLAY_HOST` (default `0.0.0.0`), `INLAY_RATE_LIMIT` (`on` or `off`), `INLAY_TRUST_PROXY` (the reverse proxies to trust; see [Behind a reverse proxy](/docs/guides/proxy-cdn#behind-a-reverse-proxy)), `INLAY_UPLOAD_MAX_BYTES`, `INLAY_BACKUP_KEEP`, `INLAY_PUBLIC_MAX_AGE`, `INLAY_CDN_MAX_AGE` and `INLAY_CDN_STALE_IF_ERROR`. Each one is described in [Environment variables](/docs/reference/environment).

```sh
export INLAY_DATA_DIR=/srv/inlay INLAY_BASE_URL=https://example.com
export INLAY_SECRET="$(cat /etc/inlay/secret)" INLAY_TRUSTED_KEYS="$(cat release.pub)"
npx inlaycms activate release.tgz   # the first release, while the server is stopped
npx inlaycms serve
```

`serve` runs the live release in a worker process and keeps the database untouched at start: shipped content is applied only when a release is activated. With no release yet, the site shows a plain "no site yet" page (status 200, not indexed) and the admin works. When a live site can't be served (its release is missing from the data folder, was packed with a version of Inlay this server no longer runs (or a newer minor version of Inlay than the server), or keeps crashing), visitors get a "temporarily unavailable" page instead, with status 503 and `Retry-After`, so search engines keep the site; the admin still works. A worker that crashes is started again. On SIGTERM or SIGINT it finishes the requests in flight, closes the database and exits.

The Docker image, `ghcr.io/donstephan/inlaycms` (also the CLI: see [Without Node: the Docker image](/docs/docker#without-node-the-docker-image)), runs `inlaycms serve` with `INLAY_DATA_DIR=/data` on a volume and port 3000. With `INLAY_SECRET` and `INLAY_TRUSTED_KEYS` set in your shell:

```sh
docker run -d --name inlay --restart unless-stopped -p 3000:3000 -v inlay-data:/data \
  -e INLAY_SECRET -e INLAY_TRUSTED_KEYS ghcr.io/donstephan/inlaycms
```

Run `inlaycms activate` in a container on the same volume to give it its first release. The release file must be inside the container, so mount it: `docker run --rm -v inlay-data:/data -v "$PWD/release.tgz:/release.tgz:ro" ghcr.io/donstephan/inlaycms inlaycms activate /release.tgz`. The image holds the packed `inlaycms` with its production dependencies only, with `inlaycms` on the `PATH`. Every release of Inlay is tagged with its version (`ghcr.io/donstephan/inlaycms:0.2.0`, and `0.2` for the newest patch of 0.2); `latest` is the newest release. In this repository, `docker compose up serve` builds the image from source and runs it.

To give a host its first release, or to make a release live while it is stopped:

```sh
npx inlaycms activate release.tgz [--data <dir>] [--name <name>]
npx inlaycms activate <release-id>
npx inlaycms releases [--data <dir>] [--json]
```

`activate` with a file stores the release (its signature must verify against a trusted key) and makes it live; with an ID it makes a release already on the host live again, which is how you roll back. A release is refused when it was packed with a version of Inlay older than this one still runs, or with a newer minor version of Inlay than this one (see [Upgrading Inlay](#upgrading-inlay)). It applies the release's shipped content, runs its migration functions and prints what it did; a backup is taken first when the site has content (and before the database structure is updated, when this version of Inlay needs to). A shipped slug or path that is already taken doesn't stop it: the document keeps the slug and path it had (a new one gets a free slug and no path of its own), and a warning says so; `inlaycms check` reports these as problems. Activation writes its changes in one database transaction that locks the database for writing from start to end; the media files the shipped content names are stored before it starts, but the release's migration functions run inside it. While it runs, saves in the admin wait up to 5 seconds and then fail, so keep migration functions quick and activate when few people are editing. It uses the same environment as `serve`, and `--data` stands in for `INLAY_DATA_DIR`. Stop the server first: a running server wouldn't see the change, so `activate` refuses while the database looks in use (see [Backups from the command line](/docs/guides/backups#backups-from-the-command-line)); add `--server-stopped` if the server crashed and left files behind. `releases` lists every release on the host with its ID, name, state and when it was pushed and made live; it needs only the data folder and works while the server runs.

On a host, `backup`, `export`, `import`, `restore-backup`, `create-owner`, `create-token` and `reset-password` take the data folder from `--data <dir>`, or from `INLAY_DATA_DIR` when there's no config file in the current directory, and need no config file. When both are there, the command says which one it uses. `export`, `import` and `create-owner` use the site of the live release; `import` refuses when there is none.

## Upgrading Inlay

Upgrade the host (or the image) whenever you like. The live release keeps running if it was packed with this version of Inlay or the one before it, and the database is updated first, after a backup.

Before 1.0, Inlay 0.N always runs releases packed with 0.(N-1) and 0.N, so upgrading one minor version at a time never takes a site down, and you can pack the site again whenever it suits you. A new version may stop running releases packed two or more versions back, but only when something they use has really changed, and the version before it warns you first: the admin's Releases screen, `inlaycms releases`, `push` and the server log all say "pack again". For example, if 0.7 stops running 0.5 releases, 0.6 shows the warning on them. If nothing changed, older releases keep running. From 1.0 the same rule applies to major versions.

This promise starts with the version that ships it. Releases packed with Inlay 0.4 or earlier are not covered: pack them again once, with a version that has the promise. Until then, a host that jumps from 0.4 shows the "temporarily unavailable" page for the live site.

A release packed with a newer minor version of Inlay than the server is refused: upgrade the server first. A newer patch version (0.6.2 on a 0.6.1 server) runs fine, so there is no need to upgrade for it.

Going back to an older Inlay isn't supported once a newer one has updated the database. Restore the backup taken before the update instead (see [Backups from the command line](/docs/guides/backups#backups-from-the-command-line)).

## Deploying

Once a host is running, send it releases from your machine or CI with `inlaycms push`, which needs a push token: an owner's API key that can push, activate, list and delete releases and do nothing else (it is refused on `/mcp`, so it can't read or change content). An owner makes one in the admin (an API key with "For pushing releases only" turned on), or on the host with the CLI, which prints the key once (alone on standard output, so a script can capture it) and works whether the server is running or not:

```sh
npx inlaycms create-token --email owner@example.com --name ci --push [--data <dir>]
```

Then push:

```sh
export INLAY_PUSH_TOKEN=...   # or --token <token>
npx inlaycms push https://example.com --key keys/release.key
```

`push` packs the site into a temporary file (as `pack` does, type check included; `--key` or `INLAY_SIGNING_KEY`, `--name`, `--no-typecheck`), or sends the release file given with `--file`. The host checks its signature, the Inlay version and the secrets it needs, keeps it as staged (not live yet) and answers with what it would change, which `push` prints one line per item: content types, slots, languages and fields added or removed (removed content is hidden, never deleted), the published documents a new required field leaves with a gap, the shipped documents it will create or replace, migration functions, routes, code redirects and secrets. It also warns about shipped content that changed while its edition didn't ("`home` content changed but is still edition 2; it won't be applied"): bump the edition to have it applied. Several releases can be staged at once.

A staged release also gets a preview link, which `push` prints: opening it shows the whole site as that release would, on a copy of the live content, for 24 hours, in that browser only. Nothing can be changed in a preview; the admin stays the live site's. Exit the preview at `/_inlay/preview/exit`.

Owners can do the same from the admin's **Releases** screen (see [Releases](/docs/guides/admin#releases)): upload a release file, see what it would change, preview it, activate it and delete releases that aren't live.

A push runs the release's code on the host straight away, a dry run too: the host starts the release's preview to work out what it would change in your content. So the signature is what stands between the host and the code it runs: only trust keys whose private half you control, and keep that half out of the repository.

- `--dry-run` reports the same and keeps nothing on the host. It can't be combined with `--activate`.
- `--activate` makes the release live right after: the host starts the new release next to the old one and switches over once it is ready, so no request is refused, then prints what activating did. If the connection drops or a proxy gives up before the answer, the push may still have gone through: `push` says so, and `inlaycms releases <host>` shows where things stand.
- `inlaycms activate <host> <id>` makes a staged or earlier release live. That is also how you roll back: activate the release that was live before.
- `inlaycms releases <host> [--json]` lists the releases on the host with their IDs and states.

All three take the token from `--token` or `INLAY_PUSH_TOKEN`. They exit 1 when the host refuses (printing its reason, such as a release signed with a key it doesn't trust, or a token that may not push) and 2 when the token, signing key or release file is missing. A host address starts with `http://` or `https://`; without one, `activate` and `releases` work offline on the data folder as described above. The token is only sent over plain `http://` to this computer (`localhost`, `127.0.0.1`, `[::1]`), unless you add `--insecure`; and it is never sent on to another address the host redirects to.

