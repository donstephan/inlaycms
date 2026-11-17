import type { Kysely } from 'kysely'
import type { Database } from './db/schema.js'
import type { MediaStore } from './media/store.js'
import type { RuleIndex } from './redirects/collapse.js'
import type { Registry } from './registry/registry.js'

export type PathSegment = string | number

export type IssueCode =
  | 'required'
  | 'invalid'
  | 'too_long'
  | 'too_short'
  | 'too_many'
  | 'too_few'
  | 'out_of_range'
  | 'unknown_field'
  | 'not_found'
  | 'wrong_collection'
  | 'not_routable'
  | 'duplicate_slug'
  | 'path_taken'
  | 'redirect_loop'
  | 'deleted_reference'
  | 'wrong_media_type'
  | 'missing_media'

export interface ContentIssue {
  path: PathSegment[]
  labels: string[]
  code: IssueCode
  message: string
}

/** Content as a developer writes it (shipped content, create input). `false` switches an optional slot off. */
export type ContentInput = {
  slug?: string
  path?: string
  fields?: Record<string, unknown>
  slots?: Record<string, Record<string, unknown> | false>
}

/** Content as stored in a revision. */
export type DocumentData = {
  slug?: string
  path?: string
  fields: Record<string, unknown>
  slots: Record<string, { enabled: boolean; data: Record<string, unknown> }>
}

export type DocumentKind = 'singleton' | 'entry' | 'global'

export interface Usage {
  documentId: string
  groupId: string
  type: string
  locale: string
  title: string
  in: 'draft' | 'published' | 'draft-and-published'
}

export type ContentRef = { kind: 'document' | 'media'; id: string }

export type LinkValue = { text?: string } & ({ document: string } | { url: string })
export type ImageValue = { media: string; alt?: string }
export type FileValue = { media: string }
/** An image or file in shipped content: read from disk and imported when the document is written. */
export type ShippedFile = { file: string | URL; alt?: string }

export interface MediaInfo {
  id: string
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  defaultAlt: string | null
  createdBy: string
  createdAt: string
}

export type MediaStatus =
  | { status: 'present'; media: MediaInfo }
  | { status: 'deleted'; filename: string; deletedAt: string }
  | { status: 'unknown' }

export type Role = 'owner' | 'editor' | 'system'

export interface Actor {
  id: string | null
  name: string
  role: Role
}

export type RevisionSource = 'admin' | 'mcp' | 'restore' | 'import' | 'release' | 'system'

/** Who is acting and through which channel; recorded on every revision and publish event. */
export interface Ctx {
  actor: Actor
  source: RevisionSource
  /** The release whose migration functions are writing; recorded on their revisions. */
  releaseId?: string
}

/** What every core module function takes first. `db` may be a transaction. */
export interface UploadLimits {
  maxBytes?: number
  types?: string[]
}

export interface CoreDeps {
  db: Kysely<Database>
  registry: Registry
  now: () => Date
  media: MediaStore | null
  /** Where backups are written; the backup methods need it. */
  backups?: string
  uploads: { maxBytes: number; types: readonly string[] }
  /** Holds the redirect rules ready for matching across requests. Without it, they are read per request. */
  rules?: RuleCache
  /** A loaded release's shipped files: each source as written in the site to where the release keeps the file. */
  shippedFiles?: ReadonlyMap<string, string>
}

/** A redirect rule as `resolvePath` matches it. */
export interface MatchRule {
  from: string
  to_path: string | null
  to_group_id: string | null
  status: 301 | 302
}

/** The rule index `resolvePath` last built, with the database change counters it was built at. */
export interface RuleCache {
  current: { key: string; index: RuleIndex<MatchRule> } | null
}

export interface DocumentSummary {
  id: string
  groupId: string
  kind: DocumentKind
  type: string
  locale: string
  title: string
  headRev: number
  publishedRev: number | null
  deletedAt: string | null
  updatedAt: string
}

