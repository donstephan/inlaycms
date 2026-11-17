# inlay

Inlay is a CMS for content sites. You build the site in code: its templates, the blocks they're made of, its collections, site-wide content and languages. The site's owner fills in the content, in the slots you cut for it. Everything lives in one SQLite file. Inlay is the whole server: you pack the site into a signed release, push it to a host running `inlaycms serve`, preview it on the live content and activate it when it's ready.

## Why we made it

The CMSs we tried all sat at the wrong point:

- **Schema in the database** (WordPress-style systems, Directus). The content model is reshaped at runtime, so rebuilding a site from code means replaying seed files, and editors and plugins can move the walls.
- **App frameworks** (Payload, Strapi). The right model, with the schema in code, but heavy: you end up building a whole app.
- **Git- or file-based** (Keystatic, Tina, Decap). Also the right model, but too light: there's no real server, so no history, no sign-in, and nothing for an assistant to talk to.

Inlay sits between them. Templates and schema are code, the database only ever holds content, and the server is real enough to provide history, drafts and publishing, accounts, backups and an MCP server.

That last one matters most. We expect most owners to run their site by talking to an AI assistant: "change the home page headline", "write a post from these notes", "translate About into Spanish". The admin is for looking, checking and fixing, and has full hand-editing as the fallback. The goal is a site a non-technical owner can run mostly through an assistant, without ever being able to break the design the developer built.

A few things follow from that:

- **No page builder.** Editors fill slots. They never rearrange the layout or add sections, so every arrangement a page can take is one the developer designed.
- **Problems are caught before deploy.** `inlaycms check` tells you whether the content fits new site code before you ship it, rather than a running site finding out.
- **The site belongs to its owner.** It runs on their server, with their data and their backups, and the export format is documented well enough to read without Inlay.
- **One install per site.** An agency with ten clients runs ten installs, and can come back months later to push an update.

## Quickstart

