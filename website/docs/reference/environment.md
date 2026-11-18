---
title: Environment variables
---

# Environment variables

Every `INLAY_` environment variable Inlay reads. A host running `inlaycms serve` takes all its settings from these; `inlaycms dev` fills in the required ones for you, and a few CLI commands read their own.

## The host

`inlaycms serve` reads these at start. The same settings apply to `activate` and `releases` without a host address (where `--data` stands in for `INLAY_DATA_DIR`), and the database commands use `INLAY_DATA_DIR` when there's no config file. Numbers are whole numbers of 0 or more; flags are `on` or `off`. A value that can't be used stops the server with a message naming it.

| Variable | What it does | Default | Required by `serve` |
| --- | --- | --- | --- |
| `INLAY_DATA_DIR` | The folder holding `inlay.db`, `media/`, `backups/` and `releases/`. | none | Yes |
| `INLAY_BASE_URL` | The full address of the site, starting with `https://` or `http://`, with nothing after the domain, such as `https://example.com`. Used for canonical, Open Graph and sitemap URLs, sign-in and preview links. | none | Yes |
| `INLAY_SECRET` | The server's own secret, at least 32 characters, used to sign sessions and preview links. Keep it private. | none | Yes |
| `INLAY_TRUSTED_KEYS` | The public keys whose releases the host accepts, as `inlaycms keygen` prints them, separated by commas or new lines. | none | Yes, or `INLAY_TRUSTED_KEYS_FILE` |
| `INLAY_TRUSTED_KEYS_FILE` | A file listing trusted public keys, one per line; lines starting with `#` are ignored. Its keys are added to `INLAY_TRUSTED_KEYS`. | none | Yes, or `INLAY_TRUSTED_KEYS` |
| `INLAY_PORT` | The port to listen on, 1 to 65535. | `3000` | No |
| `INLAY_HOST` | The address to listen on. | `0.0.0.0` | No |
| `INLAY_RATE_LIMIT` | Rate limits on sign-in and on the site password form, per visitor address. | `on` | No |
| `INLAY_TRUST_PROXY` | The reverse proxies whose `X-Forwarded-For` header is believed: IP addresses and ranges separated by commas, or `loopback`, `linklocal` and `uniquelocal`. There's no setting that trusts every address. See [Behind a reverse proxy](/docs/guides/proxy-cdn#behind-a-reverse-proxy). | `off` | No |
| `INLAY_UPLOAD_MAX_BYTES` | The largest media file that can be uploaded, in bytes. | `20971520` (20 MB) | No |
| `INLAY_BACKUP_KEEP` | How many daily and post-publish backups of each kind are kept. See [Daily and post-publish backups](/docs/guides/backups#daily-and-post-publish-backups). | `14` | No |
| `INLAY_PUBLIC_MAX_AGE` | The cache lifetime (`max-age`), in seconds, of files under `/public/`, except those linked through `ctx.asset`, which are cached for a year. | `3600` | No |
| `INLAY_CDN_MAX_AGE` | How long, in seconds, shared caches may serve a published page before checking back (`s-maxage`). `0` makes them revalidate on every request. See [Behind a CDN](/docs/guides/proxy-cdn#behind-a-cdn). | `15` | No |
| `INLAY_CDN_STALE_IF_ERROR` | How long, in seconds, shared caches may keep serving the last good copy of a page while the origin is down (`stale-if-error`). | `86400` | No |

The secrets a release declares (`secrets` in `defineSite`) are read from the host's environment by name, such as `SLACK_WEBHOOK`. They aren't `INLAY_` variables. See [Running a host](/docs/guides/releases#running-a-host) for a host's setup from start to finish.

## The CLI

| Variable | What it does | Read by |
| --- | --- | --- |
| `INLAY_SIGNING_KEY` | The private key to sign releases with: the key itself, or a path to it. `--key` wins over it. | `pack`, `push` |
| `INLAY_PUSH_TOKEN` | The push token for a host. `--token` wins over it. | `push`, and `activate` and `releases` with a host address |

`restore-backup` also reads `INLAY_TRUSTED_KEYS` and `INLAY_TRUSTED_KEYS_FILE`: when either is set, it checks the signature of the release in the backup. See the [CLI reference](/docs/reference/cli).

## `inlaycms dev`

`inlaycms dev` needs no settings. It fills in these defaults and passes the rest through, so any other `INLAY_` setting from the table above can still be set:

- `INLAY_DATA_DIR`: `data/` next to the config file. A relative path you set is taken from the current directory.
- `INLAY_BASE_URL`: the local address, `http://localhost:<port>`.
- `INLAY_SECRET`: a fixed development value.
- `INLAY_PORT`: `--port`, then `INLAY_PORT`, then 3000.
- `INLAY_HOST`: `localhost`, so the site is reachable only from this computer.

Set the secrets the site declares in the environment, as on a host. `createTestSite` from `inlaycms/testing` sets its own: a temporary data folder, a random secret and rate limits off (see [Testing your site](/docs/guides/testing)).

## The Docker wrapper

The `inlaycms` script that runs the CLI through the Docker image reads two settings of its own and passes every other `INLAY_` variable to the command:

- `INLAY_IMAGE`: the image to run (default `ghcr.io/donstephan/inlaycms`).
- `INLAY_DOCKER_ARGS`: more `docker run` options, split on spaces.

See [Without Node: the Docker image](/docs/docker).

<!--
Left out on purpose: variables Inlay sets for its own processes, never by hand.
INLAY_DEV_CONFIG (set by inlaycms dev for its child process),
INLAY_WORKER_RELEASE, INLAY_WORKER_ACTIVATE, INLAY_WORKER_NO_SITE, INLAY_WORKER_LISTEN,
INLAY_WORKER_PREVIEW and INLAY_WORKER_PREVIEW_DIR (set by the serve primary for its workers).
INLAY_BIN, INLAY_ENTRIES, INLAY_THEME and INLAY_SHAPE also match the grep but are constants in the code, not environment variables.
-->
