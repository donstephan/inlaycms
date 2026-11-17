import { z } from 'zod'
import type { DocumentData, DocumentKind, RedirectSource, RevisionSource } from '../types.js'

export const EXPORT_FORMAT = 'inlay-export'
export const EXPORT_FORMAT_VERSION = 2

export interface Manifest {
  format: typeof EXPORT_FORMAT
  formatVersion: number
  inlayVersion: string
  exportedAt: string
  locales: string[]
  defaultLocale: string
  types: Array<{
    name: string
    kind: 'singleton' | 'collection' | 'global'
    label: string
    template: string
    schema: Record<string, unknown>
  }>
  counts: { documents: number; revisions: number; publishEvents: number; media: number; redirects: number }
  /** The site lock; absent in exports made before it existed. */
  siteLock?: { enabled: boolean; passwordHash: string | null }
}

export interface DocumentRecord {
  record: 'document'
  id: string
  kind: DocumentKind
  type: string
  groupId: string
  locale: string
  headRevision: number | null
  publishedRevision: number | null
  deletedAt: string | null
  createdAt: string
  key: string | null
  edition: number | null
  /** Absent: not recorded, filled from the publish events on import. Null: never published. */
  firstPublishedAt?: string | null
}

export interface RevisionRecord {
  record: 'revision'
  id: number
  documentId: string
  data: DocumentData
  authorId: string | null
  authorName: string
  source: RevisionSource
  message: string | null
  createdAt: string
  releaseId: string | null
}

export interface PublishEventRecord {
  record: 'publishEvent'
  id: number
  at: string
  userId: string | null
  userName: string
  source: RevisionSource
  message: string | null
  items: Array<{ documentId: string; revisionId: number | null; action: 'publish' | 'unpublish' }>
}

export type ContentRecord = DocumentRecord | RevisionRecord | PublishEventRecord

export interface RedirectRecord {
  id: number
  from: string
  to: { path: string } | { group: string } | { url: string }
  status: 301 | 302
  source: RedirectSource
  note: string | null
  createdById: string | null
  createdBy: string
  createdAt: string
}

export interface MediaRecord {
  id: string
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  defaultAlt: string | null
  createdById: string | null
  createdBy: string
  createdAt: string
}

export interface MediaDeletionRecord {
  mediaId: string
  filename: string
  deletedAt: string
  deletedById: string | null
  deletedBy: string
}

export interface MediaIndex {
  files: MediaRecord[]
  deletions: MediaDeletionRecord[]
}

/** Exports made before shipped content had editions say `initial` for what is now `release`. */
const source = z.preprocess(
  (v) => (v === 'initial' ? 'release' : v),
  z.enum(['admin', 'mcp', 'restore', 'import', 'release', 'system']),
)
const nullableString = z.string().nullable()
const nullableInt = z.number().int().nullable()

export const manifestSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  formatVersion: z.number().int().min(1),
  inlayVersion: z.string(),
  exportedAt: z.string(),
  locales: z.array(z.string()),
  defaultLocale: z.string(),
  types: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(['singleton', 'collection', 'global']),
      label: z.string(),
      template: z.string(),
      schema: z.record(z.string(), z.unknown()),
    }),
  ),
  counts: z.object({
    documents: z.number().int(),
    revisions: z.number().int(),
    publishEvents: z.number().int(),
    media: z.number().int(),
    redirects: z.number().int(),
  }),
  siteLock: z
    .object({ enabled: z.boolean(), passwordHash: z.string().regex(/^[^:\s]+:[^:\s]+$/).nullable() })
    .refine((lock) => !lock.enabled || lock.passwordHash !== null)
    .optional(),
})

const documentRecord = z.object({
  record: z.literal('document'),
  id: z.string(),
  kind: z.enum(['singleton', 'entry', 'global']),
  type: z.string(),
  groupId: z.string(),
  locale: z.string(),
  headRevision: nullableInt,
  publishedRevision: nullableInt,
  deletedAt: nullableString,
  createdAt: z.string(),
  key: nullableString.default(null),
  edition: nullableInt.default(null),
  firstPublishedAt: nullableString.optional(),
})

const revisionRecord = z.object({
  record: z.literal('revision'),
  id: z.number().int(),
  documentId: z.string(),
  data: z.custom<DocumentData>((v) => typeof v === 'object' && v !== null && !Array.isArray(v)),
  authorId: nullableString,
  authorName: z.string(),
  source,
  message: nullableString,
  createdAt: z.string(),
  releaseId: nullableString.default(null),
})

const publishEventRecord = z.object({
  record: z.literal('publishEvent'),
  id: z.number().int(),
  at: z.string(),
  userId: nullableString,
  userName: z.string(),
  source,
  message: nullableString,
  items: z.array(
    z.object({ documentId: z.string(), revisionId: nullableInt, action: z.enum(['publish', 'unpublish']) }),
  ),
})

export const contentRecordSchema = z.discriminatedUnion('record', [documentRecord, revisionRecord, publishEventRecord])

export const redirectsSchema = z.array(
  z.object({
    id: z.number().int(),
    from: z.string(),
    to: z.union([z.object({ path: z.string() }), z.object({ group: z.string() }), z.object({ url: z.string() })]),
    status: z.union([z.literal(301), z.literal(302)]),
    source: z.enum(['manual', 'auto', 'import']),
    note: nullableString,
    createdById: nullableString,
    createdBy: z.string(),
    createdAt: z.string(),
  }),
)

export const mediaIndexSchema = z.object({
  files: z.array(
    z.object({
      id: z.string(),
      filename: z.string(),
      mime: z.string(),
      size: z.number().int(),
      width: nullableInt,
      height: nullableInt,
      defaultAlt: nullableString,
      createdById: nullableString,
      createdBy: z.string(),
      createdAt: z.string(),
    }),
  ),
  deletions: z.array(
    z.object({
      mediaId: z.string(),
      filename: z.string(),
      deletedAt: z.string(),
      deletedById: nullableString,
      deletedBy: z.string(),
    }),
  ),
})

/** `inlay-export-<stamp>.tar.gz`, with the same stamp as backup file names. */
export function exportFileName(at: Date): string {
  return `inlay-export-${at.toISOString().replace(/[:.]/g, '-')}.tar.gz`
}
