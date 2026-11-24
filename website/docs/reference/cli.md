---
title: CLI
---

# CLI

Every `inlaycms` command with its options, in one place. The guides explain when to use each one; come here for the exact usage line and flags. `npx inlaycms --help` prints the same list.

## The CLI

The commands that work on a site's code or database (`check`, `backup`, `export`, `import`, `restore-backup`, `create-owner`, `create-token`, `reset-password`, `reset-two-factor`, `pack`, `push`) read `inlay.config.ts` (or `.js`, `.mjs`) in the current directory, or the file given with `--config`. On a host, which has no config file, `backup`, `export`, `import`, `restore-backup`, `create-owner`, `create-token`, `reset-password` and `reset-two-factor` work on its data folder instead (see [Running a host](/docs/guides/releases#running-a-host)):

```ts
import { defineConfig } from 'inlaycms/site'
import { site } from './site.js'

export default defineConfig({ site, db: './data/inlay.db' })
```

Paths in it are relative to the config file. The config's options are listed in [Config](/docs/reference/config#defineconfig).

```sh
npx inlaycms check
```

Run `inlaycms check` before every deploy. When the config's database doesn't exist yet, as in a fresh checkout or CI, it checks the code alone; `--db` names a database it must check against. `npx inlaycms --help` lists every command and option.

### Config file or data folder

`backup`, `export`, `import`, `restore-backup`, `create-owner`, `create-token`, `reset-password` and `reset-two-factor` take the data folder from `--data <dir>`, or from `INLAY_DATA_DIR` when no config file is given or found in the current directory. When both are there, the command says which one it uses. `--data` can't be combined with `--config` or `--db`. On a host, `export`, `import` and `create-owner` use the site of the live release; `import` refuses when there is none.

`activate` and `releases` without a host address always work on a data folder (`--data`, or `INLAY_DATA_DIR`) and never read a config file.

### Exit codes

