import type { ContentInput } from '../types.js'

export interface ShippedDocument {
  key: string
  edition: number
  /** Keyed by locale. */
  content: Record<string, ContentInput>
}

export interface ShippedContent {
  type: string
  /** Which constructor made it; `buildRegistry` checks it against the type's kind. */
  via: 'content' | 'entries'
  documents: ShippedDocument[]
}

/** How shipped content refers to another shipped document; `key` defaults to `type` for singletons and globals. */
export type ShippedDocumentRef = { type: string; key?: string }

export const KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Ships a singleton or global. Its key is the type name. */
export function defineContent(
  type: string,
  def: { edition: number; content: Record<string, ContentInput> },
): ShippedContent {
  return { type, via: 'content', documents: [{ key: type, edition: def.edition, content: def.content }] }
}

/** Ships entries of a collection, each with a stable key. */
export function defineEntries(type: string, entries: ShippedDocument[]): ShippedContent {
  return { type, via: 'entries', documents: entries }
}
