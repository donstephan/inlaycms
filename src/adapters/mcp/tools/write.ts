import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { contentFromAgent, fromAgent, parsePath } from '../../../core/agent/format.js'
import type { PatchOp } from '../../../core/core.js'
import { formatDiff } from '../../../core/content/diff.js'
import { patchProblems, unknownContentKeys } from '../../../core/content/patch.js'
import { docLabels, documentRefsWithPaths, normalizeContent } from '../../../core/content/schema.js'
import { contentIssue, mergeIssues, validateContent } from '../../../core/content/validate.js'
import { InlayError } from '../../../core/errors.js'
import { defOf, unwrap, type Schema } from '../../../core/fields/zod-internals.js'
import { t } from '../../../core/messages/index.js'
import { designedInCode } from '../../../core/registry/designed.js'
import type { Registry } from '../../../core/registry/registry.js'
import type { ContentIssue, Ctx, DocumentData, DocumentSummary, PathSegment } from '../../../core/types.js'
import { previewLink } from '../../site/preview.js'
import { pageUrl } from '../agent-refs.js'
import { DESTRUCTIVE, documentOf, EDIT, livePath, READ_ONLY } from '../documents.js'
import { ok, tool } from '../results.js'
import type { McpDeps } from '../server.js'

const updateDocumentInput = z.object({
  id: z.string().describe(t('mcp.param.id')),
  baseRevisionId: z.number().int().describe(t('mcp.param.baseRevisionId')),
  changes: z
    .array(
      z.object({
        path: z.string().describe(t('mcp.param.changePath')),
        value: z.unknown().describe(t('mcp.param.changeValue')).optional(),
        remove: z.literal(true).describe(t('mcp.param.changeRemove')).optional(),
      }),
    )
    .min(1)
    .max(100)
    .describe(t('mcp.param.changes')),
  message: z.string().describe(t('mcp.param.message')).optional(),
})

const createEntryInput = z.object({
  collection: z.string().describe(t('mcp.param.collection')),
  content: z
    .object({
      slug: z.string().optional(),
      path: z.string().optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
      slots: z
        .record(
          z.string(),
          z.object({ enabled: z.boolean().optional(), data: z.record(z.string(), z.unknown()).optional() }),
        )
        .optional(),
    })
    .describe(t('mcp.param.content')),
  message: z.string().describe(t('mcp.param.message')).optional(),
})

const createTranslationInput = z.object({
  id: z.string().describe(t('mcp.param.translateId')),
  locale: z.string().describe(t('mcp.param.translateLocale')),
})

const deleteEntryInput = z.object({ id: z.string().describe(t('mcp.param.entryId')) })

const previewLinkInput = z.object({ id: z.string().describe(t('mcp.param.previewId')).optional() })

/** What `create_entry` and `create_translation` return about the new draft. */
async function created(deps: McpDeps, doc: DocumentSummary) {
  const path = await livePath(deps, doc)
  return {
    id: doc.id,
    groupId: doc.groupId,
    revisionId: doc.headRev,
    title: doc.title,
    url: pageUrl(deps.baseUrl, await livePath(deps, doc, 'published'), deps.core.registry.site.trailingSlash),
    previewUrl: previewLink(deps, path ?? '/'),
  }
}

const validation = (issues: ContentIssue[]) => new InlayError('validation', 'error.validation', {}, { issues })

/** The schema of the field at `path`, or `null` when the path doesn't lead plainly to one (the patch then reports it). */
function fieldAt(registry: Registry, type: string, path: PathSegment[]): Schema | null {
  const { template } = registry.getType(type)
  const [head, key, part, ...more] = path
  let current: Schema
  let rest: PathSegment[]
  if (head === 'fields') {
    current = template.fields
    rest = path.slice(1)
  } else if (head === 'slots' && typeof key === 'string' && Object.hasOwn(template.slots, key) && part === 'data') {
    current = template.slots[key]!.block.schema
    rest = more
  } else {
    return null
  }
  if (rest.length === 0) return null
  for (const segment of rest) {
    const def = defOf(unwrap(current))
    if (def.type === 'object' && def.shape && typeof segment === 'string' && Object.hasOwn(def.shape, segment)) {
      current = def.shape[segment]!
    } else if (def.type === 'array' && def.element && typeof segment === 'number') {
      current = def.element
    } else {
      return null
    }
  }
  return current
}

/** `ops` laid out as a document, so the references they write can be found with their full paths. */
function opsAsData(ops: PatchOp[]): DocumentData {
  const root: Record<string, unknown> = { fields: {}, slots: {} }
  for (const op of ops) {
    if (op.value === undefined || op.path.length === 0) continue
    let parent: Record<string, unknown> | unknown[] = root
    op.path.forEach((segment, i) => {
      const container = parent as Record<string | number, unknown>
      if (i === op.path.length - 1) {
        container[segment] = op.value
        return
      }
      const existing = container[segment]
      const next = typeof existing === 'object' && existing !== null ? existing : typeof op.path[i + 1] === 'number' ? [] : {}
      container[segment] = next
      parent = next as Record<string, unknown> | unknown[]
    })
  }
  return root as DocumentData
}