export interface RevisionMeta {
  id: number
  createdAt: string
  authorId: string | null
  authorName: string
  source: RevisionSource
  message: string | null
}

/** One thing that happened lately, for the dashboard. */
export type Activity =
  | { kind: 'edit'; at: string; authorName: string; source: RevisionSource; document: DocumentSummary; revisionId: number; count: number }
  | { kind: 'publish' | 'unpublish'; at: string; authorName: string; source: RevisionSource; documents: DocumentSummary[] }

export interface DocumentView extends DocumentSummary {
  state: 'head' | 'published'
  revision: RevisionMeta
  data: DocumentData
}

/** One readable change between two versions of a document. */
export interface DiffEntry {
  path: PathSegment[]
  labels: string[]
  change: 'added' | 'removed' | 'changed'
  before?: unknown
  after?: unknown
}

/** Which content the live site shows: published revisions, or head revisions (drafts included) for preview. */
export type LiveState = 'published' | 'preview'

/** A document as the live site shows it in a requested locale. */
export interface LiveDocument {
  documentId: string
  groupId: string
  kind: DocumentKind
  type: string
  /** The requested locale. */
  locale: string
  /** The locale whose content is shown. */
  contentLocale: string
  fallback: boolean
  /** Decoded, locale-prefixed site path; `null` for globals, data entries and path-less singletons. */
  path: string | null
  title: string
  slug: string | null
  revisionId: number
  /** The shown revision's `created_at`. */
  updatedAt: string
  /** When Inlay first published the document; `null` if it never has been. */
  publishedAt: string | null
  data: DocumentData
}

/**
 * What a request path resolves to. A redirect's `location` is already encoded: a site path, or with
 * `external` the full https URL of a rule's URL target.
 */
export type RouteMatch =
  | { kind: 'page'; document: LiveDocument }
  | { kind: 'redirect'; location: string; status: 301 | 302; external?: true }
  /** `loop` lists the `from` of redirect rules that were skipped because they would go round in a loop. */
  | { kind: 'not_found'; locale: string; loop?: string[] }

export type RedirectSource = 'manual' | 'auto' | 'import'

/** A redirect rule. `from` is a decoded site path; `:name` segments make it a pattern. */
export interface Redirect {
  id: number
  from: string
  /**
   * A site path (which may use the `:name` params of `from`), a document's translation group, or a
   * full https URL on another site.
   */
  to: { path: string } | { document: string } | { url: string }
  status: 301 | 302
  source: RedirectSource
  note: string | null
  createdBy: string
  createdAt: string
}

export interface RedirectInput {
  /** A site path, or a full http(s) URL whose origin is dropped. */
  from: string
  /** A site path, a full `https://` URL on another site, or a document's translation group. */
  to: string | { document: string }
  status?: 301 | 302
  note?: string
}

/** A redirect rule from the site's code. Read-only: it changes only with a new release. */
export interface CodeRedirect {
  from: string
  to: { path: string } | { url: string }
  status: 301 | 302
  /** An admin rule with the same `from` answers first. */
  overridden: boolean
  /** A published page answers at the exact `from`, so the rule never fires. */
  hidden: boolean
}

export type ThemeColor =
  | 'base-100' | 'base-200' | 'base-300' | 'base-content'
  | 'primary' | 'primary-content'
  | 'secondary' | 'secondary-content'
  | 'accent' | 'accent-content'
  | 'neutral' | 'neutral-content'
  | 'info' | 'info-content'
  | 'success' | 'success-content'
  | 'warning' | 'warning-content'
  | 'error' | 'error-content'

export interface CustomTheme {
  base?: string
  scheme?: 'light' | 'dark'
  colors: Partial<Record<ThemeColor, string>>
}

/** A built-in daisyUI theme name, or colors laid over a base theme. */
export type AdminTheme = string | CustomTheme
