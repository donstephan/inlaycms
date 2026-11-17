import { t } from '../../../core/messages/index.js'
import type { Actor } from '../../../core/types.js'
import { raw, renderToString, type Renderable } from '../../../jsx/html.js'
import type { AssetName } from '../assets.js'
import type { AdminContext, Section } from '../context.js'
import { Icon, type IconName } from './icons.js'
import { Badge, badgeClass } from './status.js'

const HTMX_CONFIG = JSON.stringify({
  allowEval: false,
  allowScriptTags: false,
  includeIndicatorStyles: false,
  selfRequestsOnly: true,
})

/** A message under a workspace page's heading: a thin full-width bar. */
const BAR = 'shrink-0 rounded-none border-x-0 border-t-0 px-4 py-1.5 text-sm'

const UTC = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })

function Head({ ctx, title, scripts }: { ctx: AdminContext; title: string; scripts: readonly AssetName[] }) {
  const { theme, name } = ctx.branding
  return (
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <meta name="htmx-config" content={HTMX_CONFIG} />
      <title>{t('admin.pageTitle', { title, name })}</title>
      <link rel="stylesheet" href={ctx.assets.url('admin.css')} />
      {theme.css !== '' && <style>{raw(theme.css)}</style>}
      {scripts.map((script) => (
        <script type="module" src={ctx.assets.url(script)}></script>
      ))}
    </head>
  )
}

function SkipLink() {
  return (
    <a href="#main" class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 btn btn-primary">
      {t('admin.skipLink')}
    </a>
  )
}

/** The logo with the brand name as its text, or the name itself. */
function Brand({ ctx, size = 'h-10 max-w-full' }: { ctx: AdminContext; size?: string }) {
  const { name, logo } = ctx.branding
  return logo !== undefined ? (
    <img src={logo} alt={name} class={`${size} w-auto`} />
  ) : (
    <span class="text-lg font-semibold">{name}</span>
  )
}

interface NavItem {
  section: Section
  href: string
  label: string
  icon: IconName
  count?: number
}

interface NavGroups {
  top: NavItem[]
  sections: { title: string; items: NavItem[] }[]
}

/** The sections `actor` may visit, grouped as in the menu; collections carry their entry counts. */
function navItems(ctx: AdminContext, actor: Actor, counts: Record<string, { total: number }>): NavGroups {
  const { site } = ctx.core.registry
  const top: NavItem[] = [{ section: 'dashboard', href: '/admin', label: t('admin.nav.dashboard'), icon: 'dashboard' }]
  const content: NavItem[] = []
  const blocks: NavItem[] = []
  const custom = new Map<string, NavItem[]>()
  if (site.singletons.length > 0) content.push({ section: 'pages', href: '/admin/pages', label: t('admin.nav.pages'), icon: 'file' })
  if (site.globals.length > 0) content.push({ section: 'globals', href: '/admin/globals', label: t('admin.nav.globals'), icon: 'globe' })
  const contentTitle = t('admin.nav.content')
  const blocksTitle = t('admin.nav.blocks')
  for (const collection of site.collections) {
    const item: NavItem = {
      section: `collection:${collection.name}`,
      href: `/admin/collections/${encodeURIComponent(collection.name)}`,
      label: collection.label,
      icon: 'collection',
      count: counts[collection.name]?.total ?? 0,
    }
    const group = collection.group?.trim() ?? ''
    const hasPages = collection.route !== null || collection.customPaths
    if (group === contentTitle || (group === '' && hasPages)) content.push(item)
    else if (group === blocksTitle || group === '') blocks.push(item)
    else custom.set(group, [...(custom.get(group) ?? []), item])
  }
  content.push({ section: 'media', href: '/admin/media', label: t('admin.nav.media'), icon: 'image' })
  const siteItems: NavItem[] = [{ section: 'redirects', href: '/admin/redirects', label: t('admin.nav.redirects'), icon: 'redirect' }]
  if (actor.role === 'owner') {
    siteItems.push({ section: 'users', href: '/admin/users', label: t('admin.nav.users'), icon: 'users' })
    siteItems.push({ section: 'backups', href: '/admin/backups', label: t('admin.nav.backups'), icon: 'archive' })
    if (ctx.db !== undefined && ctx.releasesDir !== undefined) {
      siteItems.push({ section: 'releases', href: '/admin/releases', label: t('admin.nav.releases'), icon: 'rocket' })
    }
    siteItems.push({ section: 'security', href: '/admin/security', label: t('admin.nav.security'), icon: 'lock' })
  }
  const sections = [
    { title: contentTitle, items: content },
    ...[...custom].map(([title, items]) => ({ title, items })),
    { title: blocksTitle, items: blocks },
    { title: t('admin.nav.site'), items: siteItems },
  ]
  return { top, sections }
}