/**
 * References and links that give a document id where the entry's `groupId` belongs, naming the right one.
 * Assistants mix the two up, and the document id would otherwise only be reported as missing content.
 */
async function groupIdIssues(deps: McpDeps, type: string, data: DocumentData): Promise<ContentIssue[]> {
  const { core } = deps
  const found = documentRefsWithPaths(core.registry, type, data).filter((r) => r.ref.kind === 'document')
  const documents = new Map<string, string | null>()
  for (const id of new Set(found.map((r) => r.ref.id))) {
    const doc = await core.getDocument(id)
    documents.set(id, doc && doc.groupId !== id ? doc.groupId : null)
  }
  const issues: ContentIssue[] = []
  for (const { path, ref } of found) {
    const groupId = documents.get(ref.id)
    if (groupId == null) continue
    const labels = docLabels(core.registry, type, path) ?? path.map(String)
    issues.push(contentIssue(path, labels, 'invalid', 'mcp.useGroupId', { id: ref.id, groupId }))
  }
  return issues
}

/** The change list as patch operations, converted from the agent format, and the problems of the changes that can't be. */
function toOps(
  deps: McpDeps,
  type: string,
  changes: z.infer<typeof updateDocumentInput>['changes'],
): { ops: PatchOp[]; issues: ContentIssue[] } {
  const { registry } = deps.core
  const issues: ContentIssue[] = []
  const ops: PatchOp[] = []
  for (const change of changes) {
    const path = parsePath(change.path)
    if (path === null) {
      issues.push(contentIssue([], [], 'invalid', 'mcp.change.badPath', { path: change.path }))
      continue
    }
    const hasValue = change.value !== undefined
    const remove = change.remove === true
    if (hasValue === remove) {
      const labels = docLabels(registry, type, path) ?? path.map(String)
      issues.push(contentIssue(path, labels, 'invalid', hasValue ? 'mcp.change.both' : 'mcp.change.neither'))
      continue
    }
    if (remove) {
      // Drafts may leave required fields empty, but removing one on purpose is a mistake worth reporting.
      const field = fieldAt(registry, type, path)
      if (field && !z.safeParse(field as z.ZodType, undefined).success) {
        const labels = docLabels(registry, type, path) ?? path.map(String)
        issues.push(contentIssue(path, labels, 'required', 'mcp.change.required'))
      } else {
        ops.push({ path })
      }
      continue
    }
    const result = fromAgent(registry, type, path, change.value)
    if (result.ok) ops.push({ path, value: result.value })
    else issues.push(...result.issues)
  }
  return { ops, issues }
}

/**
 * Saves the changes as a draft. Any problem is reported with every other one: the changes that can't be read,
 * the references that need a groupId, then what applying and checking the rest finds.
 */
async function updateDocument(deps: McpDeps, args: z.infer<typeof updateDocumentInput>, ctx: Ctx) {
  const doc = await documentOf(deps, args.id)
  const def = deps.core.registry.getType(doc.type)
  if (def.kind !== 'collection' && designedInCode(def.template)) throw new InlayError('invalid_operation', 'mcp.designedInCode')
  const { ops, issues } = toOps(deps, doc.type, args.changes)
  issues.push(...(await groupIdIssues(deps, doc.type, opsAsData(ops))))
  if (issues.length > 0) throw validation(mergeIssues(issues, patchProblems(deps.core.registry, doc.type, doc.data, ops)))
  let result
  try {
    result = await deps.core.patchDraft(
      doc.id,
      { baseRevisionId: args.baseRevisionId, ops, ...(args.message !== undefined && { message: args.message }) },
      ctx,
    )
  } catch (e) {
    if (e instanceof InlayError && e.code === 'conflict') throw new InlayError('conflict', 'mcp.conflict', e.params, e.details)
    throw e
  }
  const path = await livePath(deps, result.document)
  return {
    id: result.document.id,
    revisionId: result.document.headRev,
    changed: result.changed,
    changes: formatDiff(result.diff),
    previewUrl: previewLink(deps, path ?? '/'),
  }
}

