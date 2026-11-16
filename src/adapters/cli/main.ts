import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { sql, type Kysely } from 'kysely'
import { bootInlay, isFresh } from '../../core/boot.js'
import { systemCtx } from '../../core/auth/roles.js'
import { createBackup } from '../../core/backup/backup.js'
import { databaseInUse, restoreBackup } from '../../core/backup/restore.js'
import { checkBundle, checkDatabase, checkWithoutDatabase } from '../../core/check.js'
import { openDatabase } from '../../core/db/connection.js'
import { migrateSystem, pendingSystemMigrations } from '../../core/db/migrate.js'
import type { Database } from '../../core/db/schema.js'
import { createCore } from '../../core/core.js'
import { dryRunImport } from '../../core/export/import.js'
import { exportFileName } from '../../core/export/format.js'
import { formatImportReport, type ImportReport } from '../../core/export/report.js'
import { InlayError } from '../../core/errors.js'
import { t, type MessageId } from '../../core/messages/index.js'
import { formatReport } from '../../core/report.js'
import type { SiteDefinition } from '../../core/registry/define.js'
import { buildRegistry } from '../../core/registry/registry.js'
import { generateKeyPair, publicKeyOf } from '../../core/release/keys.js'
import { packRelease, releaseName } from '../../core/release/pack.js'
import { loadRelease } from '../../core/release/read.js'
import { loadConfig, type InlayConfig } from '../../config.js'
import { activateRelease } from '../../host/activate.js'
import { EMPTY_SITE } from '../../host/app.js'
import { ensureDataDir, hostPaths, readDataDir, readHostConfig, readTrustedKeys, type HostConfig } from '../../host/config.js'
import { dev } from '../../host/dev.js'
import { formatDiff } from '../../host/diff.js'
import type { ActivationSummary } from '../../host/ipc.js'
import { serve } from '../../host/serve.js'
import { currentRelease, getRelease, listReleases, releaseDir, storeRelease, type ReleaseRow } from '../../host/store.js'
import { activateRemote, checkTransport, isRemote, listRemoteReleases, pushFile } from './remote.js'

export interface CliIo {
  cwd: string
  out(line: string): void
  err(line: string): void
  readSecret?(prompt: string): Promise<string>
}

function usage(io: CliIo): number {
  for (const line of t('cli.usage').split('\n')) io.err(line)
  return 2
}

function findConfig(io: CliIo, explicit: string | undefined): string {
  if (explicit) return resolve(io.cwd, explicit)
  for (const name of ['inlay.config.ts', 'inlay.config.js', 'inlay.config.mjs']) {
    const candidate = join(io.cwd, name)
    if (existsSync(candidate)) return candidate
  }
  throw new InlayError('not_found', 'error.configMissing', { path: join(io.cwd, 'inlay.config.ts') })
}

/** Config and database errors exit 2; exit 1 is reserved for a check that found problems. */
function fail(io: CliIo, e: unknown, id: MessageId, path: string): number {
  if (e instanceof InlayError) io.err(e.message)
  else io.err(t(id, { path, error: e instanceof Error ? e.message : String(e) }))
  return 2
}

