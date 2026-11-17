import type { Generated } from 'kysely';

export interface DocumentsTable {
  id: string;
  kind: 'singleton' | 'entry' | 'global';
  type: string;
  group_id: string;
  locale: string;
  head_rev: number | null;
  published_rev: number | null;
  head_slug: string | null;
  published_slug: string | null;
  head_path: string | null;
  published_path: string | null;
  deleted_at: string | null;
  created_at: string;
  key: string | null;
  edition: number | null;
  first_published_at: string | null;
}

export interface RevisionsTable {
  id: Generated<number>;
  document_id: string;
  /** JSON */
  data: string;
  author_id: string | null;
  author_name: string;
  source: string;
  message: string | null;
  created_at: string;
  release_id: string | null;
}

export interface PublishEventsTable {
  id: Generated<number>;
  at: string;
  user_id: string | null;
  user_name: string;
  source: string;
  message: string | null;
  /** JSON: Array<{ documentId, revisionId: number | null, action: 'publish' | 'unpublish' }> */
  items: string;
}

export interface RefsTable {
  from_document_id: string;
  from_revision_id: number;
  to_kind: 'document' | 'media';
  to_id: string;
}

export interface MediaTable {
  id: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  default_alt: string | null;
  created_by_id: string | null;
  created_by_name: string;
  created_at: string;
}

export interface MediaDeletionsTable {
  id: Generated<number>;
  media_id: string;
  filename: string;
  deleted_at: string;
  deleted_by_id: string | null;
  deleted_by_name: string;
}

export interface RedirectsTable {
  id: Generated<number>;
  /** Decoded site path; `:name` segments make it a pattern. */
  from_path: string;
  to_path: string | null;
  to_group_id: string | null;
  status: 301 | 302;
  source: 'manual' | 'auto' | 'import';
  note: string | null;
  created_by_id: string | null;
  created_by_name: string;
  created_at: string;
}

/**
 * better-auth's `user` table (created by its own migrations, camelCase
 * columns). Only the columns Inlay reads; better-auth owns the rest.
 */
export interface UserTable {
  id: string;
  name: string;
  email: string;
  /** `owner` or `editor`; anything else has no access. */
  role: string | null;
  /** 0 or 1 */
  banned: number | null;
  /** ISO timestamp; a ban with no expiry is permanent. */
  banExpires: string | null;
}

/** better-auth's `oauthClient` table (OAuth provider plugin). Only the columns Inlay reads. */
export interface OAuthClientTable {
  clientId: string;
  name: string | null;
  /** JSON: string[] */
  redirectUris: string;
}

/** Per user, when their OAuth access tokens stopped counting (a password reset). */
export interface TokenCutoffsTable {
  user_id: string;
  /** Seconds since the epoch: tokens whose `iat` is at or before this are refused. */
  before: number;
}

/** The site password lock: at most one row (`id = 1`). */
export interface SiteLockTable {
  id: number;
  /** 0 or 1: whether visitors need the password. */
  enabled: number;
  /** scrypt hash of the site password; never the password itself. */
  password_hash: string | null;
}

/** A release the host has received (spec §9). At most one is `current`. */
export interface ReleasesTable {
  id: string;
  name: string;
  state: 'staged' | 'current' | 'previous' | 'deleted';
  file: string;
  checksum: string;
  /** The fingerprint of the key that signed it. */
  signed_by: string;
  inlay_range: string;
  /** JSON: string[], the secret names the release declares. */
  secrets: string;
  /** JSON: the JSON Schema of every type at pack time. Never used to validate content. */
  schema: string;
  pushed_by: string | null;
  pushed_at: string;
  activated_at: string | null;
  deactivated_at: string | null;
}

/** A migration function a release has run, so re-activating it doesn't run it again. */
export interface ReleaseMigrationsTable {
  release_id: string;
  name: string;
  ran_at: string;
}

export interface Database {
  documents: DocumentsTable;
  revisions: RevisionsTable;
  publish_events: PublishEventsTable;
  refs: RefsTable;
  media: MediaTable;
  media_deletions: MediaDeletionsTable;
  redirects: RedirectsTable;
  token_cutoffs: TokenCutoffsTable;
  site_lock: SiteLockTable;
  releases: ReleasesTable;
  release_migrations: ReleaseMigrationsTable;
  user: UserTable;
  oauthClient: OAuthClientTable;
}