async function createEntry(deps: McpDeps, args: z.infer<typeof createEntryInput>, ctx: Ctx) {
  const { core } = deps
  const { registry } = core
  const def = registry.getType(args.collection)
  if (def.kind !== 'collection') {
    const collections = registry.site.collections.map((c) => c.name).join(', ')
    throw new InlayError('invalid_operation', 'mcp.notCollection', { type: def.name, collections })
  }
  const converted = contentFromAgent(registry, def.name, args.content)
  const { fields = {}, slots = {} } = converted.content
  const issues = [
    ...(converted.ok ? [] : converted.issues),
    ...unknownContentKeys(registry, def.name, args.content),
    ...(await groupIdIssues(deps, def.name, { fields, slots } as DocumentData)),
  ]
  if (issues.length > 0) {
    // Saving would check the rest; it is checked here so every problem is reported at once.
    const checked = validateContent(registry, def.name, normalizeContent(registry, def.name, converted.content), 'draft')
    throw validation(mergeIssues(issues, checked.ok ? [] : checked.issues))
  }
  const doc = await core.createEntry(
    def.name,
    { ...converted.content, ...(args.message !== undefined && { message: args.message }) },
    ctx,
  )
  return created(deps, doc)
}

async function createTranslation(deps: McpDeps, args: z.infer<typeof createTranslationInput>, ctx: Ctx) {
  const source = await documentOf(deps, args.id)
  return created(deps, await deps.core.createTranslation(source.groupId, args.locale, ctx))
}

async function deleteEntry(deps: McpDeps, args: z.infer<typeof deleteEntryInput>, ctx: Ctx) {
  const { core } = deps
  const doc = await documentOf(deps, args.id)
  const translations: DocumentSummary[] = []
  for (const locale of core.registry.locales) {
    const found = await core.findTranslation(doc.groupId, locale)
    if (found && found.deletedAt === null) translations.push(found)
  }
  const main = translations.find((d) => d.locale === core.registry.defaultLocale) ?? doc
  await core.deleteEntry(doc.groupId, ctx)
  return { deleted: { groupId: doc.groupId, title: main.title, locales: translations.map((d) => d.locale) } }
}

async function listPendingChanges(deps: McpDeps) {
  const { core } = deps
  const pending = await core.listPendingChanges()
  const described = await core.describeChanges(pending.map((d) => d.id))
  return {
    changes: described.map(({ document: d, isNew, lines }) => ({
      id: d.id,
      groupId: d.groupId,
      type: d.type,
      locale: d.locale,
      title: d.title,
      isNew,
      lines,
    })),
  }
}

async function getPreviewLink(deps: McpDeps, args: z.infer<typeof previewLinkInput>) {
  if (args.id === undefined) return { previewUrl: previewLink(deps, '/') }
  const path = await livePath(deps, await documentOf(deps, args.id))
  return { previewUrl: previewLink(deps, path ?? '/') }
}

/** `update_document`, `create_entry`, `create_translation`, `delete_entry`, `list_pending_changes` and `get_preview_link`. */
export function register(server: McpServer, deps: McpDeps, ctx: Ctx): void {
  const run = <A>(fn: (args: A) => Promise<unknown>) => tool<A, unknown>(async (args) => ok(await fn(args)), deps.log)

  server.registerTool(
    'update_document',
    {
      title: t('mcp.tool.update_document.title'),
      description: t('mcp.tool.update_document.description'),
      inputSchema: updateDocumentInput,
      annotations: EDIT,
    },
    run((args: z.infer<typeof updateDocumentInput>) => updateDocument(deps, args, ctx)),
  )
  server.registerTool(
    'create_entry',
    {
      title: t('mcp.tool.create_entry.title'),
      description: t('mcp.tool.create_entry.description'),
      inputSchema: createEntryInput,
      annotations: EDIT,
    },
    run((args: z.infer<typeof createEntryInput>) => createEntry(deps, args, ctx)),
  )
  server.registerTool(
    'create_translation',
    {
      title: t('mcp.tool.create_translation.title'),
      description: t('mcp.tool.create_translation.description'),
      inputSchema: createTranslationInput,
      annotations: EDIT,
    },
    run((args: z.infer<typeof createTranslationInput>) => createTranslation(deps, args, ctx)),
  )
  server.registerTool(
    'delete_entry',
    {
      title: t('mcp.tool.delete_entry.title'),
      description: t('mcp.tool.delete_entry.description'),
      inputSchema: deleteEntryInput,
      annotations: DESTRUCTIVE,
    },
    run((args: z.infer<typeof deleteEntryInput>) => deleteEntry(deps, args, ctx)),
  )
  server.registerTool(
    'list_pending_changes',
    {
      title: t('mcp.tool.list_pending_changes.title'),
      description: t('mcp.tool.list_pending_changes.description'),
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    run(() => listPendingChanges(deps)),
  )
  server.registerTool(
    'get_preview_link',
    {
      title: t('mcp.tool.get_preview_link.title'),
      description: t('mcp.tool.get_preview_link.description'),
      inputSchema: previewLinkInput,
      annotations: READ_ONLY,
    },
    run((args: z.infer<typeof previewLinkInput>) => getPreviewLink(deps, args)),
  )
}
