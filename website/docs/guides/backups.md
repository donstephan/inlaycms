---
title: Backups, export and restore
---

# Backups, export and restore

How a site's data is kept safe and moved: automatic backups, the backup and restore commands, and content export and import. Read this when you run a host.

Inlay keeps two kinds of copy, for different jobs.

- **A backup** is the whole site as it is on disk: the database (users, sessions and API keys too), the media and, on a host, the live release. Use it to recover the same install, for example after a disk failure or a bad deploy.
- **An export** is the content only: documents, their history, redirects and media, in a documented format ([docs/export-format.md](https://github.com/donstephan/inlaycms/blob/main/docs/export-format.md)). It has no users or passwords. Use it to move content to another install, or to a newer version of your site code.

## Daily and post-publish backups

Inlay writes a backup once a day and keeps the newest 14. It checks when the site starts and every hour after that, and backs up when the newest daily backup is 24 hours old or older, so restarts never skip or double a day.

On the same hourly check, if something was published or unpublished after the newest backup of any kind, Inlay writes a post-publish backup. So published changes are in a backup within about an hour, and a busy day of publishing makes at most one backup an hour. It keeps the newest 14 of these too.

Only daily and post-publish backups are pruned. Backups made by hand, before a migration, before an import or before a release went live are kept.

On a host, `INLAY_BACKUP_KEEP` sets how many of each kind are kept (default 14). Backups go to `backups/` in the data folder (under `inlaycms dev`, next to the database). Copy them somewhere off the server.

## Backups from the command line

```sh
npx inlaycms backup
npx inlaycms restore-backup <file> [--server-stopped]
```

Stop the server before `restore-backup`. It refuses to run while the database looks in use; if the server crashed and left files behind, add `--server-stopped`.

"Looks in use" means the database's `-wal` or `-shm` file is still there. SQLite removes them only when the last connection closes cleanly, which `inlaycms serve` and `inlaycms dev` do when they get SIGTERM or SIGINT, so `docker stop` leaves nothing behind. A server that was killed does, and then `restore-backup` and `import` think it is still running. On a host, give the data folder with `--data` (`npx inlaycms backup --data /srv/inlay`), or set `INLAY_DATA_DIR`. The database and media you replace are kept next to the originals as `*.before-restore-*`, and the command prints their paths. A bare file name that isn't in the current directory is looked up in the backups folder. The next start applies any pending migrations.

On a host, a backup also holds the release that was live (`release.tgz` and `release.json` in the archive), and `restore-backup` puts it back in `releases/` and makes it the live one again, so a host restored onto a fresh machine serves the site without pushing the release again. The release file must be the one the backup's database recorded, and must suit the running version of Inlay; when `INLAY_TRUSTED_KEYS` (or `INLAY_TRUSTED_KEYS_FILE`) is set, its signature is checked too, and otherwise the command says it wasn't. Releases that weren't live aren't backed up; push them again if you need them. Restoring an older backup without a release leaves the stored releases alone, but none of them is live afterwards: activate one to bring the site back.

## Export and import

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

