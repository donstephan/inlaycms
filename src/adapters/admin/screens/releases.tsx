import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import type { Database } from '../../../core/db/schema.js'
import { InlayError } from '../../../core/errors.js'
import { t } from '../../../core/messages/index.js'
import { manifestSchema, type ReleaseManifest } from '../../../core/release/manifest.js'
import type { Actor } from '../../../core/types.js'
import type { Renderable } from '../../../jsx/html.js'
import { formatDiff, structuralDiff } from '../../../host/diff.js'
import type { ContentDiffResult } from '../../../host/hooks.js'
import { currentManifest, packAgainWarning, pendingMigrations, PUSH_MAX_BYTES, RELEASE_NAME_MAX } from '../../../host/push.js'
import { deleteRelease, getRelease, listReleases, releaseDir, storeRelease, type ReleaseRow } from '../../../host/store.js'
import { previewLink } from '../../site/preview.js'
import { adminActor, forbidden, HTML, noticeOf, notFound, type AdminContext } from '../context.js'
import { DataTable } from '../views/data-table.js'
import { Icon } from '../views/icons.js'
import { Alert, adminPage, Time } from '../views/layout.js'
import { Sheet } from '../views/sheet.js'
import { Badge, type BadgeTone } from '../views/status.js'

type State = ReleaseRow['state']

const FILE_TOO_LARGE = 'FST_REQ_FILE_TOO_LARGE'
const TOO_MANY_FILES = 'FST_FILES_LIMIT'
const tooLarge = t('error.pushTooLarge', { mb: Math.floor(PUSH_MAX_BYTES / 1024 ** 2) })

const STATE_TONE: Record<State, BadgeTone> = { current: 'success', staged: 'info', previous: 'ghost', deleted: 'neutral' }

function StateBadge({ state }: { state: State }) {
  return <Badge tone={STATE_TONE[state]}>{t(`admin.releases.state.${state}`)}</Badge>
}

/** `line` with each `quoted` part as code, the way the diff and hidden-content lines name types and fields. */
function Line({ text }: { text: string }) {
  return <>{text.split('`').map((part, i) => (i % 2 === 1 ? <code class="font-mono text-sm">{part}</code> : part))}</>
}

function Section({ id, title, children }: { id: string; title: string; children?: Renderable }) {
  return (
    <section class="flex flex-col gap-2" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} class="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  )
}

async function readManifest(file: string): Promise<ReleaseManifest | null> {
  try {
    return manifestSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return null
  }
}

/** Why an uploaded file couldn't be kept, in plain words; null when it isn't a problem with the file. */
function uploadProblem(e: unknown): string | null {
  if (!(e instanceof InlayError)) return null
  if (e.messageId === 'error.archiveUnreadable' || e.messageId === 'error.archiveTooManyFiles') return t('error.releaseInvalid')
  return e.message
}

/** Where a hidden field is stored, as an editor reads it: `slots.hero.data.headline` is `hero › headline`. */
function fieldPath(path: string): string {
  const [root, ...rest] = path.split('.')
  if (root === 'slots' && rest[1] === 'data') rest.splice(1, 1)
  return (root === 'fields' || root === 'slots' ? rest : [root, ...rest]).join(' › ')
}

/**
 * The owner's Releases screen, when the admin has the database and the releases folder: the list with an upload
 * sheet, each release's page (what it changes, preview, activate, delete). Preview and activation need `ctx.host`.
 */
export function registerReleases(scope: FastifyInstance, ctx: AdminContext): void {
  const { db, releasesDir } = ctx
  if (db !== undefined && releasesDir !== undefined) releaseRoutes(scope, ctx, db, releasesDir)
}

