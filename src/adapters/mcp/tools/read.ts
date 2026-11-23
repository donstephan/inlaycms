import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { agentLinks, toAgent } from '../../../core/agent/format.js'
import { agentTypeSchema } from '../../../core/agent/schema.js'
import { docLabels } from '../../../core/content/schema.js'
import { fold } from '../../../core/content/text-match.js'
import { InlayError } from '../../../core/errors.js'
import { t } from '../../../core/messages/index.js'
import { designedInCode } from '../../../core/registry/designed.js'
import type { Registry } from '../../../core/registry/registry.js'
import { singletonPath, withLocale } from '../../../core/site/paths.js'
import type { Ctx, DocumentSummary, DocumentView } from '../../../core/types.js'
import { previewLink } from '../../site/preview.js'
import { loadAgentRefs, pageUrl } from '../agent-refs.js'
import { livePath, READ_ONLY } from '../documents.js'
import { issueJson, ok, tool } from '../results.js'
import type { McpDeps } from '../server.js'

const describeTypeInput = z.object({ type: z.string().describe(t('mcp.param.type')) })

const listGapsInput = z.object({
  type: z.string().describe(t('mcp.param.gapType')).optional(),
  limit: z.number().int().min(1).max(100).describe(t('mcp.param.gapsLimit')).optional(),
  offset: z.number().int().min(0).describe(t('mcp.param.gapsOffset')).optional(),
})

const getDocumentInput = z.object({
  id: z.string().describe(t('mcp.param.id')).optional(),
  type: z.string().describe(t('mcp.param.type')).optional(),
  slug: z.string().describe(t('mcp.param.slug')).optional(),
  locale: z.string().describe(t('mcp.param.documentLocale')).optional(),
  state: z.enum(['draft', 'published']).describe(t('mcp.param.state')).optional(),
})

const searchEntriesInput = z.object({
  collection: z.string().describe(t('mcp.param.collection')),
  query: z.string().describe(t('mcp.param.query')).optional(),
  locale: z.string().describe(t('mcp.param.locale')).optional(),
  limit: z.number().int().min(1).max(50).describe(t('mcp.param.limit')).optional(),
})

const findTextInput = z.object({
  text: z.string().describe(t('mcp.param.findText')),
  type: z.string().describe(t('mcp.param.findType')).optional(),
  locale: z.string().describe(t('mcp.param.findLocale')).optional(),
  limit: z.number().int().min(1).max(100).describe(t('mcp.param.findLimit')).optional(),
  offset: z.number().int().min(0).describe(t('mcp.param.findOffset')).optional(),
})

/** `locale`, or the default locale when it's absent. An unknown locale is refused. */
function localeOf(registry: Registry, locale: string | undefined): string {
  if (locale === undefined) return registry.defaultLocale
  if (!registry.locales.includes(locale)) {
    throw new InlayError('invalid_operation', 'mcp.unknownLocale', { locale, locales: registry.locales.join(', ') })
  }
  return locale
}

/**
 * Refuses a type the site doesn't have: one with documents is hidden (spec §6.4), and says so without showing
 * them; any other is the usual not-found.
 */
async function requireType(deps: McpDeps, type: string): Promise<void> {
  const { core } = deps
  if (core.registry.types.has(type)) return
  if ((await core.hiddenDocuments()).types.some((hidden) => hidden.type === type)) {
    throw new InlayError('not_found', 'mcp.hiddenType', { type })
  }
  throw new InlayError('not_found', 'error.typeNotFound', { name: type })
}

async function describeSite(deps: McpDeps) {
  const { core, baseUrl } = deps
  const { registry } = core
  const { locales, defaultLocale, site } = registry
  const documents = async (type: string) => {
    const out: Record<string, { id: string; groupId: string; title: string; published: boolean }> = {}
    for (const locale of locales) {
      const doc = await core.findSingleton(type, locale)
      if (doc) out[locale] = { id: doc.id, groupId: doc.groupId, title: doc.title, published: doc.publishedRev !== null }
    }
    return out
  }
  const singletons = []
  for (const def of site.singletons) {
    const urls: Record<string, string | null> = {}
    for (const locale of locales) {
      const path = singletonPath(def, locale, defaultLocale)
      if (path !== null) urls[locale] = pageUrl(baseUrl, withLocale(registry, locale, path), registry.site.trailingSlash)
    }
    singletons.push({
      type: def.name,
      label: def.label,
      help: def.help ?? null,
      ...(designedInCode(def.template) && { designedInCode: true }),
      urls,
      documents: await documents(def.name),
    })
  }
  const globals = []
  for (const def of site.globals) {
    globals.push({
      type: def.name,
      label: def.label,
      help: def.help ?? null,
      ...(designedInCode(def.template) && { designedInCode: true }),
      documents: await documents(def.name),
    })
  }
  const collections = []
  for (const def of site.collections) {
    const entryCount: Record<string, number> = {}
    for (const locale of locales) entryCount[locale] = (await core.listEntries(def.name, { locale })).length
    collections.push({
      type: def.name,
      label: def.label,
      help: def.help ?? null,
      route: def.route,
      routed: def.route !== null || def.customPaths,
      customPaths: def.customPaths,
      entryCount,
    })
  }
  return {
    guide: site.guide ?? null,
    release: deps.release ? { name: deps.release.name } : null,
    locales,
    defaultLocale,
    singletons,
    globals,
    collections,
    gaps: await core.gapSummary(),
  }
}