- `0`: the command did what it was asked.
- `1`: a check found problems (`check`, `import`), `pack` refused the site (a failed type check, or code a release can't hold), a host refused (`push`, and `activate` and `releases` with a host), or a user or value was refused (`create-owner`, `create-token`, `reset-password`, `reset-two-factor`).
- `2`: a usage, config or database problem: an unknown command or option, a missing config file, token, signing key or release file, or a database that looks in use.

## dev

```sh
npx inlaycms dev [--config <file>] [--port <n>]
```

Runs the site from its source on this computer and restarts it whenever you save a file in the site's folder. It applies the shipped content on each start. Its database, media and backups go in `data/` next to the config file; keep that folder out of git.

- `--config <file>`: the config file (default: `inlay.config.ts`, `.js` or `.mjs` in the current directory).
- `--port <n>`: the port to run the site on (default: `INLAY_PORT`, or 3000).

It needs no settings. The defaults it fills in are listed under [`inlaycms dev`](/docs/reference/environment#inlaycms-dev) on the environment page. See the [Quickstart](/docs/quickstart).

## check

```sh
npx inlaycms check [--config <file>] [--db <file>] [--json]
npx inlaycms check --export <file> [--config <file>] [--json]
```

Checks the database updates and starting content the site code needs, without changing anything. It reports problems (such as a shipped slug that's already taken, or code that `pack` would refuse) and warnings (such as redirects that loop, or a `'unsafe-inline'` script source), and exits 1 when there are problems. When the config's database doesn't exist yet, it checks the code alone.

- `--config <file>`: the config file.
- `--db <file>`: the database to check against, instead of the one in the config file. It must exist.
- `--export <file>`: check an export file against the site code instead of the database, as `import --dry-run` does. Not with `--db`.
- `--json`: print the report as JSON.

See [Export and import](/docs/guides/backups#export-and-import) for the export report.

## keygen

```sh
npx inlaycms keygen [--out <dir>] [--name <name>]
```

Makes a key pair for signing releases: `<name>.key` (the private key) and `<name>.pub` (the public key, one line such as `ed25519:...`). It refuses to overwrite a key file that already exists.

- `--out <dir>`: the folder for the keys (default: the current directory).
- `--name <name>`: the key file name (default: `inlay`).

See [Packing a release](/docs/guides/releases#packing-a-release).

## pack

```sh
npx inlaycms pack [--key <file>] [--out <file>] [--name <name>] [--no-typecheck] [--config <file>]
```

Makes a signed release file of the site: the bundled site code, the shipped content and its images, and the files in `public/`. It type-checks the site first when a `tsconfig.json` sits next to the config, and refuses site code that imports or uses what a release can't (see [Packing a release](/docs/guides/releases#packing-a-release)).

- `--key <file>`: the private key to sign with (default: `INLAY_SIGNING_KEY`, which holds the key itself or a path to it).
- `--out <file>`: where to write the release (default: `<name>.tgz` in the current directory).
- `--name <name>`: the release name (default: the short git commit and the date, such as `1a2b3c4-20261118`, or just the date outside a git checkout).
- `--no-typecheck`: skip the type check.
- `--config <file>`: the config file.

## push

```sh
npx inlaycms push <host> [--key <file>] [--name <name>] [--no-typecheck] [--config <file>] [--activate] [--dry-run] [--token <token>] [--insecure]
npx inlaycms push <host> --file <file> [--name <name>] [--activate] [--dry-run] [--token <token>] [--insecure]
```

Sends a release to the server at `<host>` (an `http://` or `https://` address) and prints what it would change. The site is packed first, as `pack` does, unless `--file` names a release file. The host keeps it as staged, and `push` prints its preview link.

- `--file <file>`: send this release file instead of packing the site. Not with `--key`, `--config` or `--no-typecheck`.
- `--activate`: make the release live once the server has it. Not with `--dry-run`.
- `--dry-run`: report what the release would change, and keep nothing on the host.
- `--name <name>`: the release name.
- `--token <token>`: the push token (default: `INLAY_PUSH_TOKEN`).
- `--key <file>`: the private key to sign with (default: `INLAY_SIGNING_KEY`).
- `--no-typecheck`: skip the type check.
- `--insecure`: allow an `http://` address that isn't this computer. Without it, the token is only sent over plain `http://` to `localhost`, `127.0.0.1` or `[::1]`.
- `--config <file>`: the config file.

It exits 1 when the host refuses, and 2 when the token, signing key or release file is missing. See [Deploying](/docs/guides/releases#deploying).

## serve

```sh
npx inlaycms serve
```

Runs the site and the admin from the data folder set in `INLAY_DATA_DIR`. It takes no options: every setting is an `INLAY_` environment variable (see [Environment variables](/docs/reference/environment)). It runs the live release in a worker process, starts it again if it crashes, and on SIGTERM or SIGINT finishes the requests in flight and exits. See [Running a host](/docs/guides/releases#running-a-host).

## activate

```sh
npx inlaycms activate <file-or-id> [--data <dir>] [--name <name>] [--server-stopped]
npx inlaycms activate <host> <id> [--token <token>] [--insecure]
```

Makes a release live. The first form works on the host's data folder while the server is stopped: a release file is stored first (its signature must verify against a trusted key), and an ID names a release already stored, which is how you roll back. It uses the same environment as `serve`. The second form asks a running server at `<host>` to make a staged or earlier release live.

- `--data <dir>`: the data folder, instead of `INLAY_DATA_DIR`. First form only.
- `--name <name>`: the release name, when activating a file. First form only.
- `--server-stopped`: go ahead even though the database looks in use, after a server crashed and left files behind. First form only.
- `--token <token>`: the push token (default: `INLAY_PUSH_TOKEN`). Second form only.
- `--insecure`: allow an `http://` address that isn't this computer. Second form only.

See [Running a host](/docs/guides/releases#running-a-host) and [Deploying](/docs/guides/releases#deploying).

## releases

```sh
npx inlaycms releases [--data <dir>] [--json]
npx inlaycms releases <host> [--token <token>] [--json] [--insecure]
```

Lists the releases with their ID, name, state, when each was pushed and when it was made live. The first form reads the data folder and works while the server runs; the second asks the server at `<host>`.

- `--data <dir>`: the data folder, instead of `INLAY_DATA_DIR`. First form only.
- `--json`: print the list as JSON.
- `--token <token>`: the push token (default: `INLAY_PUSH_TOKEN`). Second form only.
- `--insecure`: allow an `http://` address that isn't this computer. Second form only.

## backup

```sh
npx inlaycms backup [--config <file>] [--db <file>]
npx inlaycms backup --data <dir>
```

Writes a backup archive of the database and media (and, on a host, the live release) to the backups folder, and prints its path.

- `--config <file>`: the config file.
- `--db <file>`: the database, instead of the one in the config file.
- `--data <dir>`: the host's data folder, instead of a config file.

See [Backups from the command line](/docs/guides/backups#backups-from-the-command-line).

## restore-backup

```sh
npx inlaycms restore-backup <file> [--server-stopped] [--config <file>] [--db <file>]
npx inlaycms restore-backup <file> --data <dir> [--server-stopped]
```

Replaces the database and media with a backup, and on a host the live release with the one in it. Stop the server first. A bare file name that isn't in the current directory is looked up in the backups folder. The database and media it replaces are kept next to the originals as `*.before-restore-*`.

- `--server-stopped`: go ahead even though the database looks in use.
- `--config <file>`, `--db <file>`, `--data <dir>`: as for `backup`.

See [Backups from the command line](/docs/guides/backups#backups-from-the-command-line).

## export

```sh
npx inlaycms export [--out <file>] [--config <file>] [--db <file>]
npx inlaycms export --data <dir> [--out <file>]
```

Writes all content and media to an export archive: documents, their history, redirects and media, with no users or passwords.

- `--out <file>`: where to write it (default: `inlay-export-<time>.tar.gz` in the current directory).
- `--config <file>`, `--db <file>`, `--data <dir>`: as for `backup`.

See [Export and import](/docs/guides/backups#export-and-import).

## import

```sh
npx inlaycms import <file> [--dry-run] [--json] [--server-stopped] [--config <file>] [--db <file>]
npx inlaycms import <file> --data <dir> [--dry-run] [--json] [--server-stopped]
```

Replaces the content with an export. It always dry-runs first, then takes a backup and replaces documents, history, redirects and media in one step; users, sessions and API keys stay as they are. It refuses while the server is running, and exits 1 when the export as a whole has problems.

- `--dry-run`: only report what would happen.
- `--json`: with `--dry-run`, print the report as JSON.
- `--server-stopped`: go ahead even though the database looks in use.
- `--config <file>`, `--db <file>`, `--data <dir>`: as for `backup`.

See [Export and import](/docs/guides/backups#export-and-import).

## create-owner

```sh
npx inlaycms create-owner --email <email> --name <name> [--config <file>] [--db <file>]
npx inlaycms create-owner --email <email> --name <name> --data <dir>
```

Creates the owner of the site, as `/admin/setup` does in the browser. The password is read from the terminal or stdin.

- `--email <email>`: the owner's email. Required.
- `--name <name>`: the owner's name. Required.
- `--config <file>`, `--db <file>`, `--data <dir>`: as for `backup`.

See [Connect your assistant](/docs/guides/assistant).

## create-token

```sh
npx inlaycms create-token --email <email> --name <name> [--push] [--config <file>] [--db <file>]
npx inlaycms create-token --email <email> --name <name> [--push] --data <dir>
```

Makes an API key for a user and prints it, only this once, alone on standard output so a script can capture it. It works whether the server is running or not.

- `--email <email>`: the user the key belongs to. Required.
- `--name <name>`: the key's name. Required.
- `--push`: make a push token for `inlaycms push`, which may push releases and make them live. Owners only.
- `--config <file>`, `--db <file>`, `--data <dir>`: as for `backup`.

See [Deploying](/docs/guides/releases#deploying).

## reset-password

```sh
npx inlaycms reset-password --email <email> [--config <file>] [--db <file>]
npx inlaycms reset-password --email <email> --data <dir>
```

Sets a new password for a user, for when they are locked out. The password is read from the terminal or stdin. The user is signed out everywhere and their API keys stop working.

- `--email <email>`: the user. Required.
- `--config <file>`, `--db <file>`, `--data <dir>`: as for `backup`.

See [Connect your assistant](/docs/guides/assistant).

## reset-two-factor

```sh
npx inlaycms reset-two-factor --email <email> [--config <file>] [--db <file>]
npx inlaycms reset-two-factor --email <email> --data <dir>
```

Turns [two-step login](/docs/guides/security#two-step-login) off for a user, for when they lost their authenticator app. The user is signed out everywhere. Their password, API keys and connected assistants are untouched. It exits with `1` for an unknown user, or one who doesn't have two-step login on (their sessions are left alone).

- `--email <email>`: the user. Required.
- `--config <file>`, `--db <file>`, `--data <dir>`: as for `backup`.

See [Two-step login](/docs/guides/security#two-step-login).