function releaseRoutes(scope: FastifyInstance, ctx: AdminContext, db: Kysely<Database>, releasesDir: string): void {
  const { core, host } = ctx

  async function namesOf(actor: Actor): Promise<Map<string, string>> {
    const users = await ctx.service.listUsers(actor)
    return new Map(users.map((u) => [u.id, u.name]))
  }

  const pushedBy = (row: ReleaseRow, names: Map<string, string>) =>
    row.pushed_by === null ? t('admin.releases.commandLine') : (names.get(row.pushed_by) ?? row.pushed_by)

  const activated = (row: ReleaseRow) => (row.activated_at === null ? t('admin.releases.never') : <Time iso={row.activated_at} relative />)

  async function listPage(request: FastifyRequest, reply: FastifyReply, status = 200, upload?: { error: string; name: string }) {
    const actor = adminActor(request)
    const [releases, names] = await Promise.all([listReleases(db), namesOf(actor)])
    const notice = noticeOf(request.query)
    const open = upload !== undefined || (request.query as Record<string, unknown>).sheet === 'upload'
    const body = (
      <div class="flex flex-col gap-6">
        <p>{t('admin.releases.intro')}</p>
        <DataTable
          id="releases"
          caption={t('admin.releases.table')}
          base="/admin/releases"
          rows={releases}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.name}
          empty={t('admin.releases.empty')}
          columns={[
            {
              key: 'name',
              label: t('admin.releases.name'),
              cell: (r) => (
                <a href={`/admin/releases/${encodeURIComponent(r.id)}`} class="link font-medium">
                  {r.name}
                </a>
              ),
            },
            {
              key: 'state',
              label: t('admin.releases.state'),
              cell: (r) => (
                <>
                  <StateBadge state={r.state} />
                  {packAgainWarning(r) !== null && (
                    <Badge tone="warning" class="ml-2">
                      {t('admin.releases.packAgainBadge')}
                    </Badge>
                  )}
                </>
              ),
            },
            { key: 'pushedBy', label: t('admin.releases.pushedBy'), cell: (r) => pushedBy(r, names) },
            { key: 'pushedAt', label: t('admin.releases.pushedAt'), cell: (r) => <Time iso={r.pushed_at} relative /> },
            { key: 'activatedAt', label: t('admin.releases.activatedAt'), cell: activated },
          ]}
        />
        <Sheet
          id="upload-release"
          title={t('admin.releases.upload')}
          description={t('admin.releases.uploadDescription')}
          open={open}
          action="/admin/releases/upload"
          enctype="multipart/form-data"
          submit={t('admin.releases.uploadSubmit')}
        >
          {upload !== undefined && (
            <Alert kind="error" id="upload-error">
              {upload.error}
            </Alert>
          )}
          <div class="flex flex-col gap-1.5">
            <label for="release-name" class="text-sm font-medium">
              {t('admin.releases.uploadName')}
            </label>
            <input
              id="release-name"
              name="name"
              type="text"
              maxlength={RELEASE_NAME_MAX}
              value={upload?.name ?? ''}
              class="input w-full"
              aria-describedby="release-name-hint"
            />
            <p id="release-name-hint" class="text-xs text-base-content/70">
              {t('admin.releases.uploadNameHint')}
            </p>
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="release-file" class="text-sm font-medium">
              {t('admin.releases.uploadFile')}
            </label>
            <input id="release-file" name="release" type="file" accept=".tgz,.tar.gz,application/gzip" class="file-input w-full" />
          </div>
        </Sheet>
      </div>
    )
    const page = await adminPage(
      ctx,
      {
        title: t('admin.releases.title'),
        actor,
        section: 'releases',
        status,
        actions: (
          <button type="button" class="btn btn-primary btn-sm" data-sheet-open="upload-release">
            <Icon name="upload" />
            {t('admin.releases.upload')}
          </button>
        ),
        ...(notice !== undefined && { notice }),
      },
      body,
    )
    return reply.code(status).type(HTML).send(page)
  }

  /**
   * What the site runs now, as a push compares with: the current release's manifest, else what this app serves;
   * null when the host serves no site yet.
   */
  function liveManifest(): Promise<ReleaseManifest | null> {
    if (host?.liveManifest) return host.liveManifest()
    return currentManifest({ db, config: { paths: { releases: releasesDir } }, registry: core.registry, now: ctx.now })
  }

  /** The release's changes; with `fetchContent` false (a re-render after a refused action), without asking the host. */
  async function changes(row: ReleaseRow, manifest: ReleaseManifest, fetchContent: boolean) {
    const structural = structuralDiff(await liveManifest(), manifest)
    structural.migrations = await pendingMigrations(db, row.id, structural.migrations)
    let found: ContentDiffResult = { content: null, warnings: [] }
    let note: string | null = null
    if (row.state !== 'staged' || host === undefined) note = host === undefined ? t('admin.releases.contentNeedsHost') : null
    else {
      if (fetchContent) {
        found = await host.contentDiff(row.id).catch((e: unknown) => {
          scope.log.warn({ err: e }, 'release content diff failed')
          return { content: null, warnings: [] }
        })
      }
      if (found.content === null) note = t('admin.releases.contentUnavailable')
    }
    return (
      <>
        <ul class="list-disc pl-6">
          {formatDiff({ structural, content: found.content }).map((line) => (
            <li>
              <Line text={line} />
            </li>
          ))}
        </ul>
        {note !== null && (
          <div id="content-unavailable" class="flex flex-col gap-1 text-sm text-base-content/70">
            <p>{note}</p>
            {found.warnings.map((warning) => (
              <p>{warning}</p>
            ))}
          </div>
        )}
      </>
    )
  }

  async function hidden() {
    const found = await core.hiddenContent()
    const label = (type: string) => core.registry.types.get(type)?.label ?? type
    const lines = [
      ...found.types.map((h) => t('admin.releases.hiddenType', h)),
      ...found.locales.map((h) => t('admin.releases.hiddenLocale', h)),
      ...found.slots.map((h) => t('admin.releases.hiddenSlot', { label: label(h.type), slot: h.slot, documents: h.documents })),
      ...found.fields.map((h) => t('admin.releases.hiddenField', { label: label(h.type), path: fieldPath(h.path), documents: h.documents })),
    ]
    if (lines.length === 0) return <p>{t('admin.releases.hiddenNone')}</p>
    return (
      <>
        <p>{t('admin.releases.hiddenIntro')}</p>
        <ul class="list-disc pl-6">
          {lines.map((line) => (
            <li>
              <Line text={line} />
            </li>
          ))}
        </ul>
      </>
    )
  }

  async function releasePage(request: FastifyRequest, reply: FastifyReply, row: ReleaseRow, status = 200, error?: string) {
    const actor = adminActor(request)
    const names = await namesOf(actor)
    const notice = noticeOf(request.query)
    const manifest = row.state === 'deleted' ? null : await readManifest(join(releaseDir(releasesDir, row.id), 'manifest.json'))
    // A release whose files are missing can't be activated: its page says so instead.
    const activatable = (row.state === 'staged' || row.state === 'previous') && manifest !== null
    const fact = (label: string, value: Renderable) => (
      <div class="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
        <dt class="text-sm text-base-content/70 sm:w-56 sm:shrink-0">{label}</dt>
        <dd>{value}</dd>
      </div>
    )
    const packAgain = packAgainWarning(row)
    const body = (
      <div class="flex flex-col gap-8">
        {error !== undefined && (
          <Alert kind="error" id="release-error">
            {error}
          </Alert>
        )}
        <Section id="facts" title={t('admin.releases.facts')}>
          <dl class="flex flex-col gap-2">
            {fact(t('admin.releases.state'), <StateBadge state={row.state} />)}
            {fact(t('admin.releases.pushedBy'), pushedBy(row, names))}
            {fact(t('admin.releases.pushedAt'), <Time iso={row.pushed_at} />)}
            {fact(t('admin.releases.activatedAt'), row.activated_at === null ? t('admin.releases.never') : <Time iso={row.activated_at} />)}
            {fact(t('admin.releases.signedBy'), <code class="font-mono text-sm break-all">{row.signed_by}</code>)}
            {fact(
              t('admin.releases.secrets'),
              row.secrets.length === 0 ? t('admin.releases.secretsNone') : <code class="font-mono text-sm">{row.secrets.join(', ')}</code>,
            )}
          </dl>
        </Section>
        {packAgain !== null && (
          <Alert kind="warning" id="pack-again">
            {packAgain}
          </Alert>
        )}
        {row.state === 'deleted' && <p>{t('admin.releases.deletedNote')}</p>}
        {row.state !== 'deleted' && manifest === null && (
          <Alert kind="warning" id="files-missing">
            {t('admin.releases.filesMissing')}
          </Alert>
        )}
        {activatable && host === undefined && (
          <Alert kind="info" id="no-host">
            {t('admin.releases.noHost')}
          </Alert>
        )}
        {activatable && host !== undefined && (
          <Section id="activate" title={t('admin.releases.activate')}>
            <p id="activate-hint">{t('admin.releases.activateHint')}</p>
            <div class="flex flex-wrap gap-2">
              <form method="post" action={`/admin/releases/${encodeURIComponent(row.id)}/activate`}>
                <button type="submit" class="btn btn-primary" aria-describedby="activate-hint">
                  {t('admin.releases.activate')}
                </button>
              </form>
              {row.state === 'staged' && (
                <a
                  href={previewLink(ctx, '/', { release: row.id })}
                  target="_blank"
                  rel="noopener"
                  class="btn"
                  data-release-preview
                  aria-describedby="preview-hint"
                >
                  <Icon name="eye" />
                  {t('admin.releases.preview')}
                </a>
              )}
            </div>
            {row.state === 'staged' && (
              <p id="preview-hint" class="text-sm text-base-content/70">
                {t('admin.releases.previewHint')}
              </p>
            )}
          </Section>
        )}
        {manifest !== null && row.state !== 'current' && (
          <Section id="changes" title={t('admin.releases.changes')}>
            {await changes(row, manifest, status === 200)}
          </Section>
        )}
        {manifest !== null && (
          <Section id="migrations" title={t('admin.releases.migrations')}>
            {manifest.migrations.length === 0 ? (
              <p>{t('admin.releases.migrationsNone')}</p>
            ) : (
              <ul class="list-disc pl-6">
                {manifest.migrations.map((name) => (
                  <li>
                    <code class="font-mono text-sm">{name}</code>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}
        {row.state === 'current' && (
          <Section id="hidden" title={t('admin.releases.hidden')}>
            {await hidden()}
          </Section>
        )}
        {row.state !== 'current' && row.state !== 'deleted' && (
          <Section id="delete" title={t('admin.releases.delete')}>
            <p id="delete-hint">{t('admin.releases.deleteHint')}</p>
            <form method="post" action={`/admin/releases/${encodeURIComponent(row.id)}/delete`}>
              <button type="submit" class="btn btn-error btn-outline" aria-describedby="delete-hint">
                <Icon name="trash" />
                {t('admin.releases.delete')}
              </button>
            </form>
          </Section>
        )}
      </div>
    )
    const page = await adminPage(
      ctx,
      {
        title: row.name,
        actor,
        section: 'releases',
        status,
        breadcrumbs: [{ label: t('admin.releases.title'), href: '/admin/releases' }],
        ...(notice !== undefined && { notice }),
      },
      body,
    )
    return reply.code(status).type(HTML).send(page)
  }

  scope.get('/admin/releases', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    return listPage(request, reply)
  })

  scope.get('/admin/releases/upload', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    return reply.redirect('/admin/releases?sheet=upload', 303)
  })

  scope.post('/admin/releases/upload', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    const again = (error: string, name = '') => listPage(request, reply, 400, { error, name })
    if (!request.isMultipart()) return again(t('admin.releases.noFile'))
    await mkdir(releasesDir, { recursive: true })
    const work = await mkdtemp(join(releasesDir, '.upload-'))
    const file = join(work, 'release.tgz')
    let name = ''
    let received = false
    try {
      for await (const part of request.parts({ limits: { fileSize: PUSH_MAX_BYTES, files: 1 } })) {
        if (part.type === 'field') {
          if (part.fieldname === 'name' && typeof part.value === 'string') name = part.value.trim()
          continue
        }
        if (part.fieldname !== 'release' || received) {
          part.file.resume()
          continue
        }
        await pipeline(part.file, createWriteStream(file))
        if (part.file.truncated) return again(tooLarge, name)
        received = true
      }
      if (!received || (await stat(file)).size === 0) return again(t('admin.releases.noFile'), name)
      if (name.length > RELEASE_NAME_MAX) return again(t('error.releaseNameTooLong', { max: RELEASE_NAME_MAX }), name)
      if (host === undefined && (ctx.trustedKeys ?? []).length === 0) return again(t('admin.releases.noKeys'), name)
      const push = { pushedBy: actor.id ?? null, ...(name !== '' && { name }) }
      let release: ReleaseRow
      try {
        release =
          host === undefined
            ? await storeRelease({ db, releasesDir, trustedKeys: ctx.trustedKeys ?? [], now: ctx.now }, file, push)
            : (await host.pushFile(file, push)).release
      } catch (e) {
        const problem = uploadProblem(e)
        if (problem === null) throw e
        return again(problem, name)
      }
      return reply.redirect(`/admin/releases/${encodeURIComponent(release.id)}?notice=releaseUploaded`, 303)
    } catch (e) {
      const code = (e as { code?: unknown }).code
      if (code === FILE_TOO_LARGE) return again(tooLarge, name)
      if (code === TOO_MANY_FILES) return again(t('admin.upload.oneFile'), name)
      throw e
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })

  scope.get('/admin/releases/:id', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    const row = await getRelease(db, (request.params as { id: string }).id)
    if (row === null) return notFound(reply, ctx, actor)
    return releasePage(request, reply, row)
  })

  scope.post('/admin/releases/:id/activate', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    const row = await getRelease(db, (request.params as { id: string }).id)
    if (row === null) return notFound(reply, ctx, actor)
    if (row.state === 'deleted') return releasePage(request, reply, row, 409, t('error.releaseDeleted', { name: row.name }))
    if (row.state === 'current') return releasePage(request, reply, row, 409, t('admin.releases.alreadyCurrent', { name: row.name }))
    if (host === undefined) return releasePage(request, reply, row, 409, t('admin.releases.noHost'))
    try {
      await host.requestActivation(row.id)
    } catch (e) {
      request.log.error({ err: e }, 'release activation failed')
      const message =
        e instanceof InlayError ? e.message : t('error.releaseActivationFailed', { problem: e instanceof Error ? e.message : String(e) })
      return releasePage(request, reply, (await getRelease(db, row.id)) ?? row, 500, message)
    }
    return reply.redirect(`/admin/releases/${encodeURIComponent(row.id)}?notice=releaseActivated`, 303)
  })

  scope.post('/admin/releases/:id/delete', async (request, reply) => {
    const actor = adminActor(request)
    if (actor.role !== 'owner') return forbidden(reply, ctx, actor)
    const row = await getRelease(db, (request.params as { id: string }).id)
    if (row === null) return notFound(reply, ctx, actor)
    if (row.state === 'deleted') return releasePage(request, reply, row, 409, t('admin.releases.alreadyDeleted', { name: row.name }))
    try {
      await deleteRelease({ db, releasesDir, ...(ctx.mediaDir !== undefined && { mediaDir: ctx.mediaDir }) }, row.id)
    } catch (e) {
      if (e instanceof InlayError && e.messageId === 'error.releaseCurrent') return releasePage(request, reply, row, 409, e.message)
      throw e
    }
    // Its preview has nothing left to show.
    await host?.stopPreview?.(row.id).catch((e: unknown) => request.log.warn({ err: e }, e instanceof Error ? e.message : String(e)))
    return reply.redirect('/admin/releases?notice=releaseDeleted', 303)
  })
}