async function describeType(deps: McpDeps, type: string) {
  const { registry } = deps.core
  await requireType(deps, type)
  const def = registry.getType(type)
  return {
    type: def.name,
    kind: def.kind,
    label: def.label,
    help: def.help ?? null,
    ...(def.kind === 'collection' && { titleField: def.titleField }),
    ...(def.kind !== 'collection' && designedInCode(def.template) && { designedInCode: true, note: t('mcp.designedInCode') }),
    slots: Object.entries(def.template.slots).map(([key, slot]) => ({
      key,
      label: slot.label ?? slot.block.label,
      help: slot.block.help ?? null,
      optional: slot.optional === true,
    })),
    schema: agentTypeSchema(registry, def.name),
  }
}

async function listGaps(deps: McpDeps, args: z.infer<typeof listGapsInput>) {
  if (args.type !== undefined) await requireType(deps, args.type)
  const gaps = await deps.core.listGaps(args.type === undefined ? {} : { type: args.type })
  const offset = args.offset ?? 0
  return {
    total: gaps.length,
    gaps: gaps.slice(offset, offset + (args.limit ?? 50)).map(({ document: doc, issues }) => ({
      id: doc.id,
      groupId: doc.groupId,
      type: doc.type,
      locale: doc.locale,
      title: doc.title,
      fields: issues.map((issue) => issueJson(issue)),
    })),
  }
}

/** The document `getDocumentInput` points at, in the requested state. */
async function findDocument(deps: McpDeps, args: z.infer<typeof getDocumentInput>): Promise<DocumentView> {
  const { core } = deps
  const { registry } = core
  const state = args.state === 'published' ? 'published' : 'head'
  let id = args.id
  if (id !== undefined && args.locale !== undefined) {
    const locale = localeOf(registry, args.locale)
    const given = await core.getDocument(id)
    if (given && given.deletedAt === null && given.locale !== locale) {
      const translation = await core.findTranslation(given.groupId, locale)
      if (!translation || translation.deletedAt !== null) throw new InlayError('not_found', 'mcp.notTranslated', { locale })
      id = translation.id
    }
  }
  if (id === undefined) {
    if (args.type === undefined) throw new InlayError('invalid_operation', 'mcp.findWhat')
    const def = registry.getType(args.type)
    const locale = localeOf(registry, args.locale)
    let found: DocumentSummary | null
    if (def.kind === 'collection') {
      if (docLabels(registry, def.name, ['slug']) === null) throw new InlayError('invalid_operation', 'mcp.noSlugs', { type: def.name })
      if (args.slug === undefined) throw new InlayError('invalid_operation', 'mcp.slugRequired', { type: def.name })
      found = await core.findEntry(def.name, args.slug, locale)
      if (!found) {
        const original = locale === registry.defaultLocale ? null : await core.findEntry(def.name, args.slug)
        throw original
          ? new InlayError('not_found', 'mcp.notTranslated', { locale })
          : new InlayError('not_found', 'mcp.entryNotFound', { type: def.name, slug: args.slug })
      }
    } else {
      found = await core.findSingleton(def.name, locale)
      if (!found) {
        throw locale === registry.defaultLocale
          ? new InlayError('not_found', 'error.notFound', { name: def.label })
          : new InlayError('not_found', 'mcp.notTranslated', { locale })
      }
    }
    id = found.id
  }
  const doc = await core.getDocument(id, { state })
  if (doc && doc.deletedAt === null) return doc
  if (state === 'published') {
    const head = await core.getDocument(id)
    if (head && head.deletedAt === null) throw new InlayError('not_found', 'mcp.notPublished', { title: head.title })
  }
  throw new InlayError('not_found', 'mcp.documentNotFound', { id })
}

async function getDocument(deps: McpDeps, args: z.infer<typeof getDocumentInput>) {
  const { core, baseUrl } = deps
  const { registry } = core
  const doc = await findDocument(deps, args)
  const refs = await loadAgentRefs(deps, doc.type, doc.locale, doc.data)
  const path = await livePath(deps, doc)
  return {
    id: doc.id,
    groupId: doc.groupId,
    type: doc.type,
    kind: doc.kind,
    locale: doc.locale,
    title: doc.title,
    revisionId: doc.revision.id,
    publishedRevisionId: doc.publishedRev,
    hasUnpublishedChanges: doc.publishedRev !== doc.headRev,
    url: pageUrl(baseUrl, await livePath(deps, doc, 'published'), deps.core.registry.site.trailingSlash),
    previewUrl: previewLink(deps, path ?? '/'),
    content: toAgent(registry, doc.type, doc.data, refs),
    links: agentLinks(registry, doc.type, doc.data, refs),
  }
}

