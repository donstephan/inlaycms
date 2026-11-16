import { assertCan } from '../auth/roles.js'
import { InlayError } from '../errors.js'
import type {
  ContentInput,
  ContentIssue,
  CoreDeps,
  Ctx,
  DocumentData,
  DocumentView,
} from '../types.js'
import { getDocument } from './read.js'
import { checkReferences, syncRefs } from './refs.js'
import { normalizeContent } from './schema.js'
import { pathIssue } from './path.js'
import { slugify, slugIssue, uniqueSlug } from './slug.js'
import { validateContent } from './validate.js'
import { withTransaction } from './dry-run.js'

export function validationError(issues: ContentIssue[]): InlayError {
  return new InlayError('validation', 'error.validation', {}, { issues })
}

/** Appends a revision of `documentId` and returns its id. Inside a transaction pass `{ ...deps, db: trx }`. */
export async function insertRevision(
  deps: CoreDeps,
  documentId: string,
  data: DocumentData,
  ctx: Ctx,
  message: string | null,
  at: string,
): Promise<number> {
  const rev = await deps.db
    .insertInto('revisions')
    .values({
      document_id: documentId,
      data: JSON.stringify(data),
      author_id: ctx.actor.id,
      author_name: ctx.actor.name,
      source: ctx.source,
      message,
      created_at: at,
      release_id: ctx.releaseId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return rev.id
}

/** Creates a new collection entry in the default locale as an unpublished draft. */
export async function createEntry(
  deps: CoreDeps,
  type: string,
  input: ContentInput & { locale?: string; message?: string },
  ctx: Ctx,
): Promise<DocumentView> {
  assertCan(ctx, 'content.write')
  const { registry } = deps
  const def = registry.getType(type)
  if (def.kind !== 'collection') {
    throw new InlayError('invalid_operation', 'error.notCollection', { name: def.label })
  }
  const locale = input.locale ?? registry.defaultLocale
  if (locale !== registry.defaultLocale) {
    throw new InlayError('invalid_operation', 'error.createLocale', { locale: registry.defaultLocale })
  }

  const validated = validateContent(registry, type, normalizeContent(registry, type, input), 'draft')
  if (!validated.ok) throw validationError(validated.issues)
  const data = validated.data

  const id = crypto.randomUUID()
  await withTransaction(deps, async (tx) => {
    const trx = tx.db
    const issues = await checkReferences(tx, type, data)
    if (def.route !== null) {
      if (data.slug !== undefined) {
        const clash = await slugIssue(tx, type, locale, data.slug)
        if (clash) issues.push(clash)
      } else {
        const title = data.fields[def.titleField]
        data.slug = await uniqueSlug(tx, type, locale, slugify(typeof title === 'string' ? title : ''))
      }
    }
    if (data.path !== undefined) {
      const clash = await pathIssue(tx, type, locale, data.path)
      if (clash) issues.push(clash)
    }
    if (issues.length > 0) throw validationError(issues)

    const at = deps.now().toISOString()
    await trx
      .insertInto('documents')
      .values({
        id,
        kind: 'entry',
        type,
        group_id: crypto.randomUUID(),
        locale,
        head_rev: null,
        published_rev: null,
        head_slug: data.slug ?? null,
        published_slug: null,
        head_path: data.path ?? null,
        published_path: null,
        deleted_at: null,
        created_at: at,
      })
      .execute()
    const revId = await insertRevision(tx, id, data, ctx, input.message ?? null, at)
    await trx.updateTable('documents').set({ head_rev: revId }).where('id', '=', id).execute()
    await syncRefs(tx, id)
  })

  return (await getDocument(deps, id))!
}
