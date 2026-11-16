import type { FastifyInstance } from 'fastify'
import { formatSize } from '../../../core/media/labels.js'
import { t } from '../../../core/messages/index.js'
import type { GlobalDef, SingletonDef } from '../../../core/registry/define.js'
import { singletonPath } from '../../../core/site/paths.js'
import type { DocumentSummary } from '../../../core/types.js'
import { renderToString, type Renderable } from '../../../jsx/html.js'
import { adminActor, HTML, type AdminContext } from '../context.js'
import { adminPage } from '../views/layout.js'
import { documentStatus, StatusLabel, type DocumentStatus } from '../views/status.js'

export interface SearchHit {
  title: string
  detail: string
  href: string
  status?: DocumentStatus
}

export interface SearchGroup {
  label: string
  total: number
  seeAll: string | null
  hits: SearchHit[]
}

/** How many hits of each group the top bar's list shows. */
const SHOWN = 4
const LIMIT = 50
const RECENT = 6

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Lower-case text without accents, for matching a search. */
const fold = (text: string): string => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()

const editorLink = (doc: DocumentSummary) => `/admin/documents/${encodeURIComponent(doc.id)}`

const docHit = (doc: DocumentSummary, detail = ''): SearchHit => ({
  title: doc.title,
  detail,
  href: editorLink(doc),
  status: documentStatus(doc),
})

const group = (label: string, hits: SearchHit[], seeAll: string | null): SearchGroup => ({ label, total: hits.length, seeAll, hits })

/** The pages or site-wide items whose name or title (in the default language) has every word of the search. */
async function matchDefs(
  ctx: AdminContext,
  defs: ReadonlyArray<SingletonDef | GlobalDef>,
  words: readonly string[],
): Promise<SearchHit[]> {
  const { core } = ctx
  const { defaultLocale } = core.registry
  const hits: SearchHit[] = []
  for (const def of defs) {
    const doc = await core.findSingleton(def.name, defaultLocale)
    if (!doc) continue
    const text = fold(`${def.label} ${doc.title}`)
    if (!words.every((word) => text.includes(word))) continue
    const address = def.kind === 'singleton' ? singletonPath(def, defaultLocale, defaultLocale) : null
    hits.push(docHit(doc, address ?? ''))
  }
  return hits
}

/** The documents edited most recently, newest first. */
async function recentGroup(ctx: AdminContext): Promise<SearchGroup> {
  const seen = new Set<string>()
  const hits: SearchHit[] = []
  for (const item of await ctx.core.recentActivity({ limit: 20 })) {
    if (item.kind !== 'edit' || seen.has(item.document.id)) continue
    seen.add(item.document.id)
    hits.push(docHit(item.document))
    if (hits.length === RECENT) break
  }
  return group(t('admin.search.recent'), hits, null)
}

/**
 * Everything matching `q`, grouped: Pages, Site-wide content, each collection, then Media. Groups without hits are
 * left out. An empty `q` gives the recently changed documents instead.
 */
export async function searchAll(ctx: AdminContext, q: string): Promise<SearchGroup[]> {
  const { core } = ctx
  const { site } = core.registry
  const query = q.trim()
  if (query === '') return [await recentGroup(ctx)].filter((g) => g.hits.length > 0)
  const words = fold(query)
    .split(/\s+/)
    .filter((word) => word !== '')
  const encoded = encodeURIComponent(query)

  const groups: SearchGroup[] = [
    group(t('admin.nav.pages'), await matchDefs(ctx, site.singletons, words), null),
    group(t('admin.nav.globals'), await matchDefs(ctx, site.globals, words), null),
  ]
  for (const collection of site.collections) {
    const found = await core.searchEntries(collection.name, query, { limit: LIMIT })
    groups.push(
      group(
        collection.label,
        found.map((doc) => docHit(doc)),
        `/admin/collections/${encodeURIComponent(collection.name)}?q=${encoded}`,
      ),
    )
  }
  const media = await core.listMedia({ search: query, limit: LIMIT })
  groups.push(
    group(
      t('admin.nav.media'),
      media.map((m) => ({ title: m.filename, detail: formatSize(m.size), href: `/admin/media/${encodeURIComponent(m.id)}` })),
      `/admin/media?q=${encoded}`,
    ),
  )
  return groups.filter((g) => g.hits.length > 0)
}