Inlay needs Node 24 or newer, and Fastify 5. Or skip Node altogether and run every command through the Docker image: see [Without Node: the Docker image](#without-node-the-docker-image).

```sh
npm install inlaycms fastify
npm install --save-dev typescript
```

TypeScript is optional: `inlaycms pack` type-checks the site when it's installed. The CLI loads the site's TypeScript and JSX itself, so no loader such as tsx is needed.

Templates render with JSX, so point your `tsconfig.json` at Inlay's runtime. Inlay bundles the site's code itself, so type-check it as bundled code, which also needs no `"type": "module"` in `package.json`:

```json
{
  "compilerOptions": {
    "module": "preserve",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "inlaycms",
    "strict": true
  }
}
```

Define the site in `site.tsx`. A template says which fields a page has and how it renders, and a singleton is one page built from it:

```tsx
import { defineContent, defineSingleton, defineSite, defineTemplate, f, z } from 'inlaycms/site'

const Page = defineTemplate({
  name: 'page',
  label: 'Page',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    body: f.richText({ label: 'Body' }),
  }),
  render: ({ fields }, ctx) => (
    <html lang={ctx.locale}>
      <body>
        <h1>{fields.title}</h1>
        {ctx.richText(fields.body)}
      </body>
    </html>
  ),
})

export const site = defineSite({
  locales: ['en'],
  defaultLocale: 'en',
  singletons: [
    defineSingleton({
      name: 'home',
      label: 'Home page',
      help: 'The front page of the site.',
      template: Page,
      path: '/',
    }),
  ],
  content: [
    defineContent('home', {
      edition: 1,
      content: { en: { fields: { title: 'Hello', body: 'Your first page. Ask your assistant to change it.' } } },
    }),
  ],
})
```

Labels and `help` are what editors and their assistants see, so write them for the owner, not for yourself. `content` is the content shipped with the site: `defineContent` for a singleton or global, `defineEntries` for a collection's entries, each with a stable `key`. Bump an `edition` to replace what the client has with the new shipped content; an equal or lower edition leaves their edits alone. Collections, globals, blocks, slots and more languages work the same way. `example/site.tsx` uses all of them.

Point Inlay at it with `inlay.config.ts`, next to `site.tsx`:

```ts
import { defineConfig } from 'inlaycms/site'
import { site } from './site.js'

export default defineConfig({ site })
```

Then run it from source:

```sh
npx inlaycms dev
```

`inlaycms dev` serves the site at `http://localhost:3000` (`--port` changes the port, `--config` the config file) and restarts it whenever you save a file in the site's folder. Its database, media and backups go in `data/` next to the config file; keep that folder out of git. It needs no settings: `INLAY_BASE_URL` defaults to the local address and `INLAY_SECRET` to a fixed development value, and any other `INLAY_` setting from [Running a host](#running-a-host) can still be set. Set the secrets the site declares in the environment, as on a host.

On each start, Inlay brings the database up to date and applies the shipped content: documents that don't exist yet are created, and ones with a newer edition are replaced. Stored content is read against the current code: values that fit are used and the rest take their defaults, so a schema change never stops the site from starting. Open `http://localhost:3000` for the site and `http://localhost:3000/admin` to create the owner account.

To put the site online, pack it into a release and run it on a host with `inlaycms serve`: see [Packing a release](#packing-a-release) and [Running a host](#running-a-host).

### The CLI

The commands that work on a site's code or database (`check`, `backup`, `export`, `import`, `restore-backup`, `create-owner`, `create-token`, `reset-password`, `keygen`, `pack`, `push`) read `inlay.config.ts` (or `.js`, `.mjs`) in the current directory, or the file given with `--config`. On a host, which has no config file, `backup`, `export`, `import`, `restore-backup`, `create-owner`, `create-token` and `reset-password` work on its data folder instead (see [Running a host](#running-a-host)):

```ts
import { defineConfig } from 'inlaycms/site'
import { site } from './site.js'

export default defineConfig({ site, db: './data/inlay.db' })
```

Paths in it are relative to the config file.

```sh
npx inlaycms check
```

Run `inlaycms check` before every deploy. When the config's database doesn't exist yet, as in a fresh checkout or CI, it checks the code alone; `--db` names a database it must check against. `npx inlaycms --help` lists every command and option.

### Packing a release

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

Site code imports Inlay from `inlaycms/site` (and JSX from `inlaycms/jsx-runtime`), never from `inlaycms` itself, which is the host's side. `pack` refuses a site that imports anything else it can't bundle, such as Node's built-in modules or `inlaycms`, and site code that uses `process`, `require`, `eval` or `Function` (also as `globalThis.eval` and the like) or an `import()` of a computed name. An `import()` of a template under a relative folder, such as ``import(`./locales/${lang}.js`)``, is fine: every matching file is bundled. Those checks catch mistakes; they don't make a release safe to run. What makes a release trusted is its signature: a host runs only releases signed with a key it trusts, so trust a key only if you trust everyone who can sign with it.

The example site in `example/` commits a key pair in `example/keys/` (`dev.key`, `dev.pub`) so `pnpm run example:pack` works out of the box. It is for development only: never trust `example/keys/dev.pub` on a real host.

### Running a host

`inlaycms serve` runs the site and the admin from a data folder, with its settings in `INLAY_` environment variables: `INLAY_DATA_DIR` (the folder holding `inlay.db`, `media/`, `backups/` and `releases/`), `INLAY_BASE_URL`, `INLAY_SECRET` (32 characters or more) and `INLAY_TRUSTED_KEYS` (the public keys whose releases it accepts; or `INLAY_TRUSTED_KEYS_FILE`). The secrets a release declares are read from the host's environment by name. The optional ones are `INLAY_PORT` (default 3000), `INLAY_HOST` (default `0.0.0.0`), `INLAY_RATE_LIMIT` (`on` or `off`), `INLAY_TRUST_PROXY` (the reverse proxies to trust; see [Behind a reverse proxy](#behind-a-reverse-proxy)), `INLAY_UPLOAD_MAX_BYTES`, `INLAY_BACKUP_KEEP`, `INLAY_PUBLIC_MAX_AGE`, `INLAY_CDN_MAX_AGE` and `INLAY_CDN_STALE_IF_ERROR`.

```sh
export INLAY_DATA_DIR=/srv/inlay INLAY_BASE_URL=https://example.com
export INLAY_SECRET="$(cat /etc/inlay/secret)" INLAY_TRUSTED_KEYS="$(cat release.pub)"
npx inlaycms activate release.tgz   # the first release, while the server is stopped
npx inlaycms serve
```

`serve` runs the live release in a worker process and keeps the database untouched at start: shipped content is applied only when a release is activated. With no release yet, the site shows a plain "no site yet" page (status 200, not indexed) and the admin works. When a live site can't be served (its release is missing from the data folder, needs another version of Inlay, or keeps crashing), visitors get a "temporarily unavailable" page instead, with status 503 and `Retry-After`, so search engines keep the site; the admin still works. A worker that crashes is started again. On SIGTERM or SIGINT it finishes the requests in flight, closes the database and exits.

The Docker image, `ghcr.io/donstephan/inlaycms` (also the CLI: see [Without Node: the Docker image](#without-node-the-docker-image)), runs `inlaycms serve` with `INLAY_DATA_DIR=/data` on a volume and port 3000. With `INLAY_SECRET` and `INLAY_TRUSTED_KEYS` set in your shell:

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

`activate` with a file stores the release (its signature must verify against a trusted key) and makes it live; with an ID it makes a release already on the host live again, which is how you roll back. A release made for another version of Inlay is refused. It applies the release's shipped content, runs its migration functions and prints what it did; a backup is taken first when the site has content (and before the database structure is updated, when this version of Inlay needs to). A shipped slug or path that is already taken doesn't stop it: the document keeps the slug and path it had (a new one gets a free slug and no path of its own), and a warning says so; `inlaycms check` reports these as problems. Activation writes its changes in one database transaction that locks the database for writing from start to end; the media files the shipped content names are stored before it starts, but the release's migration functions run inside it. While it runs, saves in the admin wait up to 5 seconds and then fail, so keep migration functions quick and activate when few people are editing. It uses the same environment as `serve`, and `--data` stands in for `INLAY_DATA_DIR`. Stop the server first: a running server wouldn't see the change, so `activate` refuses while the database looks in use (see [Backups from the command line](#backups-from-the-command-line)); add `--server-stopped` if the server crashed and left files behind. `releases` lists every release on the host with its ID, name, state and when it was pushed and made live; it needs only the data folder and works while the server runs.

On a host, `backup`, `export`, `import`, `restore-backup`, `create-owner`, `create-token` and `reset-password` take the data folder from `--data <dir>`, or from `INLAY_DATA_DIR` when there's no config file in the current directory, and need no config file. When both are there, the command says which one it uses. `export`, `import` and `create-owner` use the site of the live release; `import` refuses when there is none.

### Deploying

Once a host is running, send it releases from your machine or CI with `inlaycms push`, which needs a push token: an owner's API key that may push releases. An owner makes one in the admin (an API key with "Can push releases" turned on), or on the host with the CLI, which prints the key once (alone on standard output, so a script can capture it) and works whether the server is running or not:

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

Owners can do the same from the admin's **Releases** screen (see [Releases](#releases)): upload a release file, see what it would change, preview it, activate it and delete releases that aren't live.

A push runs the release's code on the host straight away, a dry run too: the host starts the release's preview to work out what it would change in your content. So the signature is what stands between the host and the code it runs: only trust keys whose private half you control, and keep that half out of the repository.

- `--dry-run` reports the same and keeps nothing on the host. It can't be combined with `--activate`.
- `--activate` makes the release live right after: the host starts the new release next to the old one and switches over once it is ready, so no request is refused, then prints what activating did. If the connection drops or a proxy gives up before the answer, the push may still have gone through: `push` says so, and `inlaycms releases <host>` shows where things stand.
- `inlaycms activate <host> <id>` makes a staged or earlier release live. That is also how you roll back: activate the release that was live before.
- `inlaycms releases <host> [--json]` lists the releases on the host with their IDs and states.

All three take the token from `--token` or `INLAY_PUSH_TOKEN`. They exit 1 when the host refuses (printing its reason, such as a release signed with a key it doesn't trust, or a token that may not push) and 2 when the token, signing key or release file is missing. A host address starts with `http://` or `https://`; without one, `activate` and `releases` work offline on the data folder as described above. The token is only sent over plain `http://` to this computer (`localhost`, `127.0.0.1`, `[::1]`), unless you add `--insecure`; and it is never sent on to another address the host redirects to.

### Type-checking your site

If your site's `tsconfig.json` has `skipLibCheck: false`, `tsc` reports one error from better-auth's own type files, which Inlay depends on: `Cannot find module 'bun:sqlite'`. It comes from types for running under Bun, has no effect on a Node site, and isn't something your code or Inlay can fix. Leave `skipLibCheck` on (`true`), or ignore that one error.

## Without Node: the Docker image

The Inlay image holds the whole CLI as well as the host, so a computer with Docker needs no Node or npm. It's published on GitHub's container registry as `ghcr.io/donstephan/inlaycms`. Install the `inlaycms` script it carries:

```sh
docker run --rm ghcr.io/donstephan/inlaycms cat /opt/inlaycms/wrapper/inlaycms > ~/.local/bin/inlaycms
chmod +x ~/.local/bin/inlaycms
```

Then use `inlaycms` in a site's folder as anywhere else in this README: `inlaycms dev`, `inlaycms check`, `inlaycms pack`, `inlaycms push`. A site needs no `node_modules`: its `inlaycms` imports load the image's copy, and `inlaycms pack` type-checks with the image's TypeScript when the site has a `tsconfig.json`. A site that uses npm packages installs them as usual, with npm or through the image (`docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:$PWD" -w "$PWD" -e HOME=/tmp ghcr.io/donstephan/inlaycms npm install <package>`).

The script runs the image on the current folder, mounted at the same path, so paths mean the same inside and out; files outside the folder aren't visible to the command. What it writes belongs to you. `dev` and `serve` publish their port on this computer only (`127.0.0.1`). Without `INLAY_DATA_DIR`, `dev` and the database commands keep their data in the site folder, as without Docker; with it, that folder is mounted too. Its settings:

- `INLAY_IMAGE`: the image to run (default `ghcr.io/donstephan/inlaycms`, the newest release you have pulled), such as a version (`ghcr.io/donstephan/inlaycms:0.2.0`) or an image built from this repository with `pnpm run image` (`inlaycms`).
- `INLAY_DOCKER_ARGS`: more `docker run` options, split on spaces. Pass a secret the site declares with `-e CAPTCHA_SECRET`, and reach a server on this computer for `inlaycms push http://localhost:3000` with `--network host`.
- Every other `INLAY_` variable is passed to the command.

`docker pull ghcr.io/donstephan/inlaycms` updates the image to the newest release. The image's default command is `inlaycms serve`, with its data in a volume at `/data` (see [Running a host](#running-a-host)).

### Types in your editor

Without `node_modules`, an editor on your computer can't find Inlay's types. Open the site in a dev container on the image instead (VS Code's Dev Containers, or any editor that reads `.devcontainer/devcontainer.json`): the editor runs inside the image, where `inlaycms` resolves from any folder.

```json
{
  "name": "Inlay site",
  "image": "ghcr.io/donstephan/inlaycms",
  "containerEnv": { "INLAY_DATA_DIR": "" },
  "forwardPorts": [3000]
}
```

In its terminal, run `inlaycms dev` and the other commands directly, without the script. Or install `inlaycms` with npm only for the types and keep using the image to run it.

## Connect your assistant

Editors run the site from an AI assistant such as Claude, through the MCP server at `https://<your-site>/mcp`.

1. **First run.** Open `https://<your-site>/admin`. With no users yet, it sends you to `/admin/setup`, where you create the owner account. On a server without a browser, `inlaycms create-owner --email <email> --name <name>` does the same and reads the password from stdin. If you are locked out of the only owner account, run `inlaycms reset-password --email <email>` on the server to set a new password.
2. **Connect.** Add `https://<your-site>/mcp` to your assistant as a custom connector. In Claude Code, that's `claude mcp add --transport http inlay https://<your-site>/mcp`.
3. **Log in.** The assistant opens the Inlay login page. Sign in with your Inlay account, then allow the assistant on the consent page. The consent page names the assistant and where it will send you back to, so check both before you allow it.

Every change the assistant makes is a draft with a preview link. Nothing goes live until you confirm a publish, either in the assistant or on the confirmation page it links to.

`describe_site` tells the assistant the name of the release the site runs and, per type, how many published pages and entries are missing something the site now requires (a required field a release added after they were published). `list_gaps` lists those pages and entries with each missing field, so the assistant can fill them in and publish again. Content a release hid (types or languages the site no longer has) isn't readable over MCP; `describe_type` on such a type says it is hidden. Releases can't be pushed or activated over MCP.

The manual check against Claude clients is in `docs/mcp-acceptance.md`.

## Admin

The admin lives at `https://<your-site>/admin`. Owners and editors use it to edit pages, entries and site-wide content, preview and publish, look back through history, and manage media and redirects. Owners also manage users, backups and releases there.

When a release adds a required field, published content that leaves it empty stays live as it is, but the admin points it out: the dashboard counts it per type ("Missing information on the live site"), lists mark each page or entry with "Needs attention", and the editor says which fields to fill in before publishing again.

### Releases

Owners find every release on the host under **Releases**: its name, state (live, ready to activate, previously live or deleted), who pushed it and when, and when it was made live. A release's page shows what it would change against the live release (as `inlaycms push` reports it), the secrets it needs, the key it was signed with and its migration functions; the live release's page also lists the content it hides (types, languages, slots and fields the site no longer has, with how many documents hold them). From there an owner can:

- **Upload** a release file, which goes through the same checks as `inlaycms push` (signature, Inlay version, secrets) and is kept as staged. Without the running host (under `inlaycms dev`) the signature and Inlay version are checked on upload, and the secrets when the release is activated. A host with no trusted keys refuses uploads.
- **Preview** a staged release, which opens the preview link in a new tab.
- **Activate** a staged or earlier release, which makes it live the same way `push --activate` does; this is also how you roll back from the admin.
- **Delete** a release that isn't live, which removes its files and stops its preview.

Preview, activation and the part of the diff that looks at your content need the site to run under `inlaycms serve`. Under `inlaycms dev` the screen still lists, compares, uploads and deletes releases in the data folder, and says that activation needs the host. Inside a staged release's preview the admin is read-only, with a banner naming the release.

### Branding

Set `admin` in `defineSite` to put your name, logo and colors on it:

```ts
export const site = defineSite({
  ...,
  admin: {
    name: 'Example Studio',            // shown in the header and the page titles; defaults to "Inlay"
    logo: '/public/logo.svg',          // a URL path under /public/
    theme: 'corporate',                // or custom colors, below
  },
})
```

- **`logo`** is the URL of an image the site serves under `/public/`, shown as an image in the admin's header. The brand name is the logo's alt text.
- **`theme`** is one of daisyUI's built-in theme names (`light`, `dark`, `corporate`, `nord`, `dracula`, `emerald`, `business`, `winter` and the rest), or custom colors laid over a base theme:

  ```ts
  theme: {
    base: 'corporate',   // optional; Inlay's own `inlay` theme by default
    scheme: 'light',     // optional; 'light' or 'dark', for browser controls such as scrollbars
    colors: { primary: '#0b5fff', 'primary-content': '#ffffff' },
  }
  ```

  The color keys are daisyUI's (`base-100`, `base-200`, `base-300`, `base-content`, and `primary`, `secondary`, `accent`, `neutral`, `info`, `success`, `warning` and `error`, each with a `-content` partner). Values are hex (`#0b5fff`) or CSS color functions such as `oklch(…)`. Anything else stops the site at startup.
- **Contrast warnings.** When a text color and its background are both hex values and their contrast is below 4.5:1 (WCAG AA), Inlay logs a warning once at startup. The site still starts. Inlay's default theme passes AA.

### Custom field widgets

Every built-in field brings its own control. A field you define with `defineField` can bring one too, through `admin`: `render` draws the control for one value, and `parse` reads it back from the submitted form.

```tsx
import { defineField, z, type AdminWidget } from 'inlaycms/site'

const colorWidget: AdminWidget = {
  render: ({ id, name, value, describedBy, invalid, readOnly }) => (
    <input
      type="color"
      id={id}
      name={name}
      value={typeof value === 'string' ? value : '#000000'}
      disabled={readOnly}
      aria-describedby={describedBy}
      aria-invalid={invalid ? 'true' : undefined}
      class="input input-bordered w-full"
    />
  ),
  parse: (form, name) => form.get(name),
}

export const color = (opts: { label: string; help?: string }) =>
  defineField(z.string().regex(/^#[0-9a-f]{6}$/i), { kind: 'color', ...opts, admin: colorWidget })
```

- The form supplies the label, the help text and any problems. Give the main control `id`, and pass `describedBy` and `invalid` on so screen readers hear the hints. A widget with several controls sets `fieldset: true`, and the form then wraps it in a `<fieldset>` with the label as its `<legend>`.
- `parse` returns `undefined` when the value is absent. Its `optional` argument says whether the field may be left out.
- The admin's CSS is prebuilt, so use classes the admin already uses (daisyUI's `input`, `select`, `textarea`, `btn` and so on) rather than new Tailwind classes.
- A field without `admin` gets a text box holding its value as JSON.

### JavaScript

Most of the admin is plain forms and works without JavaScript. Choosing images, files and linked pages, and editing formatted text, need it; the admin says so when it is off.

## Backups, export and restore

Inlay keeps two kinds of copy, for different jobs.

- **A backup** is the whole site as it is on disk: the database (users, sessions and API keys too), the media and, on a host, the live release. Use it to recover the same install, for example after a disk failure or a bad deploy.
- **An export** is the content only: documents, their history, redirects and media, in a documented format ([docs/export-format.md](docs/export-format.md)). It has no users or passwords. Use it to move content to another install, or to a newer version of your site code.

### Daily and post-publish backups

Inlay writes a backup once a day and keeps the newest 14. It checks when the site starts and every hour after that, and backs up when the newest daily backup is 24 hours old or older, so restarts never skip or double a day.

On the same hourly check, if something was published or unpublished after the newest backup of any kind, Inlay writes a post-publish backup. So published changes are in a backup within about an hour, and a busy day of publishing makes at most one backup an hour. It keeps the newest 14 of these too.

Only daily and post-publish backups are pruned. Backups made by hand, before a migration, before an import or before a release went live are kept.

On a host, `INLAY_BACKUP_KEEP` sets how many of each kind are kept (default 14). Backups go to `backups/` in the data folder (under `inlaycms dev`, next to the database). Copy them somewhere off the server.

### Backups from the command line

```sh
npx inlaycms backup
npx inlaycms restore-backup <file> [--server-stopped]
```

Stop the server before `restore-backup`. It refuses to run while the database looks in use; if the server crashed and left files behind, add `--server-stopped`.

"Looks in use" means the database's `-wal` or `-shm` file is still there. SQLite removes them only when the last connection closes cleanly, which `inlaycms serve` and `inlaycms dev` do when they get SIGTERM or SIGINT, so `docker stop` leaves nothing behind. A server that was killed does, and then `restore-backup` and `import` think it is still running. On a host, give the data folder with `--data` (`npx inlaycms backup --data /srv/inlay`), or set `INLAY_DATA_DIR`. The database and media you replace are kept next to the originals as `*.before-restore-*`, and the command prints their paths. A bare file name that isn't in the current directory is looked up in the backups folder. The next start applies any pending migrations.

On a host, a backup also holds the release that was live (`release.tgz` and `release.json` in the archive), and `restore-backup` puts it back in `releases/` and makes it the live one again, so a host restored onto a fresh machine serves the site without pushing the release again. The release file must be the one the backup's database recorded, and must suit the running version of Inlay; when `INLAY_TRUSTED_KEYS` (or `INLAY_TRUSTED_KEYS_FILE`) is set, its signature is checked too, and otherwise the command says it wasn't. Releases that weren't live aren't backed up; push them again if you need them. Restoring an older backup without a release leaves the stored releases alone, but none of them is live afterwards: activate one to bring the site back.

### Export and import

```sh
npx inlaycms export [--out <file>]
npx inlaycms import <file> [--dry-run] [--server-stopped]
npx inlaycms check --export <file>
```

`import` always dry-runs first. `--dry-run` and `check --export` print the report and change nothing. A real import first takes a "before restoring content" backup, then replaces the content (documents, history, redirects and media) in one step. Users, sessions and API keys stay as they are. Like `restore-backup`, a real import refuses while the server is running.

The report says what would happen to each content type:

- **compatible**: restored and read against your site code. Values that fit are used and the rest take their defaults.
- **hidden**: your site code doesn't have it. The content is kept and stays hidden.

For each type, the report also counts the documents that will need attention because a required field is empty (gaps). Languages are reported the same way. Problems with the export as a whole refuse the import (exit code 1).

Owners can also export and import from the **Backups & export** screen in the admin. Restoring a backup is command-line only, and none of this is available to assistants over MCP.

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

Tune the shared lifetime with `INLAY_CDN_MAX_AGE` (seconds, default 15) and `INLAY_CDN_STALE_IF_ERROR` (seconds, default 86400). `INLAY_CDN_MAX_AGE=0` makes shared caches revalidate on every request, which still saves bandwidth through the 304s. Preview pages are never cached (`no-store`), so a draft cannot reach a shared cache. Published pages are marked `Vary: Cookie`; if your CDN ignores that header for HTML, add a rule to bypass its cache when the `inlay_preview` cookie is present, or editors with a preview cookie may be served the cached public page.

## Redirects

Redirects that belong to the site go in its code, so they ship with each release:

```ts
export const site = defineSite({
  ...,
  redirects: [
    { from: '/about-us', to: '/about' },
    { from: '/blog/:slug', to: '/:slug' },
    { from: '/g2', to: 'https://www.g2.com/products/realciso/reviews' },
    { from: '/old-landing', to: '/', status: 302 },
  ],
})
```

`from` is a path or a pattern with `:name` segments, `to` is a site path (with those names filled in) or an `https://` address, and `status` is `301` (the default) or `302`.

- A published page at a rule's `from` wins over the rule, and so does a code route. An admin redirect with the same `from` overrides a code rule, and deleting it brings the code rule back. A delete that would leave visitors going round in a loop is refused, as a new redirect that would loop is. The admin's Redirects screen and the `list_redirects` tool show code rules read-only.
- Rules ship with each release, so they follow activation and rollback: a rule is live only while its release is.
- `inlaycms check` warns about rules that loop, and about rules that never fire because published pages answer at their `from` (in every language the rule applies in), without failing.
- A redirect to an `https://` address, whether it comes from code, the admin, a CSV import or the MCP tools, doesn't pass the visitor's query string on. Redirects within the site still do.
- Paths are case-sensitive. The one exception: a path with an uppercase letter that would otherwise be a 404 is redirected when something answers at its lowercase form. A page or a code route there gets a 301 to the lowercase path. A redirect rule there sends the visitor straight to the rule's target with the rule's own status, so a `302` rule stays a 302. That doesn't apply to reserved paths (`/admin`, `/media`, `/public` and the like) or to paths whose last segment contains a `.`.

## Security headers

Every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and `Content-Security-Policy: frame-ancestors 'self'` (only the site itself may frame its pages). When the site's base URL is `https://`, responses also carry `Strict-Transport-Security: max-age=31536000`, so browsers keep to https for a year. The admin sends its own stricter policy, and a response that sets one of these headers itself keeps its own.

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

A CSP set here replaces the default one, so include `frame-ancestors` in it. If your reverse proxy already sends HSTS, set `'Strict-Transport-Security': false` so browsers don't get it twice.

## Site password

An owner can lock the whole public site behind one shared password from the admin's **Security** page, for a site that isn't launched yet or a staging copy. While the lock is on, every public request gets a neutral password screen instead: pages, media, the sitemap and the site's own routes. After the right password the visitor returns to the page they asked for, and stays unlocked in that browser for 30 days, or until an owner changes the password. People signed in to the admin and people opening a preview link skip the screen. `robots.txt` answers `Disallow: /` while the site is locked.

These stay reachable without the password: the admin (`/admin`), sign-in (`/api/auth`), MCP (`/mcp` and `/.well-known/*`), the site's files under `/public/`, and Inlay's own `/_inlay/*` paths. To keep one of the site's own routes open, such as a load balancer's health check, list its path in the site's `publicPaths`. Entries are exact paths, so `/healthz` doesn't open `/healthz/x`:

```ts
export const site = defineSite({
  ...,
  routes: [defineRoute({ method: 'GET', path: '/healthz', handler: async () => ({ body: 'ok' }) })],
  publicPaths: ['/healthz'],
})
```

While the lock is on, every response carries `X-Robots-Tag: noindex`, and what unlocked visitors get is sent as `Cache-Control: private` instead of `public`, so CDNs and proxies don't store it. The password screen itself is `no-store`. With the lock off, responses are exactly as described above.

A CDN keeps whatever it cached while the site was public until it's purged, and Inlay can't purge it. Turn the lock on before the site is ever public, or purge the CDN after locking a site that was public.

## Working on Inlay

The repo uses pnpm, not npm.

- `pnpm test` runs the tests and `pnpm run typecheck` checks the types. `pnpm run build` builds the package into `dist/`.
- `pnpm run dev` runs the example site in `example/` through `inlaycms dev` at `http://localhost:3000`, with its data in `example/data/`: it restarts the site when a file in `example/` changes and rebuilds the admin's assets when `client/admin/` changes. A change to Inlay's own code in `src/` restarts `inlaycms dev` itself. Reload the page to see a change. `docker compose up dev` does the same in a container. It joins the external `inlay-dev` network, which you create once with `docker network create inlay-dev`.
- The admin's CSS and JavaScript are built from `client/admin/` into `assets/admin/`, which ships in the package. `pnpm run build:admin` builds them once. `pnpm run build` runs it first, and `pnpm test` runs it when the files are missing.
- `pnpm run example:pack` packs the example site into `example/data/release.tgz`, signed with the development key in `example/keys/`.
- `docker compose run --rm pack-test` packs Inlay, installs the tarball into a fresh copy of `example/`, packs the example into a release, activates it offline into a fresh data folder, runs `inlaycms serve` on it, pushes a second release to the running host and rolls back, and checks the site, admin, MCP and every CLI command. Run it before a release.

### Trying the deploy path locally

`docker compose run --rm pack-test` is the deploy path end to end: it makes the first release and an owner offline, mints a push key with `inlaycms create-token --push`, starts `inlaycms serve`, pushes a second release with `inlaycms push --activate`, checks the diff and the site, confirms that a `--dry-run` push changes nothing, and rolls back with `inlaycms activate <host> <id>`. To try it by hand, run `docker compose up serve` (see [Running a host](#running-a-host)), create a push key in the same container, and push to `http://localhost:3000`.

The manual checks in a real browser and against Claude clients are in `docs/admin-acceptance.md` and `docs/mcp-acceptance.md`.

## License

MIT. See [LICENSE](LICENSE).
