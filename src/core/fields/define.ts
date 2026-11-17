import { z } from 'zod'
import type { Renderable } from '../../jsx/html.js'
import type { RichTextOptions } from '../richtext/schema.js'
import type { ContentRef, MediaStatus } from '../types.js'
import { innerOf, type Schema } from './zod-internals.js'

/** What a codec needs to read references: the document behind a `groupId`, and media files. */
export interface AgentRefs {
  document(groupId: string): { title: string; url: string | null } | null
  media(id: string): MediaStatus
  mediaUrl(id: string): string
}

export type AgentWrite = { ok: true; value: unknown } | { ok: false; problems: string[] }

/** How a field's value looks to an AI assistant, which reads and writes it over MCP. */
export interface AgentCodec {
  /** JSON Schema of the value as the assistant reads and writes it. No title; the walker adds it, and puts the field's help after any description. */
  schema: Record<string, unknown>
  read(value: unknown, refs: AgentRefs): unknown
  write(value: unknown): AgentWrite
}

/** A submitted form, keeping every value of a repeated name. */
export interface FormValues {
  get(name: string): string | undefined
  all(name: string): string[]
  names(): readonly string[]
}

/** What an admin widget renders one value with. */
export interface WidgetProps {
  /** Dotted form name, such as `slots.hero.data.headline`. */
  name: string
  /** Id of the main control. */
  id: string
  /** The stored value, possibly invalid or undefined. */
  value: unknown
  meta: FieldMeta
  optional: boolean
  readOnly: boolean
  describedBy: string | undefined
  invalid: boolean
  refs: AgentRefs
  /** The document's locale, for picker URLs. */
  locale: string
}

/** How a field's value is edited in the admin: the control(s) for one value, and reading it back. */
export interface AdminWidget {
  render(props: WidgetProps): Renderable
  /** The value from the submitted form; `undefined` means absent. `optional` is whether the field may be left out. */
  parse(form: FormValues, name: string, meta: FieldMeta, optional: boolean): unknown
  /** Several controls: the walker wraps it in <fieldset><legend> instead of <label for>. */
  fieldset?: boolean
}

export interface FieldMeta {
  kind: string
  label: string
  help?: string
  setting?: boolean
  /** A soft limit the admin and assistants are told about; going past it never fails validation. */
  suggestedLength?: number
  /** Marks the group whose values fill the page's SEO tags. */
  seo?: true
  /** Marks the group holding the site's search and sharing defaults. */
  seoDefaults?: true
  draft?: z.ZodType
  refs?: (value: unknown) => ContentRef[]
  options?: readonly string[]
  target?: string
  many?: boolean
  itemLabel?: string
  richText?: RichTextOptions
  agent?: AgentCodec
  admin?: AdminWidget
  /** The value a required field renders with when it has none (spec §6.2). Cloned before use. */
  empty?: unknown
  /** Applied by the reader to a stored value before it is checked, such as dropping options the code no longer offers. */
  readStored?: (value: unknown) => unknown
}

export const fieldRegistry: z.core.$ZodRegistry<FieldMeta> = z.registry<FieldMeta>()

interface Lookup {
  get(schema: object): FieldMeta | undefined
  add(schema: object, meta: FieldMeta): unknown
}

export function fieldMeta(schema: z.ZodType): FieldMeta | undefined {
  for (let current: Schema | undefined = schema; current; current = innerOf(current)) {
    const meta = (fieldRegistry as unknown as Lookup).get(current)
    if (meta) return meta
  }
  return undefined
}

export function defineField<T extends z.ZodType>(schema: T, meta: FieldMeta): T {
  ;(fieldRegistry as unknown as Lookup).add(schema, meta)
  return schema
}

/**
 * A link URL that is site-relative or uses http(s), mailto or tel. A site-relative one
 * may not have control characters (browsers strip them, so `/\t/x` would become `//x`)
 * or start with `/\` (which browsers read as `//`): both would lead to another site.
 */
export function isSafeUrl(s: string): boolean {
  if (s.startsWith('/')) {
    // eslint-disable-next-line no-control-regex
    return !s.startsWith('//') && !s.startsWith('/\\') && !/[\u0000-\u001f\u007f]/.test(s)
  }
  try {
    const u = new URL(s)
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(u.protocol)
  } catch {
    return false
  }
}
