import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { InlayError } from '../../../core/errors.js'
import { exportFileName } from '../../../core/export/format.js'
import { siteLockLines, type ImportReport } from '../../../core/export/report.js'
import { formatSize } from '../../../core/media/labels.js'
import { t } from '../../../core/messages/index.js'
import type { CheckProblem } from '../../../core/report.js'
import type { Ctx } from '../../../core/types.js'
import { adminActor, forbidden, HTML, noticeOf, notFound, type AdminContext } from '../context.js'
import { DataTable } from '../views/data-table.js'
import { Icon } from '../views/icons.js'
import { Alert, adminPage, Time } from '../views/layout.js'

/** The largest export the upload form takes. */
export const IMPORT_MAX_BYTES = 1024 ** 3
/** How long an uploaded export waits for its confirmation before the next upload deletes it. */
const STAGED_MAX_AGE_MS = 60 * 60 * 1000
const TOKEN = /^[0-9a-f-]{36}$/

let staging: Promise<string> | undefined

/**
 * This process's folder for uploaded exports: made once with a random name and mode 0700, so no other user can
 * read, plant or swap files in it. Made again if it is gone or is no longer a private directory.
 */
export async function stagingDir(): Promise<string> {
  const current = (staging ??= mkdtemp(join(tmpdir(), 'inlay-imports-')))
  const dir = await current.catch(() => null)
  const info = dir === null ? null : await lstat(dir).catch(() => null)
  const own = process.getuid === undefined || info?.uid === process.getuid()
  if (dir !== null && info?.isDirectory() && own && (info.mode & 0o077) === 0) return dir
  if (staging === current) staging = undefined
  return (staging ??= mkdtemp(join(tmpdir(), 'inlay-imports-')))
}

/** Deletes the staged uploads nobody confirmed within the hour. */
async function sweepStaged(): Promise<void> {
  const dir = await stagingDir()
  const names = await readdir(dir).catch(() => [])
  for (const name of names) {
    const path = join(dir, name)
    const info = await stat(path).catch(() => null)
    if (info !== null && Date.now() - info.mtimeMs > STAGED_MAX_AGE_MS) await rm(path, { force: true })
  }
}

