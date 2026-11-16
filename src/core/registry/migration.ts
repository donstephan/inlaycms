import type { ContentInput, DocumentData, MediaInfo } from '../types.js'

export interface MigrationDocument {
  id: string
  groupId: string
  type: string
  locale: string
  slug: string | null
  key: string | null
  edition: number | null
  deleted: boolean
  /** The type or locale is not in the current site. */
  hidden: boolean
}

export interface MigrationContext {
  /** Every type with documents, hidden ones included. */
  types(): Promise<string[]>
  list(type: string, opts?: { locale?: string; includeDeleted?: boolean }): Promise<MigrationDocument[]>
  read(id: string): Promise<{ head: DocumentData | null; published: DocumentData | null }>
  create(type: string, input: ContentInput & { locale?: string; key?: string }): Promise<{ id: string; groupId: string }>
  /** Writes `data` (the stored shape `read` returns) as the head draft. */
  save(id: string, data: DocumentData): Promise<void>
  publish(ids: string[]): Promise<void>
  media: { list(): Promise<MediaInfo[]> }
}

export interface ReleaseMigration {
  name: string
  run(ctx: MigrationContext): Promise<void>
}

/** A migration function: runs once per release, at activation (spec §8.3). */
export function defineMigration(def: ReleaseMigration): ReleaseMigration {
  return def
}
