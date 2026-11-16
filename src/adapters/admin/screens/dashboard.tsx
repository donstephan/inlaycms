import type { FastifyInstance } from 'fastify'
import type { BackupInfo } from '../../../core/backup/backup.js'
import type { GapSummary } from '../../../core/content/gaps.js'
import { InlayError } from '../../../core/errors.js'
import { formatSize } from '../../../core/media/labels.js'
import { t } from '../../../core/messages/index.js'
import type { Renderable } from '../../../jsx/html.js'
import type { Actor, Activity, Ctx, DocumentSummary } from '../../../core/types.js'
import { groupActivity, type ActivityLine } from '../activity.js'
import { needsAttention, type AttentionItem } from '../attention.js'
import { adminActor, HTML, noticeOf, type AdminContext } from '../context.js'
import { missingTranslations, translationRows } from '../translations.js'
import { Icon, type IconName } from '../views/icons.js'
import { adminPage, initials, Time } from '../views/layout.js'
import { sourceLabel, StatusBadge } from '../views/status.js'

const DAY_MS = 24 * 60 * 60 * 1000
const TILE_COLLECTIONS = 2
const ACTIVITY_LIMIT = 30

const editorLink = (doc: DocumentSummary) => `/admin/documents/${encodeURIComponent(doc.id)}`

type Pending = Array<{ document: DocumentSummary; isNew: boolean; lines: string[] }>

function typeLabel(ctx: AdminContext, type: string): string {
  return ctx.core.registry.types.get(type)?.label ?? type
}

function AddNew({ ctx }: { ctx: AdminContext }) {
  return (
    <details class="dropdown dropdown-end">
      <summary class="btn btn-sm">
        <Icon name="plus" />
        {t('admin.dashboard.addNew')}
        <Icon name="chevron-down" class="opacity-60" />
      </summary>
      <ul class="dropdown-content menu menu-sm z-20 mt-1 w-48 rounded-box border border-base-300 bg-base-100 p-1 shadow-lg">
        {ctx.core.registry.site.collections.map((c) => (
          <li>
            <a href={`/admin/collections/${encodeURIComponent(c.name)}/new`}>{c.label}</a>
          </li>
        ))}
        <li>
          <a href="/admin/media?sheet=upload">{t('admin.dashboard.upload')}</a>
        </li>
      </ul>
    </details>
  )
}

interface TileProps {
  href: string
  label: string
  icon: IconName
  /** A literal color class for the icon. */
  iconClass?: string
  value: Renderable
  note?: string | undefined
}

function Tile({ href, label, icon, iconClass, value, note }: TileProps) {
  return (
    <a href={href} class="rounded-box border border-base-300 bg-base-100 p-4 hover:border-base-content/20">
      <div class="flex items-center justify-between gap-2 text-sm text-base-content/70">
        {label}
        <Icon name={icon} {...(iconClass !== undefined && { class: iconClass })} />
      </div>
      <div class="mt-1 truncate text-2xl font-semibold tabular-nums">{value}</div>
      {note !== undefined && <div class="text-xs text-base-content/60">{note}</div>}
    </a>
  )
}

/** The newest backup, `null` when there is none, or `undefined` when the tile is left out (editors, or no backups folder). */
async function lastBackup(ctx: AdminContext, actor: Actor): Promise<BackupInfo | null | undefined> {
  if (actor.role !== 'owner') return undefined
  const asCtx: Ctx = { actor, source: 'admin' }
  try {
    return (await ctx.core.listBackups(asCtx))[0] ?? null
  } catch (e) {
    if (e instanceof InlayError && e.messageId === 'config.backupsMissing') return undefined
    throw e
  }
}

