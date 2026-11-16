import { isDeepStrictEqual } from 'node:util'
import { assertCan } from '../auth/roles.js'
import { InlayError } from '../errors.js'
import type { CoreDeps, Ctx, DiffEntry, DocumentData, DocumentView } from '../types.js'
import { diffData } from './diff.js'
import { carryUnknown, readData } from './reader.js'
import { documentTitle, getDocument, whereVisible } from './read.js'
import { checkReferences, documentRefPaths, mediaRefPaths, refKey, syncRefs } from './refs.js'
import { pathIssue } from './path.js'
import { slugify, slugIssue, uniqueSlug } from './slug.js'
import { validateContent } from './validate.js'
import { insertRevision, validationError } from './write.js'
import { withTransaction } from './dry-run.js'

export interface SaveResult {
  document: DocumentView
  changed: boolean
  diff: DiffEntry[]
}

export interface DraftInput {
  baseRevisionId: number
  message?: string
}

/** `baseRevisionId: null` skips the head check (restore replaces the head on purpose). */
export interface WriteInput {
  baseRevisionId: number | null
  message?: string
}

/**
 * Writes a new head draft computed from the current head data by `next`, all
 * in one transaction: the head check, validation, reference and slug checks,
 * the no-op check and the write. Two saves from the same base can't both win.
 */
export async function writeDraft(
  deps: CoreDeps,
  documentId: string,
  input: WriteInput,
  ctx: Ctx,
  next: (head: DocumentData) => unknown,
): Promise<SaveResult> {
  assertCan(ctx, 'content.write')
  const { changed, diff } = await withTransaction(deps, async (tx) => {
    const trx = tx.db
    const doc = await trx
      .selectFrom('documents')
      .selectAll()
      .where('id', '=', documentId)
      .$call(whereVisible(deps.registry))
      .executeTakeFirst()
    if (!doc || doc.head_rev === null) throw new InlayError('not_found', 'error.notFound', { name: documentId })
    const headRev = await trx
      .selectFrom('revisions')
      .select(['data'])
      .where('id', '=', doc.head_rev)
      .executeTakeFirstOrThrow()
    const raw: unknown = JSON.parse(headRev.data)
    const head = readData(deps.registry, doc.type, raw).data
    const title = documentTitle(tx, doc, head, doc.head_slug)
    if (doc.deleted_at !== null) throw new InlayError('invalid_operation', 'error.editDeleted', { title })
    if (input.baseRevisionId !== null && doc.head_rev !== input.baseRevisionId) throw new InlayError('conflict', 'error.conflict', { title })

    const validated = validateContent(deps.registry, doc.type, next(head) as DocumentData, 'draft')
    if (!validated.ok) throw validationError(validated.issues)
    const edited = validated.data

    // A ref the head already has, left where it is, may point at hidden content; publishing blocks it.
    const kept = new Set([...documentRefPaths(tx, doc.type, head), ...mediaRefPaths(tx, doc.type, head)].map(refKey))
    const issues = await checkReferences(tx, doc.type, edited, { kept })
    const def = deps.registry.getType(doc.type)
    if (def.kind === 'collection' && def.route !== null) {
      if (edited.slug === undefined) {
        const fallback = edited.fields[def.titleField]
        edited.slug =
          doc.head_slug ??
          (await uniqueSlug(tx, doc.type, doc.locale, slugify(typeof fallback === 'string' ? fallback : ''), doc.id))
      }
      const clash = await slugIssue(tx, doc.type, doc.locale, edited.slug, doc.id)
      if (clash) issues.push(clash)
    }
    if (edited.path !== undefined) {
      const clash = await pathIssue(tx, doc.type, doc.locale, edited.path, doc.id)
      if (clash) issues.push(clash)
    }
    if (issues.length > 0) throw validationError(issues)

    // What the stored head keeps that the edit doesn't supply is carried after the checks: the editor never saw it.
    const data = carryUnknown(deps.registry, doc.type, raw, head, edited)
    const unchanged = carryUnknown(deps.registry, doc.type, raw, head, head)
    if (isDeepStrictEqual(JSON.parse(JSON.stringify(data)), unchanged)) return { changed: false, diff: [] as DiffEntry[] }

    const revId = await insertRevision(tx, doc.id, data, ctx, input.message ?? null, deps.now().toISOString())
    await trx
      .updateTable('documents')
      .set({ head_rev: revId, head_slug: data.slug ?? null, head_path: data.path ?? null })
      .where('id', '=', doc.id)
      .execute()
    await syncRefs(tx, doc.id)
    return { changed: true, diff: diffData(deps.registry, doc.type, head, edited) }
  })
  return { document: (await getDocument(deps, documentId))!, changed, diff }
}

/** Replaces the head draft with `data` if `baseRevisionId` is still the head. */
export function saveDraft(
  deps: CoreDeps,
  documentId: string,
  input: DraftInput & { data: DocumentData },
  ctx: Ctx,
): Promise<SaveResult> {
  return writeDraft(deps, documentId, input, ctx, () => input.data)
}
