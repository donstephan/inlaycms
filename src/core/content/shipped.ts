import type { Selectable } from 'kysely'
import { systemCtx } from '../auth/roles.js'
import type { DocumentsTable } from '../db/schema.js'
import { InlayError } from '../errors.js'
import { isRecord } from '../fields/zod-internals.js'
import { t } from '../messages/index.js'
import { autoRedirect } from '../redirects/redirects.js'
import { DEFAULT_RICH_TEXT, parseRichText } from '../richtext/schema.js'
import type { ContentInput, ContentIssue, CoreDeps, Ctx, DocumentData, DocumentKind, PathSegment } from '../types.js'
import { runTransaction } from './dry-run.js'
import { pathIssue } from './path.js'
import { recordEvent, type PublishResult } from './publish.js'
import { carryUnknown, readData } from './reader.js'
import { checkReferences, documentRefPaths, syncRefs } from './refs.js'
import { docLabels, normalizeContent } from './schema.js'
import { resolveShippedInput, type KeyResolver, type PendingFile } from './shipped-input.js'
import { slugify, slugIssue, uniqueSlug } from './slug.js'
import { validateContent } from './validate.js'
import { insertRevision } from './write.js'

/** One shipped document in one locale. `documentId` is null for a document a dry run would create. */
export interface ShippedItem {
  documentId: string | null
  type: string
  key: string
  locale: string
  edition: number
}

/** What applying shipped content did, or would do in a dry run. Each list is sorted by type, key and locale. */
export interface ShippedReport {
  created: ShippedItem[]
  replaced: ShippedItem[]
  skipped: ShippedItem[]
  /** References to entries the client deleted, left out of the shipped content written. `field` is the field's label path. */
  deletedRefs: Array<{ item: ShippedItem; target: { type: string; key: string }; field: string }>
  /**
   * A slug or path the shipped content asks for that is already taken, and what was done instead: another slug,
   * the path the document had, or no path. `inlaycms check` reports each as a problem; activation goes ahead.
   */
  warnings: Array<{ item: ShippedItem; message: string }>
}

/**
 * What to do with one shipped document in one locale: `create` it, `replace`
 * the stored row, `skip` it (the client deleted its group), or nothing,
 * since it's `current` (the stored edition is equal or higher).
 */
export interface ShippedAction {
  mode: 'create' | 'replace' | 'skip' | 'current'
  /** For a create, `documentId` is the id the document gets. */
  item: ShippedItem
  kind: DocumentKind
  groupId: string
  /** The stored row, or null when there is none. */
  row: Selectable<DocumentsTable> | null
  /**
   * The data a create or replace writes: resolved, validated, with references
   * to deleted entries removed and, for a replace, the head's unknown keys
   * carried. For a skip or current action, the validated data with
   * `validateAll`, else null.
   */
  data: DocumentData | null
  /** Files the shipped content names, to import. */
  files: Map<string, PendingFile>
}

/** Every shipped document and locale with what to do with it, in report order, and the deleted references left out. */
export interface ShippedPlan {
  actions: ShippedAction[]
  deletedRefs: ShippedReport['deletedRefs']
  warnings: ShippedReport['warnings']
}

type Row = Selectable<DocumentsTable>

const id = (...parts: string[]): string => JSON.stringify(parts)
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const writes = (a: ShippedAction): boolean => a.mode === 'create' || a.mode === 'replace'

function shippedError(deps: CoreDeps, item: ShippedItem, issues: ContentIssue[]): InlayError {
  const def = deps.registry.getType(item.type)
  const params = { type: item.type, key: item.key, locale: item.locale, label: def.label }
  const messageId = def.kind === 'collection' ? 'error.shippedEntry' : 'error.shippedContent'
  return new InlayError('shipped_content', messageId, params, { issues })
}

/** The value at `path` in `root`, or undefined. */
function getAt(root: unknown, path: PathSegment[]): unknown {
  let at = root
  for (const segment of path) {
    if (Array.isArray(at) && typeof segment === 'number') at = at[segment]
    else if (isRecord(at)) at = at[segment]
    else return undefined
  }
  return at
}