async function searchEntries(deps: McpDeps, args: z.infer<typeof searchEntriesInput>) {
  const { core } = deps
  const { registry } = core
  const def = registry.getType(args.collection)
  if (def.kind !== 'collection') {
    const collections = registry.site.collections.map((c) => c.name).join(', ')
    throw new InlayError('invalid_operation', 'mcp.notCollection', { type: def.name, collections })
  }
  const locale = localeOf(registry, args.locale)
  const hits = await core.searchEntries(def.name, args.query ?? '', {
    locale,
    ...(args.limit !== undefined && { limit: args.limit }),
  })
  const live = await core.liveDocuments(
    hits.map((hit) => hit.groupId),
    locale,
    { state: 'preview' },
  )
  return {
    entries: hits.map((hit) => ({
      id: hit.id,
      groupId: hit.groupId,
      title: hit.title,
      locale: hit.locale,
      slug: live.get(hit.groupId)?.slug ?? null,
      published: hit.publishedRev !== null,
      hasUnpublishedChanges: hit.publishedRev !== hit.headRev,
      snippet: hit.snippet,
    })),
  }
}

async function findText(deps: McpDeps, args: z.infer<typeof findTextInput>) {
  if (fold(args.text).text.trim() === '') throw new InlayError('invalid_operation', 'mcp.findText.blank')
  if (args.type !== undefined) await requireType(deps, args.type)
  const locale = args.locale === undefined ? undefined : localeOf(deps.core.registry, args.locale)
  const { total, documents, designedInCode } = await deps.core.findText(args.text, {
    ...(args.type !== undefined && { type: args.type }),
    ...(locale !== undefined && { locale }),
    ...(args.limit !== undefined && { limit: args.limit }),
    ...(args.offset !== undefined && { offset: args.offset }),
  })
  return {
    total,
    documents: documents.map(({ document: d, matches }) => ({
      id: d.id,
      groupId: d.groupId,
      type: d.type,
      kind: d.kind,
      title: d.title,
      locale: d.locale,
      revisionId: d.headRev,
      published: d.publishedRev !== null,
      hasUnpublishedChanges: d.publishedRev !== d.headRev,
      matches: matches.map((m) => ({ ...m, path: m.path.join('.') })),
    })),
    ...(designedInCode.length > 0 && { designedInCode, note: t('mcp.findText.designedInCode') }),
  }
}

/** `describe_site`, `describe_type`, `get_document`, `search_entries`, `find_text` and `list_gaps`. */
export function register(server: McpServer, deps: McpDeps, _ctx: Ctx): void {
  const run = <A>(fn: (args: A) => Promise<unknown> | unknown) =>
    tool<A, unknown>(async (args) => ok(await fn(args)), deps.log)

  server.registerTool(
    'describe_site',
    {
      title: t('mcp.tool.describe_site.title'),
      description: t('mcp.tool.describe_site.description'),
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    run(() => describeSite(deps)),
  )
  server.registerTool(
    'describe_type',
    {
      title: t('mcp.tool.describe_type.title'),
      description: t('mcp.tool.describe_type.description'),
      inputSchema: describeTypeInput,
      annotations: READ_ONLY,
    },
    run((args: z.infer<typeof describeTypeInput>) => describeType(deps, args.type)),
  )
  server.registerTool(
    'get_document',
    {
      title: t('mcp.tool.get_document.title'),
      description: t('mcp.tool.get_document.description'),
      inputSchema: getDocumentInput,
      annotations: READ_ONLY,
    },
    run((args: z.infer<typeof getDocumentInput>) => getDocument(deps, args)),
  )
  server.registerTool(
    'search_entries',
    {
      title: t('mcp.tool.search_entries.title'),
      description: t('mcp.tool.search_entries.description'),
      inputSchema: searchEntriesInput,
      annotations: READ_ONLY,
    },
    run((args: z.infer<typeof searchEntriesInput>) => searchEntries(deps, args)),
  )
  server.registerTool(
    'find_text',
    {
      title: t('mcp.tool.find_text.title'),
      description: t('mcp.tool.find_text.description'),
      inputSchema: findTextInput,
      annotations: READ_ONLY,
    },
    run((args: z.infer<typeof findTextInput>) => findText(deps, args)),
  )
  server.registerTool(
    'list_gaps',
    {
      title: t('mcp.tool.list_gaps.title'),
      description: t('mcp.tool.list_gaps.description'),
      inputSchema: listGapsInput,
      annotations: READ_ONLY,
    },
    run((args: z.infer<typeof listGapsInput>) => listGaps(deps, args)),
  )
}