function NavLink({ item, section }: { item: NavItem; section: Section | undefined }) {
  const current = item.section === section
  return (
    <li>
      <a href={item.href} aria-current={current ? 'page' : undefined} class={current ? 'menu-active' : undefined}>
        <Icon name={item.icon} />
        <span class="truncate">{item.label}</span>
        {item.count !== undefined && (
          <Badge tone="ghost" class="ml-auto tabular-nums">
            {item.count}
          </Badge>
        )}
      </a>
    </li>
  )
}

/** Up to two initials from `name` (its first and last words), for the small circle next to a person. */
export function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .map((word) => Array.from(word)[0] ?? '')
    .filter((letter) => letter !== '')
  const first = letters[0] ?? '?'
  const last = letters.length > 1 ? (letters[letters.length - 1] ?? '') : ''
  return `${first}${last}`.toUpperCase()
}

function PersonMenu({ actor, section }: { actor: Actor; section: Section | undefined }) {
  const current = section === 'account'
  return (
    <details class="dropdown dropdown-top w-full">
      <summary class="flex w-full cursor-pointer list-none items-center gap-3 rounded-field px-2 py-2 hover:bg-base-200">
        <span aria-hidden="true" class="grid size-8 shrink-0 place-items-center rounded-full bg-neutral text-xs text-neutral-content">
          {initials(actor.name)}
        </span>
        <span class="min-w-0 flex-1 text-left">
          <span class="block truncate text-sm font-medium">{actor.name}</span>
          <span class="block truncate text-xs text-base-content/60">
            {actor.role === 'owner' ? t('admin.users.role.owner') : t('admin.users.role.editor')}
          </span>
        </span>
        <Icon name="updown" class="opacity-60" />
      </summary>
      <ul class="dropdown-content menu menu-sm z-50 mb-1 w-full rounded-box border border-base-300 bg-base-100 p-1 shadow-lg">
        <li>
          <a href="/admin/account" aria-current={current ? 'page' : undefined} class={current ? 'menu-active' : undefined}>
            <Icon name="user" />
            {t('admin.nav.account')}
          </a>
        </li>
        <li>
          <form method="post" action="/admin/logout" class="p-0">
            <button type="submit" class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1 text-start">
              <Icon name="logout" />
              {t('auth.logout')}
            </button>
          </form>
        </li>
      </ul>
    </details>
  )
}

function Nav({
  ctx,
  actor,
  section,
  counts,
}: {
  ctx: AdminContext
  actor: Actor
  section: Section | undefined
  counts: Record<string, { total: number }>
}) {
  const groups = navItems(ctx, actor, counts)
  return (
    <nav aria-label={t('admin.nav.label')} class="flex flex-1 flex-col">
      <ul class="menu menu-sm w-full flex-1 gap-0.5 px-2 py-3">
        {groups.top.map((item) => (
          <NavLink item={item} section={section} />
        ))}
        {groups.sections
          .filter((group) => group.items.length > 0)
          .map((group, i) => (
            <li>
              <span id={`admin-nav-group-${i}`} class="menu-title mt-3 text-xs">
                {group.title}
              </span>
              <ul aria-labelledby={`admin-nav-group-${i}`} class="ms-0 flex flex-col gap-0.5 ps-0 before:hidden">
                {group.items.map((item) => (
                  <NavLink item={item} section={section} />
                ))}
              </ul>
            </li>
          ))}
      </ul>
      <div class="border-t border-base-300 p-2">
        <PersonMenu actor={actor} section={section} />
      </div>
    </nav>
  )
}

