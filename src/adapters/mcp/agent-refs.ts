import { agentRefsNeeded, type AgentRefs } from '../../core/agent/format.js'
import { encodePath } from '../../core/site/paths.js'
import type { DocumentData } from '../../core/types.js'
import type { McpDeps } from './server.js'

/** The absolute URL of a decoded site path, or `null` for a document without a page. */
export function pageUrl(baseUrl: string, path: string | null): string | null {
  return path === null ? null : `${baseUrl}${encodePath(path)}`
}

/** The absolute URL of a media file. */
export function mediaUrl(baseUrl: string, id: string): string {
  return `${baseUrl}/media/${id}`
}

/** Everything `toAgent` and `agentLinks` look up for `data`, read up front in `locale` (drafts included). */
export async function loadAgentRefs(
  deps: Pick<McpDeps, 'core' | 'baseUrl'>,
  type: string,
  locale: string,
  data: DocumentData,
): Promise<AgentRefs> {
  const { core, baseUrl } = deps
  const needed = agentRefsNeeded(core.registry, type, data)
  const documents = await core.liveDocuments(needed.documents, locale, { state: 'preview' })
  const media = await core.lookupMedia(needed.media)
  return {
    document(groupId) {
      const doc = documents.get(groupId)
      return doc ? { title: doc.title, url: pageUrl(baseUrl, doc.path) } : null
    },
    media: (id) => media.get(id) ?? { status: 'unknown' },
    mediaUrl: (id) => mediaUrl(baseUrl, id),
  }
}