function Problems({ problems }: { problems: CheckProblem[] }) {
  if (problems.length === 0) return null
  return (
    <ul class="list-disc pl-6 text-sm">
      {problems.map((p) => (
        <li>
          {p.message}
          {(p.issues ?? []).length > 0 && (
            <ul class="list-disc pl-6">
              {(p.issues ?? []).map((i) => (
                <li>{i.message}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  )
}

/** The owner's Backups screen: the list, a "Back up now" button and the downloads. */
export function registerBackups(scope: FastifyInstance, ctx: AdminContext): void {
  const { core } = ctx
  scope.addHook('onClose', async () => {
    const dir = await staging?.catch(() => null)
    staging = undefined
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  })
  const asCtx = (request: FastifyRequest): Ctx => ({ actor: adminActor(request), source: 'admin' })

  async function backupsPage(request: FastifyRequest, reply: FastifyReply, status = 200, error?: string) {
    const actor = adminActor(request)
    const backups = await core.listBackups(asCtx(request))
    const notice = noticeOf(request.query)
    const body = (
      <div class="flex flex-col gap-8">
        {error !== undefined && (
          <Alert kind="error" id="import-error">
            {error}
          </Alert>
        )}
        <p>{t('admin.backups.intro')}</p>
        <DataTable
          id="backups"
          caption={t('admin.backups.table')}
          base="/admin/backups"
          rows={backups}
          rowKey={(b) => b.path}
          rowLabel={(b) => b.createdAt}
          empty={t('admin.backups.empty')}
          columns={[
            { key: 'made', label: t('admin.backups.made'), cell: (b) => <Time iso={b.createdAt} relative /> },
            { key: 'kind', label: t('admin.backups.kind'), cell: (b) => t(`admin.backups.reason.${b.reason}`) },
            { key: 'size', label: t('admin.backups.size'), align: 'end', class: 'tabular-nums', cell: (b) => formatSize(b.size) },
            {
              key: 'download',
              label: t('admin.backups.download'),
              hideLabel: true,
              align: 'end',
              cell: (b) => (
                <a href={`/admin/backups/${encodeURIComponent(basename(b.path))}`} class="btn btn-ghost btn-xs">
                  <Icon name="download" />
                  {t('admin.backups.download')}
                </a>
              ),
            },
          ]}
        />
        <p class="flex items-center gap-2 text-sm text-base-content/60">
          <Icon name="info" />
          {t('admin.backups.restoreHint')}
        </p>
        <div class="grid gap-6 lg:grid-cols-2">
          <section class="card card-border bg-base-100" aria-labelledby="export-heading">
            <div class="card-body gap-4">
              <h2 id="export-heading" class="card-title text-lg">
                {t('admin.export.title')}
              </h2>
              <p>{t('admin.export.intro')}</p>
              <div>
                <a href="/admin/backups/export" class="btn">
                  {t('admin.export.download')}
                </a>
              </div>
            </div>
          </section>
          <section class="card card-border bg-base-100" aria-labelledby="import-heading">
            <div class="card-body gap-4">
              <h2 id="import-heading" class="card-title text-lg">
                {t('admin.import.title')}
              </h2>
              <p id="import-hint">{t('admin.import.intro')}</p>
              <form method="post" action="/admin/backups/import" enctype="multipart/form-data" class="flex flex-col gap-4">
                <div class="flex flex-col gap-1">
                  <label for="import-archive" class="text-sm font-medium">
                    {t('admin.import.file')}
                  </label>
                  <input
                    id="import-archive"
                    name="archive"
                    type="file"
                    accept=".tar.gz,application/gzip"
                    class="file-input w-full"
                    aria-describedby="import-hint"
                  />
                </div>
                <div>
                  <button type="submit" class="btn btn-primary">
                    {t('admin.import.check')}
                  </button>
                </div>
              </form>
            </div>
          </section>
        </div>
      </div>
    )
    const page = await adminPage(
      ctx,
      {
        title: t('admin.backups.title'),
        actor,
        section: 'backups',
        status,
        actions: (
          <form method="post" action="/admin/backups">
            <button type="submit" class="btn btn-primary btn-sm">
              {t('admin.backups.make')}
            </button>
          </form>
        ),
        ...(notice !== undefined && { notice }),
      },
      body,
    )
    return reply.code(status).type(HTML).send(page)
  }

  async function reportPage(request: FastifyRequest, reply: FastifyReply, status: number, report: ImportReport, token: string) {
    const actor = adminActor(request)
    const hiddenLocales = report.locales.filter((l) => l.status !== 'compatible')
    const body = (
      <div class="flex flex-col gap-8">
        <p>
          {t('admin.import.exportedAt')} <Time iso={report.exportedAt} />. {t('admin.import.version', { version: report.inlayVersion })}.
        </p>
        <section class="flex flex-col gap-2" aria-labelledby="types-heading">
          <h2 id="types-heading" class="text-lg font-semibold">
            {t('admin.import.types')}
          </h2>
          <DataTable
            id="import-report"
            caption={t('admin.import.types')}
            base="/admin/backups"
            rows={report.types}
            rowKey={(row) => row.label}
            rowLabel={(row) => row.label}
            empty={t('admin.import.typesEmpty')}
            columns={[
              {
                key: 'type',
                label: t('admin.import.type'),
                cell: (row) => (
                  <>
                    {row.label}
                    {row.gaps > 0 && <p class="text-sm">{t('admin.import.gaps', { count: row.gaps })}</p>}
                  </>
                ),
              },
              { key: 'documents', label: t('admin.import.documents'), cell: (row) => row.documents },
              { key: 'status', label: t('admin.import.status'), cell: (row) => t(`import.status.${row.status}`) },
            ]}
          />
        </section>
        {hiddenLocales.length > 0 && (
          <section class="flex flex-col gap-2" aria-labelledby="locales-heading">
            <h2 id="locales-heading" class="text-lg font-semibold">
              {t('admin.import.locales')}
            </h2>
            <ul class="flex flex-col gap-2">
              {hiddenLocales.map((row) => (
                <li>{t('import.localeLine', { locale: row.locale, status: t(`import.status.${row.status}`), documents: row.documents })}</li>
              ))}
            </ul>
          </section>
        )}
        {report.general.length > 0 && (
          <section class="flex flex-col gap-2" aria-labelledby="general-heading">
            <h2 id="general-heading" class="text-lg font-semibold">
              {t('admin.import.general')}
            </h2>
            <Problems problems={report.general} />
          </section>
        )}
        {report.media.damaged.length > 0 && (
          <section class="flex flex-col gap-2" aria-labelledby="damaged-heading">
            <h2 id="damaged-heading" class="text-lg font-semibold">
              {t('admin.import.damaged')}
            </h2>
            <p>{t('import.damagedMedia', { count: report.media.damaged.length, names: report.media.damaged.join(', ') })}</p>
          </section>
        )}
        {report.shipped.length > 0 && (
          <section class="flex flex-col gap-2" aria-labelledby="shipped-heading">
            <h2 id="shipped-heading" class="text-lg font-semibold">
              {t('admin.import.shippedTitle')}
            </h2>
            <ul class="list-disc pl-6">
              {report.shipped.map((title) => (
                <li>{title}</li>
              ))}
            </ul>
          </section>
        )}
        {siteLockLines(report.siteLock).length > 0 && (
          <section class="flex flex-col gap-2" aria-labelledby="site-lock-heading">
            <h2 id="site-lock-heading" class="text-lg font-semibold">
              {t('admin.import.siteLockTitle')}
            </h2>
            <ul class="list-disc pl-6">
              {siteLockLines(report.siteLock).map((line) => (
                <li>{line}</li>
              ))}
            </ul>
          </section>
        )}
        {report.ok ? (
          <form method="post" action={`/admin/backups/import/${token}`} class="flex flex-col gap-4">
            <Alert kind="warning" id="replace-warning">
              {t('admin.import.replaceWarning')}
            </Alert>
            <div class="flex gap-4">
              <button type="submit" class="btn btn-primary">
                {t('admin.import.restore')}
              </button>
              <a href="/admin/backups" class="btn">
                {t('admin.import.back')}
              </a>
            </div>
          </form>
        ) : (
          <div class="flex flex-col gap-4">
            <Alert kind="error" id="cannot-restore">
              {t('admin.import.cannotRestore')}
            </Alert>
            <div>
              <a href="/admin/backups" class="btn">
                {t('admin.import.back')}
              </a>
            </div>
          </div>
        )}
      </div>
    )
    const page = await adminPage(
      ctx,
      {
        title: t('admin.import.reportTitle'),
        actor,
        section: 'backups',
        status,
        breadcrumbs: [{ label: t('admin.backups.title'), href: '/admin/backups' }],
      },
      body,
    )
    return reply.code(status).type(HTML).send(page)
  }

  scope.get('/admin/backups', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    return backupsPage(request, reply)
  })

  scope.get('/admin/backups/export', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    const file = join(tmpdir(), `inlay-export-${randomUUID()}.tar.gz`)
    try {
      await core.exportContent(file, asCtx(request))
      const { size } = await stat(file)
      const stream = createReadStream(file)
      stream.on('close', () => void rm(file, { force: true }))
      return reply
        .type('application/gzip')
        .header('content-disposition', `attachment; filename="${exportFileName(new Date())}"`)
        .header('content-length', size)
        .send(stream)
    } catch (e) {
      await rm(file, { force: true })
      throw e
    }
  })

  scope.post('/admin/backups/import', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    if (!request.isMultipart()) return backupsPage(request, reply, 400, t('admin.import.noFile'))
    await sweepStaged()
    const part = await request.file({ limits: { fileSize: IMPORT_MAX_BYTES, files: 1 }, throwFileSizeLimit: false })
    if (!part) return backupsPage(request, reply, 400, t('admin.import.noFile'))
    const token = randomUUID()
    const path = join(await stagingDir(), `${token}.tar.gz`)
    try {
      await pipeline(part.file, createWriteStream(path))
      if (part.file.truncated) {
        await rm(path, { force: true })
        return backupsPage(request, reply, 400, t('admin.import.tooLarge', { max: formatSize(IMPORT_MAX_BYTES) }))
      }
      if ((await stat(path)).size === 0) {
        await rm(path, { force: true })
        return backupsPage(request, reply, 400, t('admin.import.noFile'))
      }
      const report = await core.importDryRun(path, asCtx(request))
      return reportPage(request, reply, 200, report, token)
    } catch (e) {
      await rm(path, { force: true })
      if (e instanceof InlayError && e.code === 'validation') return backupsPage(request, reply, 400, e.message)
      throw e
    }
  })

  scope.post('/admin/backups/import/:token', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    const { token } = request.params as { token: string }
    if (!TOKEN.test(token)) return notFound(reply, ctx, actor)
    const path = join(await stagingDir(), `${token}.tar.gz`)
    if (!(await stat(path).catch(() => null))) return notFound(reply, ctx, actor)
    try {
      const result = await core.importContent(path, asCtx(request))
      await rm(path, { force: true })
      return reply.redirect(`/admin/backups?notice=contentImported&documents=${result.imported.documents}`, 303)
    } catch (e) {
      if (e instanceof InlayError && e.code === 'check_failed' && e.details.importReport) {
        return reportPage(request, reply, 409, e.details.importReport, token)
      }
      if (e instanceof InlayError && e.code === 'validation') {
        await rm(path, { force: true })
        return backupsPage(request, reply, 400, e.message)
      }
      throw e
    }
  })

  scope.post('/admin/backups', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    await core.backup(asCtx(request))
    return reply.redirect('/admin/backups?notice=backedUp', 303)
  })

  scope.get('/admin/backups/:name', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    const { name } = request.params as { name: string }
    try {
      const backup = await core.backupFile(name, asCtx(request))
      const file = basename(backup.path)
      return reply
        .type('application/gzip')
        .header('content-disposition', `attachment; filename="${file}"`)
        .header('content-length', backup.size)
        .send(createReadStream(backup.path))
    } catch (e) {
      if (e instanceof InlayError && e.code === 'not_found') return notFound(reply, ctx, actor)
      throw e
    }
  })
}