/** A small badge saying the site needs a password; a link to the Security page for owners. */
function PrivateBadge({ owner }: { owner: boolean }) {
  const content = (
    <>
      <Icon name="lock" class="size-3.5" />
      <span aria-hidden="true">{t('admin.security.badge')}</span>
      <span class="sr-only">{t('admin.security.banner')}</span>
    </>
  )
  const cls = `${badgeClass('info', 'md')} whitespace-nowrap`
  return owner ? (
    <a href="/admin/security" data-private-badge class={cls} title={t('admin.security.banner')}>
      {content}
    </a>
  ) : (
    <span role="status" data-private-badge class={cls} title={t('admin.security.banner')}>
      {content}
    </span>
  )
}

/** The bar along the top: the menu button on small screens, the search box, the private-site badge, View site and Publish. */
function TopBar({ pending, locked, owner }: { pending: number; locked: boolean; owner: boolean }) {
  return (
    <div class="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-base-300 bg-base-100 px-4 lg:px-6">
      <label for="admin-nav-toggle" class="btn btn-ghost btn-sm btn-square lg:hidden">
        <Icon name="menu" />
        <span class="sr-only">{t('admin.nav.open')}</span>
      </label>
      <form role="search" action="/admin/search" method="get" class="relative w-full max-w-lg">
        <label for="global-search" class="input input-sm w-full border-transparent bg-base-200 focus-within:border-base-300 focus-within:bg-base-100">
          <Icon name="search" class="opacity-60" />
          <span class="sr-only">{t('admin.search.label')}</span>
          <input
            id="global-search"
            name="q"
            type="search"
            class="grow"
            placeholder={t('admin.search.placeholder')}
            autocomplete="off"
            role="combobox"
            aria-expanded="false"
            aria-controls="global-search-results"
            aria-autocomplete="list"
            hx-get="/admin/search"
            hx-trigger="input changed delay:250ms, focus"
            hx-target="#global-search-results"
            hx-select="#global-search-results"
            hx-swap="outerHTML"
          />
          <kbd aria-hidden="true" class="kbd kbd-sm">
            /
          </kbd>
        </label>
        <button type="submit" class="btn btn-sm sr-only focus:not-sr-only focus:absolute focus:right-0 focus:top-0">
          {t('admin.search.submit')}
        </button>
        <div id="global-search-results"></div>
      </form>
      <div class="ml-auto flex items-center gap-2">
        {locked && <PrivateBadge owner={owner} />}
        <a href="/" class="btn btn-ghost btn-sm hidden sm:inline-flex">
          <Icon name="external" />
          {t('admin.topbar.viewSite')}
        </a>
        <a id="topbar-publish" href="/admin/publish" data-publish-dialog data-refresh class="btn btn-primary btn-sm">
          <Icon name="send" />
          {t('admin.topbar.publish')}
          {pending > 0 && (
            <span aria-hidden="true" class="badge badge-sm border-0 bg-primary-content/20 text-primary-content tabular-nums">
              {pending}
            </span>
          )}
          {pending > 0 && <span class="sr-only">{t('admin.topbar.pending', { count: pending })}</span>}
        </a>
      </div>
    </div>
  )
}

