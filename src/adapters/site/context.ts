import type { z } from 'zod'
import { documentRefs } from '../../core/content/schema.js'
import { findRefs } from '../../core/fields/walk.js'
import { validateContent } from '../../core/content/validate.js'
import type { Core } from '../../core/core.js'
import { isRasterImage } from '../../core/media/detect.js'
import { IMAGE_WIDTHS, type VariantFormat } from '../../core/media/variants.js'
import type { CollectionDef, GlobalDef, TemplateDef } from '../../core/registry/define.js'
import type {
  Entry,
  QueryOptions,
  QueryResult,
  RenderContext,
  ResolvedFile,
  ResolvedImage,
  ResolvedLink,
} from '../../core/registry/render.js'
import type { QueryApi } from '../../core/registry/route.js'
import { richTextToHtml } from '../../core/richtext/html.js'
import type { RichTextDoc } from '../../core/richtext/schema.js'
import { encodePath } from '../../core/site/paths.js'
import type {
  ContentRef,
  DocumentData,
  FileValue,
  ImageValue,
  LinkValue,
  LiveDocument,
  LiveState,
  MediaInfo,
} from '../../core/types.js'
import { publicAssets, type PublicAssets } from './assets.js'
import { createHeadCollector, type CollectedHead } from './head.js'
import { raw, type SafeHtml } from '../../jsx/html.js'

export interface RenderContextOptions {
  locale: string
  state: LiveState
  page: number
  baseUrl: string
  alternates: RenderContext['alternates']
  assets?: PublicAssets
}

export type PreloadingRenderContext = RenderContext & {
  /** Loads the media and documents `docs` refer to, so `image`, `file`, `link` and `richText` can resolve them. */
  preload(docs: LiveDocument[]): Promise<void>
  /** As `preload`, for `data` of `template` that no document holds (a page a route renders). */
  preloadData(template: TemplateDef, data: DocumentData): Promise<void>
  /** What `head` collected so far. */
  headTags(): CollectedHead
}

/** Rich text images get this width as `src` when the original is at least as wide. */
const RICH_TEXT_SRC_WIDTH = 1280

const nonEmpty = (s: string | null | undefined): s is string => typeof s === 'string' && s !== ''

const mediaUrl = (id: string) => `/media/${id}`
const missing = (v: unknown) => v === undefined || v === null

function resolveImage(media: MediaInfo, alt: string | undefined): ResolvedImage {
  const url = mediaUrl(media.id)
  const raster = isRasterImage(media.mime)
  const variant = (width: number, format: VariantFormat) => `${url}/${width}.${format}`
  const widths = (): number[] => {
    const all: number[] = [...IMAGE_WIDTHS]
    if (media.width === null) return all
    const fitting = all.filter((w) => w <= media.width!)
    return fitting.length > 0 ? fitting : all.slice(0, 1)
  }
  return {
    id: media.id,
    url,
    alt: nonEmpty(alt) ? alt : nonEmpty(media.defaultAlt) ? media.defaultAlt : '',
    width: media.width,
    height: media.height,
    mime: media.mime,
    src(width, format = 'webp') {
      if (!raster) return url
      const w = IMAGE_WIDTHS.find((x) => x >= width) ?? IMAGE_WIDTHS[IMAGE_WIDTHS.length - 1]!
      return variant(w, format)
    },
    srcset(format = 'webp') {
      if (!raster) return ''
      return widths()
        .map((w) => `${variant(w, format)} ${w}w`)
        .join(', ')
    },
  }
}

function toEntry<F>(doc: LiveDocument): Entry<F> {
  return {
    id: doc.groupId,
    type: doc.type,
    locale: doc.contentLocale,
    fallback: doc.fallback,
    url: doc.path === null ? null : encodePath(doc.path),
    title: doc.title,
    slug: doc.slug,
    updatedAt: doc.updatedAt,
    fields: doc.data.fields as F,
  }
}

function compareValues(a: unknown, b: unknown): number {
  if (missing(a) || missing(b)) return missing(a) === missing(b) ? 0 : missing(a) ? 1 : -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const x = String(a)
  const y = String(b)
  return x < y ? -1 : x > y ? 1 : 0
}