/** Rich text with every link mark to a group in `gone` removed; the text stays. */
function withoutLinks(node: unknown, gone: ReadonlyMap<string, unknown>): unknown {
  if (Array.isArray(node)) return node.map((child) => withoutLinks(child, gone))
  if (!isRecord(node)) return node
  const out: Record<string, unknown> = { ...node }
  if (Array.isArray(node.marks)) {
    const marks = node.marks.filter(
      (m) => !(isRecord(m) && m.type === 'link' && isRecord(m.attrs) && typeof m.attrs.document === 'string' && gone.has(m.attrs.document)),
    )
    if (marks.length > 0) out.marks = marks
    else delete out.marks
  }
  if (Array.isArray(node.content)) out.content = withoutLinks(node.content, gone)
  return out
}

/**
 * `data` without references to groups in `gone`: a single `ref` or a `link`
 * loses its value, an element of a list goes, and a rich text link mark goes
 * with its text kept. Returns the data and the paths of the fields changed,
 * with what they pointed at.
 */
function withoutRefsTo(
  deps: CoreDeps,
  type: string,
  data: DocumentData,
  gone: ReadonlyMap<string, unknown>,
): { data: DocumentData; removed: Array<{ path: PathSegment[]; groupId: string }> } {
  const found = documentRefPaths(deps, type, data).filter((r) => gone.has(r.ref.id))
  if (found.length === 0) return { data, removed: [] }
  const out = structuredClone(data)
  const drops = new Map<string, { list: unknown[]; indices: Set<number> }>()
  const removed: Array<{ path: PathSegment[]; groupId: string }> = []
  for (const r of found) {
    const last = r.path.at(-1)
    const parentPath = r.path.slice(0, -1)
    const parent = getAt(out, parentPath)
    if (r.meta.kind === 'richText' || r.meta.kind === 'inlineText') {
      const fixed = (doc: unknown) => {
        const walked = withoutLinks(doc, gone)
        const parsed = parseRichText(walked, r.meta.richText ?? DEFAULT_RICH_TEXT)
        return parsed.ok ? parsed.doc : walked
      }
      if (Array.isArray(parent) && typeof last === 'number') parent[last] = fixed(parent[last])
      else if (isRecord(parent) && last !== undefined) parent[last] = fixed(parent[last])
      removed.push({ path: r.path, groupId: r.ref.id })
    } else if (Array.isArray(parent) && typeof last === 'number') {
      const key = JSON.stringify(parentPath)
      const drop = drops.get(key) ?? { list: parent, indices: new Set<number>() }
      drop.indices.add(last)
      drops.set(key, drop)
      removed.push({ path: parentPath, groupId: r.ref.id })
    } else if (isRecord(parent) && last !== undefined) {
      delete parent[last]
      removed.push({ path: r.path, groupId: r.ref.id })
    }
  }
  for (const { list, indices } of drops.values()) {
    for (const i of [...indices].sort((a, b) => b - a)) list.splice(i, 1)
  }
  return { data: out, removed }
}

/**
 * Works out what applying the site's shipped content (spec §6.3) would do,
 * per shipped document and locale: a missing row is created; a row whose
 * edition is lower (or null) is replaced; an equal or higher edition is
 * current; a group the client deleted is skipped. Every create and replace
 * is resolved and checked (with `validateAll`, every shipped document and
 * locale, which changes nothing else); the first problem throws
 * `shipped_content`. A slug or path already taken isn't a problem: the
 * document keeps its stored slug and path (a new one gets a free slug and no path),
 * and a warning says so. Writes nothing. Run it in the transaction that writes
 * the plan, so nothing changes in between.
 */