function Breadcrumbs({ items, compact }: { items: ReadonlyArray<{ label: string; href: string }>; compact?: boolean }) {
  if (items.length === 0) return null
  return (
    <nav aria-label={t('admin.breadcrumbs')} class={compact === true ? 'breadcrumbs p-0 text-xs text-base-content/70' : 'breadcrumbs text-sm'}>
      <ul>
        {items.map((item) => (
          <li>
            <a href={item.href}>{item.label}</a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

/** The icon beside the publish dialog's heading for each state of `#publish-panel`; states not listed have none. */
const PUBLISH_ICONS: Array<{ state: string; icon: IconName; tone: string }> = [
  { state: 'review', icon: 'send', tone: 'bg-primary text-primary-content' },
  { state: 'unpublish', icon: 'x', tone: 'bg-base-200' },
  { state: 'done', icon: 'check-circle', tone: 'bg-success text-success-content' },
  { state: 'problems', icon: 'alert', tone: 'bg-error text-error-content' },
  { state: 'changed', icon: 'refresh', tone: 'bg-warning text-warning-content' },
]

/**
 * The one dialog every publish and unpublish button opens in: `client/admin/publish.ts` loads the publish page's
 * `#publish-panel` into its body. Without JS, those buttons go to the publish page itself.
 */
export function PublishDialog() {
  return (
    <dialog id="publish-dialog" aria-labelledby="publish-dialog-title" class="modal">
      <div class="modal-box flex max-w-xl flex-col gap-4">
        <div class="flex items-center gap-3">
          {PUBLISH_ICONS.map(({ state, icon, tone }) => (
            <span data-state-icon={state} hidden class={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${tone}`}>
              <Icon name={icon} />
            </span>
          ))}
          <h2 id="publish-dialog-title" class="min-w-0 flex-1 text-lg font-semibold">
            {t('admin.publish.title')}
          </h2>
          <form method="dialog">
            <button type="submit" class="btn btn-ghost btn-sm btn-square" aria-label={t('admin.publish.close')}>
              <Icon name="x" />
            </button>
          </form>
        </div>
        <div data-publish-loading hidden class="flex items-center gap-2 text-sm text-base-content/70">
          <span class="loading loading-spinner loading-sm"></span>
          {t('admin.publish.loading')}
        </div>
        <div id="publish-dialog-body"></div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button type="submit" tabindex="-1">
          {t('admin.publish.close')}
        </button>
      </form>
    </dialog>
  )
}

/** The one dialog every picker opens in; `client/admin/picker.ts` loads a picker fragment into its body. */
function PickerDialog() {
  return (
    <dialog id="inlay-picker" aria-labelledby="inlay-picker-title" class="modal">
      <div class="modal-box flex max-w-3xl flex-col gap-4">
        <div class="flex items-center justify-between gap-4">
          <h2 id="inlay-picker-title" class="text-lg font-semibold">
            {t('admin.picker.title')}
          </h2>
          <form method="dialog">
            <button type="submit" class="btn btn-ghost btn-sm">
              {t('admin.picker.close')}
            </button>
          </form>
        </div>
        <div id="inlay-picker-body"></div>
      </div>
    </dialog>
  )
}

export interface AdminPageOptions {
  title: string
  actor: Actor
  section?: Section
  /** A success message, from `noticeOf`. Not shown when `status` is an error. */
  notice?: string
  /** The status the page is sent with. */
  status?: number
  scripts?: Array<'editor.js'>
  breadcrumbs?: Array<{ label: string; href: string }>
  /** A line under the heading saying what the page is for. */
  description?: string
  /** The page's main action(s), on the right of the heading. */
  actions?: Renderable
  /**
   * `workspace`: a full-height page whose heading is a compact bar and whose `body` fills the rest of the screen, for
   * screens that scroll their own panes (the editor).
   */
  layout?: 'workspace'
}

/**
 * A signed-in admin page: the menu on the left (a drawer on small screens), the top bar, and `body` under the page's
 * one heading.
 */
export async function adminPage(ctx: AdminContext, opts: AdminPageOptions, body: Renderable): Promise<string> {
  const scripts: AssetName[] = ['admin.js', ...(opts.scripts ?? [])]
  const notice = (opts.status ?? 200) < 400 ? opts.notice : undefined
  const [counts, pending, lock] = await Promise.all([ctx.core.countEntries(), ctx.core.listPendingChanges(), ctx.core.siteLock()])
  const workspace = opts.layout === 'workspace'
  const page = (
    <html lang="en" data-theme={ctx.branding.theme.name}>
      <Head ctx={ctx} title={opts.title} scripts={scripts} />
      <body class="min-h-screen bg-base-200 text-base-content">
        <SkipLink />
        <div class="drawer lg:drawer-open">
          <input id="admin-nav-toggle" type="checkbox" class="drawer-toggle lg:hidden" aria-label={t('admin.nav.open')} />
          <div class={workspace ? 'drawer-content flex h-screen flex-col' : 'drawer-content flex min-h-screen flex-col'}>
            <TopBar pending={pending.length} locked={lock.enabled} owner={opts.actor.role === 'owner'} />
            <main id="main" tabindex="-1" class={workspace ? 'flex min-h-0 w-full flex-1 flex-col focus:outline-none' : 'w-full flex-1 px-4 py-4 focus:outline-none lg:px-6 lg:py-5'}>
              <div
                class={
                  workspace
                    ? 'flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-base-300 bg-base-100 px-4 py-2.5'
                    : 'mb-5 flex flex-wrap items-end justify-between gap-4'
                }
              >
                <div class="min-w-0">
                  <Breadcrumbs items={opts.breadcrumbs ?? []} compact={workspace} />
                  <h1 class={workspace ? 'truncate text-lg font-semibold tracking-tight' : 'text-2xl font-semibold tracking-tight'}>{opts.title}</h1>
                  {opts.description !== undefined && <p class="text-sm text-base-content/70">{opts.description}</p>}
                </div>
                {opts.actions !== undefined && (
                  <div class={workspace ? 'flex min-w-0 flex-1 flex-wrap items-center gap-2' : 'flex flex-wrap items-center gap-2'}>{opts.actions}</div>
                )}
              </div>
              {ctx.readOnly && (
                <div role="status" class={workspace ? `alert alert-info ${BAR}` : 'alert alert-info mb-4'}>
                  {ctx.release ? t('admin.readOnly', { name: ctx.release.name }) : t('admin.readOnly.unnamed')}
                </div>
              )}
              <noscript>
                <p class={workspace ? `alert alert-warning ${BAR}` : 'alert alert-warning mb-4'}>{t('admin.noscript')}</p>
              </noscript>
              {notice !== undefined && (
                <div role="status" class={workspace ? `alert alert-success ${BAR}` : 'alert alert-success mb-4'}>
                  {notice}
                </div>
              )}
              {workspace ? <div class="flex min-h-0 flex-1 flex-col">{body}</div> : body}
            </main>
          </div>
          <div class="drawer-side z-40">
            <label for="admin-nav-toggle" aria-label={t('admin.nav.close')} class="drawer-overlay">
              <span class="sr-only">{t('admin.nav.close')}</span>
            </label>
            <aside class="flex min-h-full w-64 flex-col border-r border-base-300 bg-base-100">
              <header class="flex h-14 shrink-0 items-center border-b border-base-300 px-4">
                <a href="/admin" class="inline-flex min-w-0 items-center">
                  <Brand ctx={ctx} size="h-7 max-w-40" />
                </a>
              </header>
              <Nav ctx={ctx} actor={opts.actor} section={opts.section} counts={counts} />
            </aside>
          </div>
        </div>
        <PickerDialog />
        <PublishDialog />
      </body>
    </html>
  )
  return `<!doctype html>${await renderToString(page)}`
}

/** A page for someone who isn't signed in (setup, login, consent, uploads): a centered card with the brand, no navigation. */
export async function authPage(ctx: AdminContext, title: string, body: Renderable): Promise<string> {
  const page = (
    <html lang="en" data-theme={ctx.branding.theme.name}>
      <Head ctx={ctx} title={title} scripts={['admin.js']} />
      <body class="min-h-screen bg-base-200 text-base-content">
        <SkipLink />
        <main id="main" tabindex="-1" class="flex min-h-screen items-center justify-center p-4 focus:outline-none">
          <div class="card w-full max-w-lg bg-base-100 shadow-md">
            <div class="card-body gap-4">
              <header>
                <Brand ctx={ctx} />
              </header>
              <h1 class="text-2xl font-bold">{title}</h1>
              {body}
            </div>
          </div>
        </main>
      </body>
    </html>
  )
  return `<!doctype html>${await renderToString(page)}`
}

/** A time in UTC, which `admin.js` rewrites into the reader's own time zone. */
export function Time({ iso, relative }: { iso: string; relative?: boolean }) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return <time>{iso}</time>
  const text = t('admin.time.utc', { time: UTC.format(date) })
  return (
    <time datetime={iso} data-local data-relative={relative === true ? true : undefined} title={relative === true ? text : undefined}>
      {text}
    </time>
  )
}

/** A message box; an error is announced as an alert. */
export function Alert({ kind, id, children }: { kind: 'error' | 'warning' | 'info'; id?: string; children?: Renderable }) {
  const style = kind === 'error' ? 'alert alert-error' : kind === 'warning' ? 'alert alert-warning' : 'alert alert-info'
  return (
    <div id={id} role={kind === 'error' ? 'alert' : undefined} class={style}>
      {children}
    </div>
  )
}