function sortEntries<F>(entries: Entry<F>[], sort: QueryOptions<F>['sort']): Entry<F>[] {
  if (sort === undefined || sort === 'newest') return entries
  if (sort === 'oldest') return [...entries].reverse()
  const sign = sort.direction === 'desc' ? -1 : 1
  const value = (e: Entry<F>) => (e.fields as Record<string, unknown>)[sort.field]
  return [...entries].sort((a, b) => {
    const av = value(a)
    const bv = value(b)
    // Entries without a value go last in either direction.
    if (missing(av) || missing(bv)) return compareValues(av, bv)
    return sign * compareValues(av, bv)
  })
}

/**
 * The `ctx` templates and blocks receive. Synchronous helpers resolve only what was preloaded:
 * `renderPage` preloads the page, and `entries`, `query` and `global` preload what they return.
 * Every lookup is cached for the life of the context (one request).
 */
export function createRenderContext(core: Core, opts: RenderContextOptions): PreloadingRenderContext {
  const { registry } = core
  const { locale, state } = opts
  const preview = state === 'preview'
  const assets = opts.assets ?? publicAssets(null)
  const media = new Map<string, MediaInfo | null>()
  const docs = new Map<string, LiveDocument | null>()
  const collections = new Map<string, Promise<LiveDocument[]>>()
  const globals = new Map<string, Promise<LiveDocument | null>>()
  const head = createHeadCollector()

  /**
   * Whether `doc` can be shown as is. In preview, a draft that isn't complete can't: an entry is
   * then treated as not live, and a singleton or global falls back to its published version.
   */
  const complete = (doc: LiveDocument): boolean =>
    !preview || validateContent(registry, doc.type, doc.data, 'strict').ok
  /** Whether an entry is shown; documents of other kinds reach here already checked. */
  const shown = (doc: LiveDocument): boolean => doc.kind !== 'entry' || complete(doc)

  async function loadDocs(groupIds: Iterable<string>): Promise<void> {
    const missing = [...new Set(groupIds)].filter((id) => !docs.has(id))
    if (missing.length === 0) return
    const found = await core.liveDocuments(missing, locale, { state })
    const incomplete: string[] = []
    for (const id of missing) {
      const doc = found.get(id)
      const ok = doc !== undefined && complete(doc)
      if (doc && !ok && doc.kind !== 'entry') incomplete.push(id)
      docs.set(id, ok ? doc : null)
    }
    if (incomplete.length === 0) return
    const published = await core.liveDocuments(incomplete, locale, { state: 'published' })
    for (const id of incomplete) docs.set(id, published.get(id) ?? null)
  }

  async function loadMedia(ids: Iterable<string>): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !media.has(id))
    if (missing.length === 0) return
    const found = await core.lookupMedia(missing)
    for (const id of missing) {
      const status = found.get(id)
      media.set(id, status?.status === 'present' ? status.media : null)
    }
  }

  async function loadRefs(refs: Iterable<ContentRef>): Promise<void> {
    const docIds: string[] = []
    const mediaIds: string[] = []
    for (const ref of refs) (ref.kind === 'media' ? mediaIds : docIds).push(ref.id)
    await Promise.all([loadDocs(docIds), loadMedia(mediaIds)])
  }

  async function preload(list: LiveDocument[]): Promise<void> {
    for (const doc of list) if (!docs.has(doc.groupId)) docs.set(doc.groupId, shown(doc) ? doc : null)
    await loadRefs(list.flatMap((doc) => documentRefs(registry, doc.type, doc.data)))
  }

  async function preloadData(template: TemplateDef, data: DocumentData): Promise<void> {
    const found = findRefs(template.fields, data.fields)
    for (const [key, slot] of Object.entries(template.slots)) found.push(...findRefs(slot.block.schema, data.slots[key]?.data))
    await loadRefs(found.map((r) => r.ref))
  }

  function image(v: ImageValue | null | undefined): ResolvedImage | null {
    const info = v ? media.get(v.media) : undefined
    return info ? resolveImage(info, v!.alt) : null
  }

  function file(v: FileValue | null | undefined): ResolvedFile | null {
    const info = v ? media.get(v.media) : undefined
    if (!info) return null
    return { id: info.id, url: mediaUrl(info.id), filename: info.filename, mime: info.mime, size: info.size }
  }

  function documentHref(groupId: string): { href: string; title: string } | null {
    const doc = docs.get(groupId)
    if (!doc || doc.path === null) return null
    return { href: encodePath(doc.path), title: doc.title }
  }

  function link(v: LinkValue | null | undefined): ResolvedLink | null {
    if (!v) return null
    if ('url' in v) return { href: v.url, text: nonEmpty(v.text) ? v.text : v.url, external: !v.url.startsWith('/') }
    const target = documentHref(v.document)
    if (!target) return null
    const text = nonEmpty(v.text) ? v.text : nonEmpty(target.title) ? target.title : target.href
    return { href: target.href, text, external: false }
  }

  function richText(doc: RichTextDoc | null | undefined): SafeHtml {
    if (!doc) return raw('')
    return raw(
      richTextToHtml(doc, {
        link: (groupId) => documentHref(groupId)?.href ?? null,
        image: (id, alt) => {
          const info = media.get(id)
          if (!info) return null
          const img = resolveImage(info, alt)
          const width = Math.min(img.width ?? RICH_TEXT_SRC_WIDTH, RICH_TEXT_SRC_WIDTH)
          return { src: img.src(width), srcset: img.srcset(), alt: img.alt, width: img.width, height: img.height }
        },
      }),
    )
  }

  async function entries<F = Record<string, unknown>>(
    ids: string | readonly string[] | null | undefined,
  ): Promise<Entry<F>[]> {
    const list = ids === null || ids === undefined ? [] : typeof ids === 'string' ? [ids] : [...ids]
    await loadDocs(list)
    const found = list.flatMap((id) => {
      const doc = docs.get(id)
      return doc ? [doc] : []
    })
    await preload(found)
    return found.map((doc) => toEntry<F>(doc))
  }

  function liveCollection(name: string): Promise<LiveDocument[]> {
    let pending = collections.get(name)
    if (!pending) {
      pending = core.liveEntries(name, locale, { state }).then((list) => {
        const kept = list.filter(shown)
        for (const doc of kept) if (!docs.has(doc.groupId)) docs.set(doc.groupId, doc)
        return kept
      })
      collections.set(name, pending)
    }
    return pending
  }

  async function query<T extends TemplateDef = TemplateDef>(
    collection: string | CollectionDef<T>,
    queryOpts: QueryOptions<z.output<T['fields']>> = {},
  ): Promise<QueryResult<z.output<T['fields']>>> {
    type F = z.output<T['fields']>
    const name = typeof collection === 'string' ? collection : collection.name
    const live = await liveCollection(name)
    const all = live.map((doc) => toEntry<F>(doc))
    const filtered = queryOpts.filter ? all.filter(queryOpts.filter) : all
    const sorted = sortEntries(filtered, queryOpts.sort)
    const total = sorted.length
    let items = sorted
    let page = 1
    let pages = 1
    const limit = queryOpts.limit
    if (limit !== undefined && Number.isFinite(limit) && limit > 0) {
      const size = Math.floor(limit)
      page = Math.max(1, Math.floor(queryOpts.page ?? 1))
      pages = Math.max(1, Math.ceil(total / size))
      items = sorted.slice((page - 1) * size, page * size)
    }
    const shownIds = new Set(items.map((e) => e.id))
    await preload(live.filter((doc) => shownIds.has(doc.groupId)))
    return { items, total, page, pages }
  }

  async function global<T extends TemplateDef = TemplateDef>(
    g: string | GlobalDef<T>,
  ): Promise<z.output<T['fields']> | null> {
    const name = typeof g === 'string' ? g : g.name
    let pending = globals.get(name)
    if (!pending) {
      pending = core.liveSingleton(name, locale, { state }).then(async (draft) => {
        const doc = draft && !complete(draft) ? await core.liveSingleton(name, locale, { state: 'published' }) : draft
        if (doc) await preload([doc])
        return doc
      })
      globals.set(name, pending)
    }
    const doc = await pending
    return doc ? (doc.data.fields as z.output<T['fields']>) : null
  }

  return {
    locale,
    defaultLocale: registry.defaultLocale,
    locales: registry.locales,
    preview,
    page: opts.page,
    baseUrl: opts.baseUrl,
    asset: (path) => assets.url(path),
    head: head.api,
    alternates: opts.alternates,
    image,
    file,
    link,
    richText,
    entries,
    query,
    global,
    preload,
    preloadData,
    headTags: head.collected,
  }
}

/** Published content at `locale`, the way templates query it, for one request. */
export function queryApi(core: Core, opts: { locale: string; baseUrl: string; assets?: PublicAssets }): QueryApi {
  const ctx = createRenderContext(core, { ...opts, state: 'published', page: 1, alternates: [] })
  return { query: ctx.query, global: ctx.global, entries: ctx.entries }
}