async function keygen(io: CliIo, outDir: string | undefined, name: string): Promise<number> {
  const dir = resolve(io.cwd, outDir ?? '.')
  const keyFile = join(dir, `${name}.key`)
  const pubFile = join(dir, `${name}.pub`)
  for (const path of [keyFile, pubFile]) {
    if (existsSync(path)) {
      io.err(t('cli.keygenExists', { path }))
      return 2
    }
  }
  const { privateKey, publicKey } = generateKeyPair()
  await mkdir(dir, { recursive: true })
  try {
    await writeFile(keyFile, privateKey, { mode: 0o600, flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      io.err(t('cli.keygenExists', { path: keyFile }))
      return 2
    }
    throw e
  }
  try {
    await writeFile(pubFile, publicKey + '\n', { flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      io.err(t('cli.keygenExists', { path: pubFile }))
      return 2
    }
    throw e
  }
  for (const line of t('cli.keygenDone', { key: keyFile, pub: pubFile, publicKey }).split('\n')) io.out(line)
  return 0
}

/**
 * Where a command finds the site's files and the site it works with. On a host (`--data` or INLAY_DATA_DIR) they
 * are all in the data folder, the site is the current release's, and content is left alone at boot.
 */
interface Target {
  db: string
  backups: string
  media?: string
  releases?: string
  site: SiteDefinition
  content?: 'none'
}

async function createOwner(io: CliIo, target: Target, email: string, name: string): Promise<number> {
  if (!io.readSecret) {
    io.err(t('cli.noSecretInput'))
    return 2
  }
  const password = await io.readSecret(t('cli.passwordPrompt'))
  const { db, auth } = await bootInlay({
    site: target.site,
    db: target.db,
    backups: target.backups,
    ...(target.media !== undefined && { media: target.media }),
    ...(target.content && { content: target.content }),
    auth: { secret: randomBytes(32).toString('hex'), baseUrl: 'http://localhost' },
  })
  try {
    await auth.createOwner({ email, name, password })
    io.out(t('cli.ownerCreated', { email }))
    return 0
  } catch (e) {
    if (e instanceof InlayError && (e.code === 'validation' || e.code === 'invalid_operation')) {
      io.err(e.message)
      const issues = (e.details as { issues?: { message: string }[] }).issues ?? []
      for (const issue of issues) io.err(issue.message)
      return 1
    }
    throw e
  } finally {
    await db.destroy()
  }
}

function printImportReport(io: CliIo, report: ImportReport, json: boolean | undefined): number {
  if (json) io.out(JSON.stringify(report, null, 2))
  else for (const line of formatImportReport(report)) io.out(line)
  return report.ok ? 0 : 1
}

async function importFile(io: CliIo, target: Target, file: string, flags: { serverStopped: boolean }): Promise<number> {
  const dbPath = target.db
  if (!existsSync(dbPath)) throw new InlayError('not_found', 'error.noDatabase', { path: dbPath })
  if (!flags.serverStopped && (await databaseInUse(dbPath))) {
    throw new InlayError('invalid_operation', 'error.databaseInUse', { path: dbPath })
  }
  const { db, core } = await bootInlay({
    site: target.site,
    db: dbPath,
    backups: target.backups,
    ...(target.media !== undefined && { media: target.media }),
    ...(target.content && { content: target.content }),
  })
  try {
    const result = await core.importContent(file, systemCtx('import'))
    for (const line of formatImportReport(result.report)) io.out(line)
    io.out(t('cli.imported', { file, backup: result.backup.path }))
    return 0
  } catch (e) {
    if (e instanceof InlayError && e.code === 'check_failed' && e.details.importReport) {
      for (const line of formatImportReport(e.details.importReport)) io.out(line)
      io.err(e.message)
      return 1
    }
    throw e
  } finally {
    await db.destroy()
  }
}

/** The private key in PEM form: `--key` names a file; `INLAY_SIGNING_KEY` holds the key itself or a path to it. */
async function signingKey(io: CliIo, flag: string | undefined): Promise<string | number> {
  const env = process.env.INLAY_SIGNING_KEY?.trim()
  if (!flag && !env) {
    io.err(t('cli.packKey'))
    return 2
  }
  const path = flag ? resolve(io.cwd, flag) : env!.includes('PRIVATE KEY') ? null : resolve(io.cwd, env!)
  try {
    const pem = path === null ? env! : await readFile(path, 'utf8')
    publicKeyOf(pem)
    return pem
  } catch (e) {
    io.err(t('cli.packKeyUnreadable', { path: path ?? 'INLAY_SIGNING_KEY', error: e instanceof Error ? e.message : String(e) }))
    return 2
  }
}

/**
 * The JS file of the site's own `tsc`: the `typescript` package Node finds from `dir`, by its `bin` entry. Run with
 * this Node rather than as `node_modules/.bin/tsc`, which is a symlink, a shell script or a `.cmd` file depending on
 * the package manager and the system, and needs `/usr/bin/env node` to start.
 */
function findTsc(dir: string): string | null {
  try {
    const pkg = createRequire(join(dir, 'inlay.config.js')).resolve('typescript/package.json')
    const { bin } = JSON.parse(readFileSync(pkg, 'utf8')) as { bin?: string | Record<string, string> }
    const tsc = typeof bin === 'string' ? bin : bin?.tsc
    return tsc === undefined ? null : join(dirname(pkg), tsc)
  } catch {
    return null
  }
}

/**
 * Type-checks the site in `dir` (unless `typecheck` is false or it has no tsconfig.json) and packs it into a release
 * file at `out`. Answers the exit code when that failed, having said why.
 */
async function packTo(
  io: CliIo,
  file: string,
  dir: string,
  values: { privateKey: string; out: string; name: string; typecheck: boolean },
): Promise<number | { files: number }> {
  const tsc = values.typecheck && existsSync(join(dir, 'tsconfig.json')) ? findTsc(dir) : null
  if (tsc !== null) {
    try {
      await promisify(execFile)(process.execPath, [tsc, '--noEmit', '-p', dir], { cwd: dir })
    } catch (e) {
      const { stdout, stderr } = e as { stdout?: string; stderr?: string }
      for (const line of `${stdout ?? ''}${stderr ?? ''}`.split('\n')) if (line.trim() !== '') io.err(line)
      io.err(t('cli.packTypecheck'))
      return 1
    }
  }
  try {
    const { manifest } = await packRelease({ configFile: file, privateKey: values.privateKey, out: values.out, name: values.name })
    return { files: Object.keys(manifest.files).length }
  } catch (e) {
    if (e instanceof InlayError && e.code === 'release') {
      io.err(e.message)
      return 1
    }
    return fail(io, e, 'cli.configFailed', file)
  }
}

async function pack(
  io: CliIo,
  file: string,
  dir: string,
  values: { key?: string; out?: string; name?: string; typecheck: boolean },
): Promise<number> {
  const privateKey = await signingKey(io, values.key)
  if (typeof privateKey === 'number') return privateKey
  const name = values.name ?? (await releaseName(dir, new Date()))
  const out = values.out ? resolve(io.cwd, values.out) : join(io.cwd, `${name}.tgz`)
  const packed = await packTo(io, file, dir, { privateKey, out, name, typecheck: values.typecheck })
  if (typeof packed === 'number') return packed
  io.out(t('cli.packDone', { out, name, files: packed.files }))
  return 0
}

/** The host's settings for `activate` and `releases`: the `INLAY_` variables, with `--data` for INLAY_DATA_DIR. */
function hostConfig(io: CliIo, data: string | undefined, needKeys: boolean): HostConfig {
  const env = data === undefined ? process.env : { ...process.env, INLAY_DATA_DIR: resolve(io.cwd, data) }
  return readHostConfig(env, { needKeys })
}

/**
 * Makes a release live without the server (Review Focus 5: refused while the database is open, since a running
 * worker wouldn't see the swap). A file is stored first; anything else names a stored release by its ID.
 */
async function activate(
  io: CliIo,
  arg: string,
  flags: { data: string | undefined; name: string | undefined; serverStopped: boolean },
): Promise<number> {
  const config = hostConfig(io, flags.data, true)
  const { paths } = config
  if (!flags.serverStopped && (await databaseInUse(paths.db))) {
    io.err(t('cli.serverRunning', { path: paths.db }))
    return 2
  }
  await ensureDataDir(config)
  const db = openDatabase(paths.db)
  try {
    const systemMigrations = await pendingSystemMigrations(db)
    // As boot does: a database that is updated first gets a backup first.
    if (systemMigrations.length > 0 && !(await isFresh(db))) {
      const backup = await createBackup({
        db,
        backups: paths.backups,
        media: paths.media,
        reason: 'pre-migration',
        ctx: systemCtx('system'),
      })
      io.out(t('cli.backupCreated', { path: backup.path }))
    }
    await migrateSystem(db)
    const file = resolve(io.cwd, arg)
    let id: string
    if (await stat(file).then((s) => s.isFile(), () => false)) {
      const stored = await storeRelease(
        { db, releasesDir: paths.releases, trustedKeys: config.trustedKeys, now: () => new Date() },
        file,
        { pushedBy: null, ...(flags.name !== undefined && { name: flags.name }) },
      )
      io.out(t('cli.activateStored', { name: stored.name, id: stored.id }))
      id = stored.id
    } else {
      if (flags.name !== undefined) {
        io.err(t('cli.activateName'))
        return 2
      }
      const row = await getRelease(db, arg)
      if (row === null) {
        io.err(t('cli.activateNotFound', { path: file, id: arg }))
        return 2
      }
      // Its folder is gone, so say so before trying to load it.
      if (row.state === 'deleted') throw new InlayError('release', 'error.releaseDeleted', { name: row.name })
      id = row.id
    }
    const result = await activateRelease(
      {
        db,
        loaded: await loadRelease(releaseDir(paths.releases, id)),
        releasesDir: paths.releases,
        backupsDir: paths.backups,
        mediaDir: paths.media,
        secretsEnv: config.secrets,
        now: () => new Date(),
      },
      id,
    )
    if (result.pointerError !== null) io.err(t('host.pointerWriteFailed', { name: result.release.name, problem: result.pointerError }))
    if (result.noop) {
      io.out(t('cli.activateNoop', { name: result.release.name }))
      return 0
    }
    if (result.backup) io.out(t('cli.activateBackup', { path: result.backup.path }))
    for (const line of formatReport({ ok: true, systemMigrations, shipped: result.shipped, problems: [], warnings: [] })) {
      io.out(line)
    }
    if (result.migrations.length > 0) io.out(t('cli.activateMigrations', { names: result.migrations.join(', ') }))
    io.out(t('cli.activated', { name: result.release.name }))
    return 0
  } finally {
    await db.destroy()
  }
}

async function hasReleasesTable(db: Kysely<Database>): Promise<boolean> {
  const { rows } = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'releases'`.execute(db)
  return rows.length > 0
}

/** The data folder of a host: `--data`, or INLAY_DATA_DIR. */
function dataDir(io: CliIo, data: string | undefined): string {
  return resolve(io.cwd, data ?? readDataDir(process.env))
}

/**
 * Lists the releases on the host, newest first. Only reads, so it works with the server running, and needs only
 * the data folder.
 */
async function releases(io: CliIo, flags: { data: string | undefined; json: boolean }): Promise<number> {
  const paths = hostPaths(dataDir(io, flags.data))
  let rows: Awaited<ReturnType<typeof listReleases>> = []
  if (existsSync(paths.db)) {
    // Not read-only: a read-only connection can't remove the write-ahead log when it closes, and the database would
    // then look in use to `activate`. It only reads, and leaves the log alone while the server has it open.
    const db = openDatabase(paths.db)
    try {
      if (await hasReleasesTable(db)) rows = await listReleases(db)
    } finally {
      await db.destroy()
    }
  }
  printReleases(io, rows, flags.json)
  return 0
}

function printReleases(io: CliIo, rows: readonly Omit<ReleaseRow, 'schema'>[], json: boolean): void {
  const listed = rows.map((r) => ({ id: r.id, name: r.name, state: r.state, pushedAt: r.pushed_at, activatedAt: r.activated_at }))
  if (json) return io.out(JSON.stringify(listed, null, 2))
  if (listed.length === 0) io.out(t('cli.releasesNone'))
  for (const r of listed) {
    io.out(
      t('cli.releaseLine', {
        id: r.id,
        name: r.name,
        state: t(`cli.releaseState.${r.state}`),
        pushedAt: r.pushedAt,
        activatedAt: r.activatedAt ?? t('cli.releaseNeverLive'),
      }),
    )
  }
}

/** The push token: `--token`, or INLAY_PUSH_TOKEN. Answers exit code 2, having said so, when there is neither. */
function pushToken(io: CliIo, flag: string | undefined): string | number {
  const token = (flag ?? process.env.INLAY_PUSH_TOKEN ?? '').trim()
  if (token !== '') return token
  io.err(t('cli.pushToken'))
  return 2
}

/** What making a release live on the server did, as the offline `activate` says it. */
function printActivation(io: CliIo, name: string, a: ActivationSummary): void {
  if (a.noop) return io.out(t('cli.activateNoop', { name }))
  if (a.backup !== null) io.out(t('cli.activateBackup', { path: a.backup }))
  if (a.shipped.created > 0) io.out(t('report.shippedCreated', { count: a.shipped.created }))
  if (a.shipped.replaced > 0) io.out(t('report.shippedReplaced', { count: a.shipped.replaced }))
  if (a.shipped.skipped > 0) io.out(t('report.shippedSkipped', { count: a.shipped.skipped }))
  if (a.warnings > 0) io.out(t('cli.activationWarnings', { count: a.warnings }))
  if (a.migrations.length > 0) io.out(t('cli.activateMigrations', { names: a.migrations.join(', ') }))
  io.out(t('cli.activated', { name }))
}

/**
 * A server that refused, or couldn't be reached, exits 1 with its message (2 for a usage problem, such as plain http);
 * anything else exits 1 with `error.remoteUnexpected`, never a stack trace.
 */
function remoteFailed(io: CliIo, host: string, e: unknown): number {
  if (e instanceof InlayError) {
    io.err(e.message)
    return e.code === 'config' ? 2 : 1
  }
  io.err(t('error.remoteUnexpected', { host, problem: e instanceof Error ? e.message : String(e) }))
  return 1
}

type PushValues = {
  file?: string | undefined
  activate?: boolean | undefined
  'dry-run'?: boolean | undefined
  name?: string | undefined
  token?: string | undefined
  key?: string | undefined
  'no-typecheck'?: boolean | undefined
  config?: string | undefined
  insecure?: boolean | undefined
}

/**
 * `inlaycms push <host>`: packs the site into a temporary file (unless `--file` names a release file), sends it to the
 * server and prints what it changes; with `--activate` the server then makes it live. Exits 1 when the server
 * refused, 2 for a missing token, key or file.
 */
async function push(io: CliIo, host: string, values: PushValues): Promise<number> {
  const token = pushToken(io, values.token)
  if (typeof token === 'number') return token
  let tmp: string | null = null
  try {
    let file: string
    if (values.file !== undefined) {
      file = resolve(io.cwd, values.file)
      if (!(await stat(file).then((s) => s.isFile(), () => false))) {
        io.err(t('cli.pushFile', { path: file }))
        return 2
      }
    } else {
      const privateKey = await signingKey(io, values.key)
      if (typeof privateKey === 'number') return privateKey
      let configFile = ''
      let dir: string
      try {
        configFile = findConfig(io, values.config)
        ;({ file: configFile, dir } = await loadConfig(configFile))
      } catch (e) {
        return fail(io, e, 'cli.configFailed', configFile)
      }
      tmp = await mkdtemp(join(tmpdir(), 'inlay-push-'))
      const name = values.name ?? (await releaseName(dir, new Date()))
      file = join(tmp, 'release.tgz')
      const packed = await packTo(io, configFile, dir, { privateKey, out: file, name, typecheck: values['no-typecheck'] !== true })
      if (typeof packed === 'number') return packed
      io.out(t('cli.pushPacked', { name, files: packed.files }))
    }

    const answer = await pushFile(host, token, file, {
      activate: values.activate === true,
      dryRun: values['dry-run'] === true,
      insecure: values.insecure === true,
      ...(values.name !== undefined && { name: values.name }),
    })
    const { release } = answer
    if (release === null) io.out(t('cli.pushDryRun'))
    else io.out(t(values.activate ? 'cli.activateStored' : 'cli.pushStaged', { name: release.name, id: release.id }))
    io.out(t('cli.pushChanges'))
    for (const line of formatDiff(answer.diff)) io.out(`  ${line}`)
    for (const warning of answer.warnings) io.out(t('diff.release.warning', { message: warning }))
    if (answer.previewUrl !== null) io.out(t('cli.pushPreview', { url: answer.previewUrl }))
    if (answer.failed !== null) {
      io.err(answer.failed)
      return 1
    }
    if (release !== null && answer.activation !== null) printActivation(io, release.name, answer.activation)
    else if (release !== null) io.out(t('cli.pushActivateHint', { host, id: release.id }))
    return 0
  } catch (e) {
    return remoteFailed(io, host, e)
  } finally {
    if (tmp !== null) await rm(tmp, { recursive: true, force: true })
  }
}

/** `inlaycms activate <host> <id>`: makes a release on the server live, also to roll back to an earlier one. */
async function activateOnHost(io: CliIo, host: string, id: string, flags: { token: string | undefined; insecure: boolean }): Promise<number> {
  const token = pushToken(io, flags.token)
  if (typeof token === 'number') return token
  try {
    const { release, activation } = await activateRemote(host, token, id, { insecure: flags.insecure })
    printActivation(io, release.name, activation)
    return 0
  } catch (e) {
    return remoteFailed(io, host, e)
  }
}

/** `inlaycms releases <host>`: the releases on the server, newest first. */
async function releasesOnHost(
  io: CliIo,
  host: string,
  flags: { token: string | undefined; json: boolean; insecure: boolean },
): Promise<number> {
  const token = pushToken(io, flags.token)
  if (typeof token === 'number') return token
  try {
    printReleases(io, (await listRemoteReleases(host, token, { insecure: flags.insecure })).releases, flags.json)
    return 0
  } catch (e) {
    return remoteFailed(io, host, e)
  }
}

/**
 * Makes an API key for the user with `email` and prints it, the only time it is shown: alone on standard output,
 * so a script can capture it, with what it is on standard error. With `push`, a push token, which only an owner
 * may have. Only inserts the key, so it works with the server running or stopped.
 */
async function createToken(io: CliIo, target: Target, flags: { email: string; name: string; push: boolean }): Promise<number> {
  const { db, auth } = await bootInlay({
    site: target.site,
    db: target.db,
    backups: target.backups,
    ...(target.media !== undefined && { media: target.media }),
    ...(target.content && { content: target.content }),
    auth: { secret: randomBytes(32).toString('hex'), baseUrl: 'http://localhost' },
  })
  try {
    const user = await db.selectFrom('user').select(['id', 'role']).where('email', '=', flags.email.toLowerCase()).executeTakeFirst()
    if (user === undefined) {
      io.err(t('cli.tokenNoUser', { email: flags.email }))
      return 1
    }
    if (flags.push && user.role !== 'owner') {
      io.err(t('cli.tokenNotOwner', { email: flags.email }))
      return 1
    }
    const key = await auth.createApiKey(user.id, flags.name, flags.push ? { permissions: { release: ['push'] } } : {})
    io.out(key)
    io.err(t(flags.push ? 'cli.pushTokenCreated' : 'cli.tokenCreated', { name: flags.name.trim(), email: flags.email }))
    return 0
  } catch (e) {
    if (e instanceof InlayError && (e.code === 'validation' || e.code === 'forbidden')) {
      io.err(e.message)
      for (const issue of e.details.issues ?? []) io.err(issue.message)
      return 1
    }
    throw e
  } finally {
    await db.destroy()
  }
}

/** Sets a new password for the user with this email, read from the terminal or stdin. Ends their sessions and API keys. */
async function resetPassword(io: CliIo, target: Target, email: string): Promise<number> {
  if (!io.readSecret) {
    io.err(t('cli.noSecretInput'))
    return 2
  }
  const password = await io.readSecret(t('cli.passwordPrompt'))
  const { db, auth } = await bootInlay({
    site: target.site,
    db: target.db,
    backups: target.backups,
    ...(target.media !== undefined && { media: target.media }),
    ...(target.content && { content: target.content }),
    auth: { secret: randomBytes(32).toString('hex'), baseUrl: 'http://localhost' },
  })
  try {
    const user = await db.selectFrom('user').select('id').where('email', '=', email.toLowerCase()).executeTakeFirst()
    if (user === undefined) {
      io.err(t('cli.resetNoUser', { email }))
      return 1
    }
    await auth.setPassword(systemCtx('system').actor, user.id, password)
    io.out(t('cli.passwordReset', { email }))
    return 0
  } catch (e) {
    if (e instanceof InlayError && e.code === 'validation') {
      io.err(e.message)
      for (const issue of e.details.issues ?? []) io.err(issue.message)
      return 1
    }
    throw e
  } finally {
    await db.destroy()
  }
}

/** The commands that also run on a host, from its data folder, without a config file. */
const HOST_COMMANDS: readonly string[] = ['backup', 'export', 'import', 'restore-backup', 'create-owner', 'create-token', 'reset-password']

function hasConfigFile(io: CliIo): boolean {
  return ['inlay.config.ts', 'inlay.config.js', 'inlay.config.mjs'].some((name) => existsSync(join(io.cwd, name)))
}

/** The site of the release the database says is current; null without one, or when its files are gone. */
async function releaseSite(paths: HostConfig['paths']): Promise<SiteDefinition | null> {
  if (!existsSync(paths.db)) return null
  const db = openDatabase(paths.db)
  let id: string | null
  try {
    id = (await hasReleasesTable(db)) ? ((await currentRelease(db))?.id ?? null) : null
  } finally {
    await db.destroy()
  }
  if (id === null) return null
  const dir = releaseDir(paths.releases, id)
  if (!existsSync(join(dir, 'site.js')) || !existsSync(join(dir, 'manifest.json'))) return null
  return (await loadRelease(dir)).site
}

async function backup(io: CliIo, target: { db: string; backups: string; media?: string; releases?: string }): Promise<number> {
  if (!existsSync(target.db)) throw new InlayError('not_found', 'error.noDatabase', { path: target.db })
  const db = openDatabase(target.db)
  try {
    const made = await createBackup({
      db,
      backups: target.backups,
      ...(target.media !== undefined && { media: target.media }),
      ...(target.releases !== undefined && { releases: target.releases }),
      reason: 'manual',
      ctx: systemCtx('system'),
    })
    io.out(t('cli.backupCreated', { path: made.path }))
    return 0
  } finally {
    await db.destroy()
  }
}

async function exportContent(io: CliIo, target: Target, out: string | undefined): Promise<number> {
  if (!existsSync(target.db)) throw new InlayError('not_found', 'error.noDatabase', { path: target.db })
  const db = openDatabase(target.db)
  try {
    const core = createCore({ site: target.site, db, ...(target.media !== undefined && { media: target.media }) })
    const file = out ? resolve(io.cwd, out) : join(io.cwd, exportFileName(new Date()))
    const summary = await core.exportContent(file, systemCtx('system'))
    io.out(t('cli.exported', { path: summary.path, documents: summary.counts.documents, media: summary.counts.media }))
    return 0
  } finally {
    await db.destroy()
  }
}

async function restore(
  io: CliIo,
  target: { db: string; media: string; backups: string; releases?: string },
  arg: string,
  serverStopped: boolean,
): Promise<number> {
  const trustedKeys = readTrustedKeys(process.env)
  const result = await restoreBackup({
    // A bare file name that isn't in the current directory is looked up in the backups folder.
    archive: existsSync(resolve(io.cwd, arg)) ? resolve(io.cwd, arg) : arg,
    ...target,
    trustedKeys,
    serverStopped,
  })
  io.out(t('cli.backupRestored', { createdAt: result.restored.createdAt }))
  if (result.release) {
    io.out(t('cli.backupRestoredRelease', { name: result.release.name }))
    if (!result.release.verified) io.out(t('cli.restoreUnsigned'))
  }
  if (result.previous.db) io.out(t('cli.backupRestoredDb', { db: result.previous.db }))
  if (result.previous.media) io.out(t('cli.backupRestoredMedia', { media: result.previous.media }))
  return 0
}

type Values = {
  json?: boolean | undefined
  push?: boolean | undefined
  email?: string | undefined
  name?: string | undefined
  out?: string | undefined
  'dry-run'?: boolean | undefined
  'server-stopped'?: boolean | undefined
}

/** `backup`, `export`, `import`, `restore-backup`, `create-owner`, `create-token` and `reset-password` on a host: everything is in its data folder. */
async function onHost(io: CliIo, command: string, dir: string, values: Values, arg: string): Promise<number> {
  const paths = hostPaths(dir)
  const serverStopped = values['server-stopped'] === true
  try {
    if (command === 'backup') return await backup(io, paths)
    if (command === 'restore-backup') {
      await mkdir(dir, { recursive: true })
      return await restore(io, paths, arg, serverStopped)
    }
    const site = await releaseSite(paths)
    if (command === 'import') {
      if (site === null) {
        io.err(t('cli.importNoRelease'))
        return 2
      }
      const file = resolve(io.cwd, arg)
      if (values['dry-run']) return printImportReport(io, await dryRunImport(site, file), values.json)
      return await importFile(io, { ...paths, site, content: 'none' }, file, { serverStopped })
    }
    // Without a live release, the empty site's admin: the content stays as it is.
    const target: Target = { ...paths, site: site ?? EMPTY_SITE, content: 'none' }
    if (command === 'create-owner') {
      await mkdir(dir, { recursive: true })
      return await createOwner(io, target, values.email ?? '', values.name ?? '')
    }
    if (command === 'create-token') {
      if (!existsSync(paths.db)) throw new InlayError('not_found', 'error.noDatabase', { path: paths.db })
      return await createToken(io, target, { email: values.email ?? '', name: values.name ?? '', push: values.push === true })
    }
    if (command === 'reset-password') {
      if (!existsSync(paths.db)) throw new InlayError('not_found', 'error.noDatabase', { path: paths.db })
      return await resetPassword(io, target, values.email ?? '')
    }
    return await exportContent(io, target, values.out)
  } catch (e) {
    return fail(io, e, 'cli.databaseFailed', paths.db)
  }
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  // Before parseArgs: a cluster worker runs this same command line again, and serve takes its settings from INLAY_*.
  if (argv[0] === 'serve') return argv.length === 1 ? await serve(argv.slice(1), io) : usage(io)
  // Before parseArgs too: dev has its own flags, and its child runs this same command line again.
  if (argv[0] === 'dev') return await dev(argv.slice(1), io)
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        db: { type: 'string' },
        data: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
        email: { type: 'string' },
        name: { type: 'string' },
        out: { type: 'string' },
        export: { type: 'string' },
        'dry-run': { type: 'boolean' },
        'server-stopped': { type: 'boolean' },
        key: { type: 'string' },
        'no-typecheck': { type: 'boolean' },
        token: { type: 'string' },
        file: { type: 'string' },
        activate: { type: 'boolean' },
        push: { type: 'boolean' },
        insecure: { type: 'boolean' },
      },
    })
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e))
    return usage(io)
  }
  const { values, positionals } = parsed
  const [command, ...rest] = positionals
  const commands = [
    'check',
    'backup',
    'export',
    'import',
    'restore-backup',
    'create-owner',
    'create-token',
    'reset-password',
    'keygen',
    'pack',
    'push',
    'activate',
    'releases',
  ]
  if (values.help || !command || !commands.includes(command)) return usage(io)
  // A server address first selects the remote form of activate and releases; push only has that form.
  const remote = (command === 'push' || command === 'activate' || command === 'releases') && isRemote(rest[0])
  if (command === 'push' && !remote) {
    if (rest.length === 1) io.err(t('cli.pushHost', { host: rest[0] ?? '' }))
    return usage(io)
  }
  const takesFile = command === 'import' || command === 'restore-backup' || command === 'activate'
  const wanted = remote ? (command === 'activate' ? 2 : 1) : takesFile ? 1 : 0
  if (rest.length !== wanted) return usage(io)
  const only = (flag: boolean | string | undefined, ...allowed: string[]) => flag === undefined || allowed.includes(command)
  const offline = remote ? '' : command
  if (
    !only(values.out, 'export', 'keygen', 'pack') ||
    !only(values.name, 'create-owner', 'create-token', 'keygen', 'pack', 'push', offline === 'activate' ? 'activate' : '') ||
    !only(values.key, 'pack', 'push') ||
    !only(values['no-typecheck'], 'pack', 'push') ||
    !only(values.db, 'check', 'backup', 'export', 'import', 'restore-backup', 'create-owner', 'create-token', 'reset-password') ||
    !only(values.export, 'check') ||
    !only(values['dry-run'], 'import', 'push') ||
    !only(values['server-stopped'], 'import', 'restore-backup', offline === 'activate' ? 'activate' : '') ||
    !only(values.data, offline === 'activate' || offline === 'releases' ? offline : '', ...HOST_COMMANDS) ||
    !only(values.email, 'create-owner', 'create-token', 'reset-password') ||
    !only(values.token, remote ? command : '') ||
    !only(values.insecure, remote ? command : '') ||
    !only(values.file, 'push') ||
    !only(values.activate, 'push') ||
    !only(values.push, 'create-token') ||
    (values.config !== undefined && (command === 'activate' || command === 'releases')) ||
    (values.file !== undefined && (values.key !== undefined || values.config !== undefined || values['no-typecheck'] !== undefined)) ||
    (values.data !== undefined && (values.config !== undefined || values.db !== undefined)) ||
    (values.export !== undefined && values.db !== undefined)
  ) {
    return usage(io)
  }
  if ((command === 'create-owner' || command === 'create-token') && (!values.email || !values.name)) return usage(io)
  if (command === 'reset-password' && !values.email) return usage(io)
  if ((command === 'pack' || command === 'activate' || command === 'push') && values.name !== undefined && values.name.trim() === '') {
    io.err(t('cli.packName'))
    return 2
  }

  if (remote) {
    const host = rest[0] ?? ''
    if (command === 'push' && values['dry-run'] && values.activate) {
      io.err(t('cli.pushDryRunActivate'))
      return 2
    }
    try {
      checkTransport(host, values.insecure === true)
    } catch (e) {
      return remoteFailed(io, host, e)
    }
    const insecure = values.insecure === true
    if (command === 'push') {
      return await push(io, host, {
        insecure,
        file: values.file,
        activate: values.activate,
        'dry-run': values['dry-run'],
        name: values.name,
        token: values.token,
        key: values.key,
        'no-typecheck': values['no-typecheck'],
        config: values.config,
      })
    }
    if (command === 'activate') return await activateOnHost(io, host, rest[1] ?? '', { token: values.token, insecure })
    return await releasesOnHost(io, host, { token: values.token, json: values.json === true, insecure })
  }

  if (command === 'activate' || command === 'releases') {
    try {
      return command === 'activate'
        ? await activate(io, rest[0] ?? '', { data: values.data, name: values.name, serverStopped: values['server-stopped'] === true })
        : await releases(io, { data: values.data, json: values.json === true })
    } catch (e) {
      return fail(io, e, 'cli.databaseFailed', values.data ?? process.env.INLAY_DATA_DIR ?? '')
    }
  }

  if (command === 'keygen') {
    try {
      return await keygen(io, values.out, values.name ?? 'inlay')
    } catch (e) {
      return fail(io, e, 'cli.configFailed', io.cwd)
    }
  }

  // On a host there's no config file: `--data`, or INLAY_DATA_DIR when no config file is given or found.
  let usingConfig = false
  if (HOST_COMMANDS.includes(command)) {
    const env = process.env.INLAY_DATA_DIR
    const configFile = values.config !== undefined || hasConfigFile(io)
    const host =
      values.data !== undefined
        ? values.data
        : values.config === undefined && values.db === undefined && env && !hasConfigFile(io)
          ? env
          : undefined
    if (host !== undefined) {
      if (configFile) io.err(t('cli.usingData', { path: resolve(io.cwd, host) }))
      return await onHost(io, command, resolve(io.cwd, host), values, rest[0] ?? '')
    }
    // Both are there: say which one this command works on.
    usingConfig = Boolean(env) && values.db === undefined
  }

  let config: InlayConfig
  let file = ''
  let dir = ''
  try {
    file = findConfig(io, values.config)
    ;({ config, file, dir } = await loadConfig(file))
  } catch (e) {
    return fail(io, e, 'cli.configFailed', file)
  }
  if (usingConfig) io.err(t('cli.usingConfig', { file }))

  if (command === 'pack') {
    return await pack(io, file, dir, {
      ...(values.key !== undefined && { key: values.key }),
      ...(values.out !== undefined && { out: values.out }),
      ...(values.name !== undefined && { name: values.name }),
      typecheck: values['no-typecheck'] !== true,
    })
  }

  const given = values.db ? resolve(io.cwd, values.db) : config.db
  try {
    if (command === 'check' && values.export !== undefined) {
      return printImportReport(io, await dryRunImport(config.site, resolve(io.cwd, values.export)), values.json)
    }
    if (command === 'import' && values['dry-run']) {
      return printImportReport(io, await dryRunImport(config.site, resolve(io.cwd, rest[0] ?? '')), values.json)
    }
    if (command === 'check') {
      try {
        buildRegistry(config.site)
      } catch (e) {
        if (!(e instanceof InlayError) || e.code !== 'definition') throw e
        io.err(e.message)
        return 1
      }
      // A config's database may not exist yet (a fresh checkout, CI); only --db insists on one.
      const db = values.db !== undefined || (given !== undefined && existsSync(given)) ? given : undefined
      const report = db !== undefined ? await checkDatabase({ site: config.site, db }) : await checkWithoutDatabase({ site: config.site })
      const problems = await checkBundle(file)
      if (problems.length > 0) {
        report.problems.push(...problems)
        report.ok = false
      }
      if (values.json) io.out(JSON.stringify(report, null, 2))
      else for (const line of formatReport(report)) io.out(line)
      return report.ok ? 0 : 1
    }
  } catch (e) {
    return fail(io, e, 'cli.databaseFailed', given ?? file)
  }

  if (given === undefined) {
    io.err(t('cli.configDb', { path: file }))
    return 2
  }
  const dbPath = given
  const target: Target = {
    db: dbPath,
    backups: config.backups ?? join(dbPath, '..', 'backups'),
    ...(config.media !== undefined && { media: config.media }),
    site: config.site,
  }
  try {
    if (command === 'create-owner') return await createOwner(io, target, values.email ?? '', values.name ?? '')
    if (command === 'create-token') {
      if (!existsSync(dbPath)) throw new InlayError('not_found', 'error.noDatabase', { path: dbPath })
      return await createToken(io, target, { email: values.email ?? '', name: values.name ?? '', push: values.push === true })
    }
    if (command === 'reset-password') {
      if (!existsSync(dbPath)) throw new InlayError('not_found', 'error.noDatabase', { path: dbPath })
      return await resetPassword(io, target, values.email ?? '')
    }
    if (command === 'import') {
      return await importFile(io, target, resolve(io.cwd, rest[0] ?? ''), { serverStopped: values['server-stopped'] === true })
    }
    if (command === 'restore-backup') {
      const media = config.media ?? join(dbPath, '..', 'media')
      return await restore(io, { db: dbPath, media, backups: target.backups }, rest[0] ?? '', values['server-stopped'] === true)
    }
    if (command === 'export') return await exportContent(io, target, values.out)
    return await backup(io, target)
  } catch (e) {
    return fail(io, e, 'cli.databaseFailed', dbPath)
  }
}
