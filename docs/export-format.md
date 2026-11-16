# Inlay export format

An Inlay export is a gzipped tar archive (`inlay-export-<stamp>.tar.gz`) holding all of a site's content. You can read it without Inlay: it is plain JSON and the original media files.

## Layout

The files sit at the top level of the archive, with no wrapping folder. An importer also accepts names written as `./manifest.json` and so on, as `tar -C <dir> .` writes them.

| Entry | Contents |
| --- | --- |
| `manifest.json` | Describes the export and the content types (2-space JSON). |
| `content.ndjson` | One JSON record per line: documents, then revisions, then publish events. |
| `redirects.json` | A JSON array of redirects. |
| `media.json` | A JSON object `{ "files": [...], "deletions": [...] }`. |
| `media/<sha256>` | One entry per item in `media.json` `files`, named by the SHA-256 (lowercase hex) of the file's bytes. |

## Ordering

- `content.ndjson`: every `document` line (by `createdAt`, then `id`), then every `revision` line (by `id`), then every `publishEvent` line (by `id`).
- `redirects.json`: by `id`.
- `media.json`: `files` by `createdAt`, then `id`; `deletions` in the order they were recorded.

## Ids

Ids are stable and are written exactly as the site stored them.

- Document `id` and `groupId` are strings. `groupId` is shared by all translations of one entry.
- Revision and publish-event `id` are integers. A document's `headRevision` and `publishedRevision` refer to revision ids.
- Media `id` is the SHA-256 of the file's bytes, and is also the file name under `media/`. Content refers to media as `{ "media": "<id>" }`.
- A redirect's `to.group` is a document `groupId`.

An importer refuses an export as damaged when ids clash: two documents, revisions, publish events, redirects or media files with the same `id`, two documents with the same `groupId` and `locale`, or two redirects with the same `from`. It also refuses a document whose `kind` doesn't match its type in the manifest (`collection` types hold `entry` documents, `singleton` types `singleton` ones, `global` types `global` ones).

## manifest.json