export async function planShippedContent(deps: CoreDeps, opts: { validateAll?: boolean } = {}): Promise<ShippedPlan> {
  const { registry } = deps

  // Stored rows of shipped documents: keyed entries, and singletons and globals, whose key is their type.
  const stored = await deps.db
    .selectFrom('documents')
    .selectAll()
    .where((eb) => eb.or([eb('key', 'is not', null), eb('kind', 'in', ['singleton', 'global'])]))
    .execute()
  const rows = new Map<string, Row>()
  const storedGroups = new Map<string, string>()
  const deleted = new Map<string, { type: string; key: string }>()
  for (const row of stored) {
    const key = row.key ?? row.type
    rows.set(id(row.type, key, row.locale), row)
    storedGroups.set(id(row.type, key), row.group_id)
    if (row.deleted_at !== null) deleted.set(row.group_id, { type: row.type, key })
  }

  // Every shipped document gets its group id up front, so references between them (cycles included) resolve.
  const shipped = [...registry.content]
    .sort(([a], [b]) => byText(a, b))
    .map(([type, docs]) => ({ type, docs: [...docs].sort((a, b) => byText(a.key, b.key)) }))
  const groups = new Map<string, string>()
  const pending = new Map<string, { group_id: string; kind: DocumentKind; type: string }>()
  const kindOf = (type: string): DocumentKind => {
    const def = registry.getType(type)
    return def.kind === 'collection' ? 'entry' : def.kind
  }
  for (const { type, docs } of shipped) {
    for (const doc of docs) {
      let groupId = storedGroups.get(id(type, doc.key))
      if (groupId === undefined) {
        groupId = crypto.randomUUID()
        pending.set(groupId, { group_id: groupId, kind: kindOf(type), type })
      }
      groups.set(id(type, doc.key), groupId)
    }
  }
  const resolveKey: KeyResolver = (ref) => groups.get(id(ref.type, ref.key ?? ref.type)) ?? null

  const actions: ShippedAction[] = []
  const inputs = new Map<ShippedAction, ContentInput>()
  for (const { type, docs } of shipped) {
    for (const doc of docs) {
      const groupId = groups.get(id(type, doc.key))!
      for (const locale of Object.keys(doc.content).sort(byText)) {
        const row = rows.get(id(type, doc.key, locale)) ?? null
        const mode: ShippedAction['mode'] = deleted.has(groupId)
          ? 'skip'
          : row === null
            ? 'create'
            : (row.edition ?? 0) < doc.edition
              ? 'replace'
              : 'current'
        const documentId = row?.id ?? (mode === 'create' ? crypto.randomUUID() : null)
        const item: ShippedItem = { documentId, type, key: doc.key, locale, edition: doc.edition }
        const action: ShippedAction = { mode, item, kind: kindOf(type), groupId, row, data: null, files: new Map() }
        actions.push(action)
        inputs.set(action, doc.content[locale]!)
      }
    }
  }

  // Check everything before anything is written.
  const deletedRefs: ShippedReport['deletedRefs'] = []
  const warnings: ShippedReport['warnings'] = []
  const warn = (a: ShippedAction, messageId: 'shipped.slugTaken' | 'shipped.pathTaken' | 'shipped.pathDropped', params: Record<string, string>) => {
    const { label } = registry.getType(a.item.type)
    warnings.push({ item: a.item, message: t(messageId, { label, key: a.item.key, locale: a.item.locale, ...params }) })
  }
  const slugKey = (a: ShippedAction, slug: string) => id(a.item.type, a.item.locale, slug)
  const routed = (a: ShippedAction) => {
    const def = registry.getType(a.item.type)
    return def.kind === 'collection' && def.route !== null
  }
  /** Slugs the shipped content gives for what's written, so generated ones avoid them. */
  const explicit = new Set(
    actions
      .filter((a) => writes(a) && routed(a) && inputs.get(a)!.slug !== undefined)
      .map((a) => slugKey(a, inputs.get(a)!.slug!)),
  )
  /** Slugs and paths already chosen in this run. */
  const reserved = new Set<string>()
  const reservedPaths = new Set<string>()

  /** The first of `base`, `base-2`… that no document has and no other shipped document asks for. */
  const freeSlug = async (a: ShippedAction, base: string): Promise<string> => {
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`
      if (reserved.has(slugKey(a, candidate)) || explicit.has(slugKey(a, candidate))) continue
      if ((await uniqueSlug(deps, a.item.type, a.item.locale, candidate, a.row?.id)) === candidate) return candidate
    }
  }

  for (const a of actions) {
    const write = writes(a)
    if (!write && !opts.validateAll) continue
    const { type, locale } = a.item
    const resolved = await resolveShippedInput(deps, type, inputs.get(a)!, resolveKey)
    if (resolved.issues.length > 0) throw shippedError(deps, a.item, resolved.issues)
    if (write && resolved.files.size > 0 && !deps.media) throw new InlayError('invalid_operation', 'error.mediaNotConfigured')

    const data = normalizeContent(registry, type, resolved.input)
    const exclude = a.row?.id
    // A document keeps its live address (its draft's, if it was never published) unless the shipped content gives one.
    const live = a.row !== null && a.row.published_rev !== null
    const keptSlug = a.row && ((live ? a.row.published_slug : null) ?? a.row.head_slug)
    const keptPath = a.row && (live ? a.row.published_path : a.row.head_path)
    const def = registry.getType(type)
    if (def.kind === 'collection' && def.route !== null) {
      const wanted = data.slug ?? keptSlug
      const slugTaken = async (slug: string) =>
        (await slugIssue(deps, type, locale, slug, exclude)) !== null || reserved.has(slugKey(a, slug))
      if (wanted != null) {
        data.slug = wanted
        if (write && (await slugTaken(wanted))) {
          // A replace keeps its live address rather than moving it because of a clash.
          const keep = a.mode === 'replace' && keptSlug != null && keptSlug !== wanted && !(await slugTaken(keptSlug))
          data.slug = keep ? keptSlug : await freeSlug(a, wanted)
          warn(a, 'shipped.slugTaken', { slug: wanted, given: data.slug })
        }
      } else {
        const title = data.fields[def.titleField]
        const base = slugify(typeof title === 'string' ? title : '')
        data.slug = write ? await freeSlug(a, base) : base
      }
      if (write) reserved.add(slugKey(a, data.slug))
    }
    const pathTaken = async (path: string) =>
      (await pathIssue(deps, type, locale, path, exclude)) !== null || reservedPaths.has(id(locale, path))
    if (data.path !== undefined) {
      if (write && (await pathTaken(data.path))) {
        const asked = data.path
        delete data.path
        if (a.mode === 'replace' && keptPath != null && !(await pathTaken(keptPath))) {
          data.path = keptPath
          warn(a, 'shipped.pathTaken', { path: asked, kept: keptPath })
        } else {
          warn(a, 'shipped.pathDropped', { path: asked })
        }
      }
      if (write && data.path !== undefined) reservedPaths.add(id(locale, data.path))
    } else if (keptPath != null) {
      data.path = keptPath
    }

    const validated = validateContent(registry, type, data, 'strict')
    if (!validated.ok) throw shippedError(deps, a.item, validated.issues)
    const media = new Map([...resolved.files].map(([fileId, file]) => [fileId, file.mime]))
    const issues = await checkReferences(deps, type, validated.data, { media, pending })
    if (issues.length > 0) throw shippedError(deps, a.item, issues)
    a.files = resolved.files
    if (!write) {
      a.data = validated.data
      continue
    }

    // What the stored head keeps that the shipped content doesn't know about is carried, as a save does.
    let next = validated.data
    if (a.mode === 'replace' && a.row!.head_rev !== null) {
      const head = await deps.db.selectFrom('revisions').select('data').where('id', '=', a.row!.head_rev).executeTakeFirstOrThrow()
      const raw: unknown = JSON.parse(head.data)
      next = carryUnknown(registry, type, raw, readData(registry, type, raw).data, next)
    }

    // References to entries the client deleted are left out, as deleting them would have done.
    // This runs after the carry so a stale stored value can't bring a removed reference back.
    const cleaned = withoutRefsTo(deps, type, next, deleted)
    const seen = new Set<string>()
    for (const { path, groupId } of cleaned.removed) {
      const field = docLabels(registry, type, path)?.join(' › ') ?? path.join('.')
      if (seen.has(id(groupId, field))) continue
      seen.add(id(groupId, field))
      deletedRefs.push({ item: a.item, target: deleted.get(groupId)!, field })
    }
    a.data = cleaned.data
  }

  return { actions, deletedRefs, warnings }
}

/** The files a plan's creates and replaces name, by id. */
function planFiles(plan: ShippedPlan): Map<string, PendingFile> {
  const files = new Map<string, PendingFile>()
  for (const a of plan.actions) if (writes(a)) for (const [fileId, file] of a.files) files.set(fileId, file)
  return files
}

/**
 * Puts the files a plan's creates and replaces name in the media store, telling `onFileStored` of each first. Run
 * it before the transaction that writes the plan opens, so that transaction holds the write lock for database
 * writes only: `writeShippedContent` then finds the files stored. Files are named by their content, so storing one
 * that is never written to the database harms nothing (a caller removes those after a failure).
 */
export async function storeShippedFiles(deps: CoreDeps, plan: ShippedPlan, onFileStored?: (fileId: string) => void): Promise<void> {
  for (const [fileId, file] of planFiles(plan)) {
    onFileStored?.(fileId)
    await deps.media!.put(fileId, file.bytes)
  }
}

/**
 * Writes a plan from `planShippedContent`: imports the files, creates and
 * replaces the documents and publishes them, as one publish event. `deps.db`
 * should be the transaction the plan was made in. With `dryRun`, no file is
 * stored and created documents are reported without their ids; rolling back
 * is the caller's. Revisions and the publish event are written with `ctx`
 * (default: the system acting as `release`, without a release id).
 * `onFileStored` hears of each file put in the media store before its row is
 * written, so a caller that rolls back can remove the files no row names. A
 * file already stored (see `storeShippedFiles`) isn't written again.
 */
export async function writeShippedContent(
  deps: CoreDeps,
  plan: ShippedPlan,
  opts: { dryRun?: boolean; ctx?: Ctx; onFileStored?: (fileId: string) => void } = {},
): Promise<ShippedReport> {
  const shown = new Map<ShippedItem, ShippedItem>()
  const report: ShippedReport = { created: [], replaced: [], skipped: [], deletedRefs: [], warnings: [] }
  for (const a of plan.actions) {
    if (a.mode === 'create') {
      const item = opts.dryRun ? { ...a.item, documentId: null } : a.item
      shown.set(a.item, item)
      report.created.push(item)
    } else if (a.mode === 'replace') {
      report.replaced.push(a.item)
    } else if (a.mode === 'skip') {
      report.skipped.push(a.item)
    }
  }
  report.deletedRefs = plan.deletedRefs.map((r) => ({ ...r, item: shown.get(r.item) ?? r.item }))
  report.warnings = plan.warnings.map((w) => ({ ...w, item: shown.get(w.item) ?? w.item }))

  const actions = plan.actions.filter(writes)
  if (actions.length === 0) return report

  const ctx = opts.ctx ?? systemCtx('release')
  const trx = deps.db
  const at = deps.now().toISOString()
  for (const [fileId, file] of planFiles(plan)) {
    if (!opts.dryRun) {
      opts.onFileStored?.(fileId)
      await deps.media!.put(fileId, file.bytes)
    }
    await trx
      .insertInto('media')
      .values({
        id: fileId,
        filename: file.filename,
        mime: file.mime,
        size: file.size,
        width: file.width,
        height: file.height,
        default_alt: null,
        created_by_id: ctx.actor.id,
        created_by_name: ctx.actor.name,
        created_at: at,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
  }

  const items: PublishResult['items'] = []
  for (const a of actions) {
    const documentId = a.item.documentId!
    const data = a.data!
    const slug = data.slug ?? null
    const path = data.path ?? null
    if (a.mode === 'create') {
      await trx
        .insertInto('documents')
        .values({
          id: documentId,
          kind: a.kind,
          type: a.item.type,
          group_id: a.groupId,
          locale: a.item.locale,
          head_rev: null,
          published_rev: null,
          head_slug: slug,
          published_slug: null,
          head_path: path,
          published_path: null,
          deleted_at: null,
          created_at: at,
          key: a.item.key,
          edition: a.item.edition,
        })
        .execute()
    }
    const revId = await insertRevision(deps, documentId, data, ctx, null, at)
    await trx
      .updateTable('documents')
      .set({ head_rev: revId, head_slug: slug, head_path: path, key: a.item.key, edition: a.item.edition })
      .where('id', '=', documentId)
      .execute()
    const before = a.row ?? {
      group_id: a.groupId,
      type: a.item.type,
      locale: a.item.locale,
      published_rev: null,
      published_slug: null,
      published_path: null,
    }
    await autoRedirect(deps, ctx, { ...before, head_slug: slug, head_path: path })
    await trx
      .updateTable('documents')
      .set((eb) => ({
        published_rev: revId,
        published_slug: slug,
        published_path: path,
        first_published_at: eb.fn.coalesce('first_published_at', eb.val(at)),
      }))
      .where('id', '=', documentId)
      .execute()
    items.push({ documentId, revisionId: revId, action: 'publish' })
  }
  for (const a of actions) await syncRefs(deps, a.item.documentId!)
  await recordEvent(deps, ctx, null, items, at)
  return report
}

/**
 * Applies the site's shipped content (spec §6.3): plans and writes it in one
 * transaction, so a problem writes nothing. With `dryRun`, reports what it
 * would do and rolls back. `validateAll` checks every shipped document, not
 * only what's written.
 */
export async function applyShippedContent(
  deps: CoreDeps,
  opts: { dryRun?: boolean; validateAll?: boolean } = {},
): Promise<ShippedReport> {
  return runTransaction(deps, async (tx) => writeShippedContent(tx, await planShippedContent(tx, opts), opts), opts)
}