function BackupTile({ backup, now }: { backup: BackupInfo | null; now: Date }) {
  const label = t('admin.dashboard.tile.lastBackup')
  if (backup === null) {
    return <Tile href="/admin/backups" label={label} icon="alert" iconClass="text-error" value={t('admin.dashboard.tile.noBackup')} />
  }
  const old = now.getTime() - Date.parse(backup.createdAt) > 2 * DAY_MS
  const kind = t(`admin.backups.reason.${backup.reason}`)
  return (
    <Tile
      href="/admin/backups"
      label={label}
      icon={old ? 'alert' : 'check-circle'}
      {...(old && { iconClass: 'text-error' })}
      value={<Time iso={backup.createdAt} relative />}
      note={old ? `${kind} · ${t('admin.dashboard.tile.backupOld')}` : kind}
    />
  )
}

function PendingRow({ ctx, item }: { ctx: AdminContext; item: Pending[number] }) {
  const { document, isNew, lines } = item
  const id = `pending-${document.id}`
  const first = isNew ? t('admin.dashboard.pending.new') : lines[0]
  const meta = [typeLabel(ctx, document.type), document.locale, ...(first !== undefined ? [first] : [])].join(' · ')
  const more = isNew ? 0 : lines.length - 1
  return (
    <li class="flex items-center gap-3 px-4 py-2.5">
      <input type="checkbox" name="ids" value={document.id} id={id} checked class="checkbox checkbox-sm" />
      <label for={id} class="sr-only">
        {t('admin.dashboard.pending.select', { title: document.title, locale: document.locale })}
      </label>
      <div class="min-w-0 flex-1">
        <a href={editorLink(document)} class="font-medium hover:underline">
          {document.title}
        </a>
        <div class="truncate text-xs text-base-content/60">{meta}</div>
        {more > 0 && <div class="text-xs text-base-content/60">{t('admin.dashboard.pending.more', { count: more })}</div>}
      </div>
      <StatusBadge doc={document} />
      <span class="hidden w-28 shrink-0 text-right text-xs text-base-content/60 sm:block">
        <Time iso={document.updatedAt} relative />
      </span>
    </li>
  )
}

function PendingCard({ ctx, pending, wide }: { ctx: AdminContext; pending: Pending; wide: boolean }) {
  const span = wide ? 'rounded-box border border-base-300 bg-base-100 lg:col-span-3' : 'rounded-box border border-base-300 bg-base-100 lg:col-span-2'
  const heading = (
    <div>
      <h2 id="pending-heading" class="font-semibold">
        {t('admin.dashboard.pending.title')}
      </h2>
      {pending.length > 0 && <p class="text-xs text-base-content/60">{t('admin.dashboard.pending.intro')}</p>}
    </div>
  )
  if (pending.length === 0) {
    return (
      <section aria-labelledby="pending-heading" class={span}>
        <div class="border-b border-base-300 px-4 py-3">{heading}</div>
        <p class="px-4 py-3 text-sm">{t('admin.dashboard.pending.empty')}</p>
      </section>
    )
  }
  return (
    <section aria-labelledby="pending-heading" class={span}>
      <form method="get" action="/admin/publish">
        {/* Sends `ids` even with every box unticked, so the review page says nothing was chosen. */}
        <input type="hidden" name="ids" value="" />
        <div class="flex items-center justify-between gap-4 border-b border-base-300 px-4 py-3">
          {heading}
          <button type="submit" data-publish-dialog class="btn btn-primary btn-sm">
            {t('admin.dashboard.pending.submit')}
          </button>
        </div>
        <ul class="divide-y divide-base-300">
          {pending.map((item) => (
            <PendingRow ctx={ctx} item={item} />
          ))}
        </ul>
      </form>
    </section>
  )
}