| Field | Type | Meaning |
| --- | --- | --- |
| `format` | `"inlay-export"` | Always this value. |
| `formatVersion` | integer | Currently `1`. |
| `inlayVersion` | string | The Inlay version that wrote the export. |
| `exportedAt` | string | ISO 8601 time of the export. |
| `locales` | string[] | The site's locales. |
| `defaultLocale` | string | The default locale. |
| `types` | array | One entry per current content type (below). |
| `siteLock` | object, optional | The site lock: `enabled` (boolean) and `passwordHash` (better-auth's scrypt hash string of the site password, or null when there is none). Absent in exports made before the lock existed; importing such an export leaves the receiving site's lock alone. Otherwise an import replaces the lock and password with these. |
| `counts` | object | `documents`, `revisions`, `publishEvents`, `media` (number of `files`) and `redirects`. |

Each `types` entry has:

- `name`: the type name.
- `kind`: `singleton`, `collection` or `global`.
- `label`: the name shown to editors.
- `template`: the template's name.
- `schema`: a JSON Schema (draft 2020-12) of a revision's `data` as it is stored. Field labels are in `title`, help text in `description`, and slot labels in `title`.

## content.ndjson records

Each line has a `record` field naming its kind.

### `document`

| Field | Type | Meaning |
| --- | --- | --- |
| `record` | `"document"` | |
| `id` | string | Document id. |
| `kind` | `singleton`, `entry` or `global` | |
| `type` | string | Content type name. |
| `groupId` | string | Translation group. |
| `locale` | string | |
| `headRevision` | integer or null | The latest saved revision (the draft). |
| `publishedRevision` | integer or null | The live revision; null if not published. |
| `deletedAt` | string or null | When the entry was deleted; null if it is not deleted. Deleted entries are included. |
| `createdAt` | string | ISO 8601. |
| `key` | string or null | The stable key of shipped content (a singleton's or global's type name); null for entries the client created. A translation the client added to a shipped document carries its group's key. Exports that predate it read as null. |
| `edition` | integer or null | The edition of the shipped content this document was last set from; null if never set from shipped content. Exports that predate it read as null. |

### `revision`

| Field | Type | Meaning |
| --- | --- | --- |
| `record` | `"revision"` | |
| `id` | integer | Revision id. |
| `documentId` | string | The document it belongs to. |
| `data` | object | The content: optional `slug` and `path`, `fields`, and `slots` (each `{ "enabled": bool, "data": {...} }`). |
| `authorId` | string or null | The author's user id. Users are not exported, so it may match nobody. |
| `authorName` | string | The author's name when the revision was saved. |
| `source` | string | `admin`, `mcp`, `restore`, `import`, `release` or `system`. |
| `message` | string or null | The save message. |
| `createdAt` | string | ISO 8601. |
| `releaseId` | string or null | The release this revision came from, if any. Exports that predate it read as null. |

A document's page address comes from its revision `data`: `data.slug` and `data.path` (either may be absent). The export has no separate slug or path columns.

### `publishEvent`

| Field | Type | Meaning |
| --- | --- | --- |
| `record` | `"publishEvent"` | |
| `id` | integer | |
| `at` | string | ISO 8601. |
| `userId` | string or null | |
| `userName` | string | |
| `source` | string | As for revisions. |
| `message` | string or null | |
| `items` | array | `{ "documentId": string, "revisionId": integer or null, "action": "publish" or "unpublish" }`. |

## redirects.json

Each item: `id` (integer), `from` (a site path, which may use `:name` segments), `to` (`{ "path": string }` or `{ "group": string }`), `status` (`301` or `302`), `source` (`manual`, `auto` or `import`), `note` (string or null), `createdById` (string or null), `createdBy` (name), `createdAt`.

`from` and `to.path` follow the rules for creating a redirect. Both are clean site paths: they start with `/`, have no query, fragment, `//`, `.` or `..` segments, and don't start with the manifest's `defaultLocale`. `from` is also not under a reserved path (`/admin`, `/media` and so on) and uses each `:name` once. Every `:name` in `to.path` must appear in `from`.

## media.json

`files` items: `id` (SHA-256), `filename`, `mime`, `size` (bytes), `width` and `height` (integers or null), `defaultAlt` (string or null), `createdById` (string or null), `createdBy` (name), `createdAt`. Each has its bytes at `media/<id>`.

`deletions` items describe media that has been deleted, or whose file was missing when the export was made: `mediaId`, `filename`, `deletedAt`, `deletedById` (string or null) and `deletedBy` (name). Content may still refer to these ids; they have no file in the archive.

## What is not exported

Users, sessions, API keys, OAuth clients and account passwords are not exported. The one password-related value that is exported is the hash of the site password (`manifest.siteLock`), so an import can bring the lock along; the password itself never is. Author and user ids are kept, and the names recorded with each revision, publish event and media file are kept, so history still reads correctly. Derived data (search and reference indexes) is not exported; it is rebuilt on import.

## Format versions

`formatVersion` is `1`. A reader must refuse an archive whose `formatVersion` is higher than it understands. New optional fields can be added without changing the version, so readers should ignore fields they do not know.

Content from any export can be restored into the current site: it is read against the current site's code (values that fit are used, the rest take defaults), and the dry run reports the documents left with empty required fields (gaps).

## Example: list published page titles without Inlay

Extract the archive, then use `jq` to join documents to their published revisions:

```sh
mkdir export && tar -xzf inlay-export-*.tar.gz -C export
jq -rs '
  (map(select(.record == "revision")) | map({key: (.id | tostring), value: .}) | from_entries) as $rev
  | .[]
  | select(.record == "document" and .publishedRevision != null and .deletedAt == null)
  | [.type, .locale, ($rev[(.publishedRevision | tostring)].data.fields.title // "(no title)")]
  | @tsv
' export/content.ndjson
```