function HitBody({ hit }: { hit: SearchHit }) {
  return (
    <>
      <span class="min-w-0 truncate font-medium">{hit.title}</span>
      {hit.detail !== '' && <span class="min-w-0 truncate text-xs text-base-content/60">{hit.detail}</span>}
      {hit.status !== undefined && (
        <span class="ml-auto shrink-0">
          <StatusLabel status={hit.status} />
        </span>
      )}
    </>
  )
}

const None = ({ q }: { q: string }) => <p class="px-4 py-6 text-center text-sm text-base-content/70">{t('admin.search.none', { query: q })}</p>

/**
 * The top bar's dropdown: at most four hits a group, as a listbox the search box controls, each group an ARIA group
 * named after its heading. With no hits there is no listbox, just a message.
 */
function Results({ q, groups }: { q: string; groups: SearchGroup[] }) {
  let n = 0
  const option = (href: string, body: Renderable, cls = 'flex items-center gap-2') => (
    <li role="option" id={`global-search-opt-${n++}`} aria-selected="false">
      <a href={href} tabindex="-1" class={cls}>
        {body}
      </a>
    </li>
  )
  const empty = groups.length === 0
  return (
    <div
      id="global-search-results"
      class="absolute left-0 right-0 top-10 z-40 max-h-[70vh] overflow-y-auto rounded-box border border-base-300 bg-base-100 shadow-xl"
      hidden={empty && q === '' ? true : undefined}
    >
      {empty ? (
        q === '' ? null : (
          <div role="status">
            <None q={q} />
          </div>
        )
      ) : (
        <ul id="global-search-listbox" role="listbox" aria-label={t('admin.search.results')} class="menu menu-sm w-full">
          {groups.map((g) => (
            <li role="presentation">
              <ul role="group" aria-label={g.label} class="ms-0 ps-0 before:hidden">
                <li role="presentation" aria-hidden="true" class="menu-title text-xs">
                  {g.label}
                </li>
                {g.hits.slice(0, SHOWN).map((hit) => option(hit.href, <HitBody hit={hit} />))}
                {g.seeAll !== null &&
                  g.total > SHOWN &&
                  option(g.seeAll, t('admin.search.seeAll', { count: g.total, label: g.label }), 'text-xs text-primary')}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The search page for a browser without JavaScript, or for pressing Enter: every hit, grouped under headings. */
function ResultsPage({ q, groups }: { q: string; groups: SearchGroup[] }) {
  return (
    <div class="flex flex-col gap-6">
      <form method="get" action="/admin/search" class="flex max-w-lg gap-2">
        <label for="global-search-page" class="sr-only">
          {t('admin.search.label')}
        </label>
        <input id="global-search-page" type="search" name="q" value={q} autocomplete="off" class="input input-sm grow" />
        <button type="submit" class="btn btn-sm">
          {t('admin.search.submit')}
        </button>
      </form>
      {groups.length === 0 && q !== '' && <None q={q} />}
      {groups.map((g) => (
        <section class="flex flex-col gap-2">
          <h2 class="text-lg font-semibold">{g.label}</h2>
          <ul class="menu w-full rounded-box border border-base-300 bg-base-100">
            {g.hits.map((hit) => (
              <li>
                <a href={hit.href} class="flex items-center gap-2">
                  <HitBody hit={hit} />
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** `GET /admin/search?q=`: the top bar's results for htmx, otherwise a whole page. */
export function registerSearch(scope: FastifyInstance, ctx: AdminContext): void {
  scope.get('/admin/search', async (request, reply) => {
    const actor = adminActor(request)
    const q = textOf((request.query as Record<string, unknown>).q).trim()
    const groups = await searchAll(ctx, q)
    if (request.headers['hx-request'] === 'true') {
      return reply.code(200).type(HTML).send(await renderToString(<Results q={q} groups={groups} />))
    }
    const page = await adminPage(ctx, { title: t('admin.search.title'), actor }, <ResultsPage q={q} groups={groups} />)
    return reply.code(200).type(HTML).send(page)
  })
}