function AttentionCard({ items }: { items: AttentionItem[] }) {
  return (
    <section aria-labelledby="attention-heading" class="rounded-box border border-base-300 bg-base-100">
      <div class="border-b border-base-300 px-4 py-3">
        <h2 id="attention-heading" class="font-semibold">
          {t('admin.attention.title')}
        </h2>
      </div>
      <ul class="divide-y divide-base-300 text-sm">
        {items.map((item) => (
          <li class="flex items-start gap-3 px-4 py-3">
            <Icon name={item.icon} class="mt-0.5 text-base-content/60" />
            <a href={item.href} class="hover:underline">
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Where a type's gapped documents are listed: its collection (in their language, when they are all in one), or the
 * pages or site-wide content list.
 */
function gapsHref(ctx: AdminContext, gap: GapSummary): string {
  const kind = ctx.core.registry.types.get(gap.type)?.kind
  if (kind === 'singleton') return '/admin/pages'
  if (kind === 'global') return '/admin/globals'
  const href = `/admin/collections/${encodeURIComponent(gap.type)}`
  const locales = Object.keys(gap.locales)
  const only = locales.length === 1 ? locales[0] : undefined
  return only === undefined || only === ctx.core.registry.defaultLocale ? href : `${href}?locale=${encodeURIComponent(only)}`
}

function GapsCard({ ctx, gaps }: { ctx: AdminContext; gaps: GapSummary[] }) {
  return (
    <section aria-labelledby="gaps-heading" class="rounded-box border border-base-300 bg-base-100">
      <div class="border-b border-base-300 px-4 py-3">
        <h2 id="gaps-heading" class="font-semibold">
          {t('admin.gaps.title')}
        </h2>
        <p class="text-xs text-base-content/60">{t('admin.gaps.intro')}</p>
      </div>
      <ul class="divide-y divide-base-300 text-sm">
        {gaps.map((gap) => (
          <li class="flex items-start gap-3 px-4 py-3">
            <Icon name="alert" class="mt-0.5 text-base-content/60" />
            <a href={gapsHref(ctx, gap)} class="hover:underline">
              {t('admin.gaps.summary', { label: gap.label, count: gap.documents })}
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

function via(source: Activity['source']): string {
  if (source === 'mcp') return t('admin.activity.viaAssistant')
  if (source === 'admin') return ''
  return t('admin.activity.viaSource', { source: sourceLabel(source) })
}

const joined = (...parts: string[]) => parts.filter((part) => part !== '').join(' ')

function LineText({ ctx, line }: { ctx: AdminContext; line: ActivityLine }) {
  switch (line.kind) {
    case 'edit': {
      const type = ctx.core.registry.types.get(line.document.type)
      const tail = joined(via(line.source), line.count > 1 ? t('admin.activity.edits', { count: line.count }) : '')
      return (
        <>
          <a href={editorLink(line.document)} class="hover:underline">
            {t('admin.activity.changed', { name: line.authorName, title: line.document.title })}
          </a>
          {type?.kind === 'collection' && <span class="text-base-content/60"> {t('admin.activity.in', { type: type.label })}</span>}
          {tail !== '' && ` ${tail}`}
        </>
      )
    }
    case 'edits': {
      const params = { name: line.authorName, count: line.documents.length }
      if (line.source === 'release') return <>{t('admin.activity.shipped', { count: params.count })}</>
      return <>{joined(t('admin.activity.changedMany', params), via(line.source))}</>
    }
    case 'publish':
    case 'unpublish': {
      const main = t(line.kind === 'publish' ? 'admin.activity.published' : 'admin.activity.unpublished', {
        name: line.authorName,
        titles: line.documents.map((d) => d.title).join(', '),
      })
      return <>{joined(main, via(line.source))}</>
    }
  }
}

function ActivityCard({ ctx, activity, now }: { ctx: AdminContext; activity: Activity[]; now: Date }) {
  const days = groupActivity(activity, now)
  return (
    <section aria-labelledby="activity-heading" class="rounded-box border border-base-300 bg-base-100 lg:col-span-3">
      <div class="border-b border-base-300 px-4 py-3">
        <h2 id="activity-heading" class="font-semibold">
          {t('admin.dashboard.activity.title')}
        </h2>
      </div>
      {days.length === 0 ? (
        <p class="px-4 py-3 text-sm">{t('admin.dashboard.activity.empty')}</p>
      ) : (
        days.map(({ day, lines }) => (
          <div>
            <h3 class="border-b border-base-300 bg-base-200/50 px-4 py-1.5 text-xs font-medium text-base-content/60">{day}</h3>
            <ul class="divide-y divide-base-300">
              {lines.map((line) => (
                <li class="flex items-center gap-3 px-4 py-2">
                  <span aria-hidden="true" class="grid size-7 shrink-0 place-items-center rounded-full bg-neutral text-xs text-neutral-content">
                    {initials(line.authorName)}
                  </span>
                  <div class="min-w-0 flex-1 text-sm">
                    <LineText ctx={ctx} line={line} />
                  </div>
                  <span class="shrink-0 text-xs text-base-content/60">
                    <Time iso={line.at} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  )
}

/** `GET /admin`: counts at a glance, what is waiting to be published, what needs attention, and what changed lately. */
export function registerDashboard(scope: FastifyInstance, ctx: AdminContext): void {
  const { core } = ctx
  const { registry } = core
  scope.get('/admin', async (request, reply) => {
    const actor = adminActor(request)
    const now = ctx.now()
    const multilingual = registry.locales.length > 1
    const pageRows = multilingual ? await translationRows(ctx, registry.site.singletons) : []
    const [waiting, activity, counts, media, attention, backup, gaps] = await Promise.all([
      core.listPendingChanges(),
      core.recentActivity({ limit: ACTIVITY_LIMIT }),
      core.countEntries({ changedSince: new Date(now.getTime() - 7 * DAY_MS).toISOString() }),
      core.mediaStats(),
      needsAttention(ctx, { singletons: pageRows }),
      lastBackup(ctx, actor),
      core.gapSummary(),
    ])
    const pending: Pending = waiting.length > 0 ? await core.describeChanges(waiting.map((d) => d.id)) : []
    const untranslated = new Set(missingTranslations(pageRows).map((m) => m.def.name)).size
    const pagesNote = !multilingual
      ? undefined
      : untranslated > 0
        ? t('admin.dashboard.tile.untranslated', { count: untranslated })
        : t('admin.dashboard.tile.allTranslated')

    const body = (
      <div class="flex flex-col gap-6">
        <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {registry.site.collections.slice(0, TILE_COLLECTIONS).map((c) => {
            const count = counts[c.name] ?? { total: 0, changed: 0 }
            return (
              <Tile
                href={`/admin/collections/${encodeURIComponent(c.name)}`}
                label={c.label}
                icon="collection"
                value={count.total}
                note={t('admin.dashboard.tile.changed', { count: count.changed })}
              />
            )
          })}
          <Tile href="/admin/pages" label={t('admin.nav.pages')} icon="file" value={registry.site.singletons.length} note={pagesNote} />
          <Tile
            href="/admin/media"
            label={t('admin.nav.media')}
            icon="image"
            value={media.count}
            note={t('admin.dashboard.tile.mediaSize', { size: formatSize(media.totalBytes) })}
          />
          {backup !== undefined && <BackupTile backup={backup} now={now} />}
        </div>
        <div class="grid gap-6 lg:grid-cols-3">
          <PendingCard ctx={ctx} pending={pending} wide={attention.length === 0 && gaps.length === 0} />
          {(attention.length > 0 || gaps.length > 0) && (
            <div class="flex flex-col gap-6 lg:col-span-1">
              {gaps.length > 0 && <GapsCard ctx={ctx} gaps={gaps} />}
              {attention.length > 0 && <AttentionCard items={attention} />}
            </div>
          )}
          <ActivityCard ctx={ctx} activity={activity} now={now} />
        </div>
      </div>
    )
    const notice = noticeOf(request.query)
    const page = await adminPage(
      ctx,
      {
        title: t('admin.nav.dashboard'),
        actor,
        section: 'dashboard',
        description: t('admin.signedInAs', { name: actor.name, role: t(actor.role === 'owner' ? 'role.owner' : 'role.editor') }),
        actions: <AddNew ctx={ctx} />,
        ...(notice !== undefined && { notice }),
      },
      body,
    )
    return reply.code(200).type(HTML).send(page)
  })
}
