import type { z } from 'zod'
import type { SafeHtml } from '../../jsx/html.js'
import type { VariantFormat } from '../media/variants.js'
import type { RichTextDoc } from '../richtext/schema.js'
import type { FileValue, ImageValue, LinkValue } from '../types.js'
import type { CollectionDef, GlobalDef, TemplateDef } from './define.js'

export interface ResolvedImage {
  id: string
  /** The original: `/media/<id>`. */
  url: string
  alt: string
  width: number | null
  height: number | null
  mime: string
  /** The smallest variant at least `width` wide (or the largest); `webp` by default. */
  src(width: number, format?: VariantFormat): string
  /** Every variant up to the original's width; `webp` by default. */
  srcset(format?: VariantFormat): string
}

export interface ResolvedFile {
  id: string
  url: string
  filename: string
  mime: string
  size: number
}

export interface ResolvedLink {
  /** Encoded. */
  href: string
  text: string
  external: boolean
}

export interface Entry<F = Record<string, unknown>> {
  /** The translation group. */
  id: string
  type: string
  /** The locale whose content is shown. */
  locale: string
  fallback: boolean
  /** The encoded site path, or `null` for data entries. */
  url: string | null
  title: string
  slug: string | null
  updatedAt: string
  fields: F
}

export interface QueryOptions<F = Record<string, unknown>> {
  filter?: (e: Entry<F>) => boolean
  sort?: 'newest' | 'oldest' | { field: string; direction?: 'asc' | 'desc' }
  limit?: number
  /** 1-based; ignored without `limit`. */
  page?: number
}

export interface QueryResult<F = Record<string, unknown>> {
  items: Entry<F>[]
  total: number
  page: number
  pages: number
}

export interface PageInfo {
  title: string
  type: string
  /** The requested locale. */
  locale: string
  /** The locale whose content is shown. */
  contentLocale: string
  fallback: boolean
  /** The decoded site path; `''` for a page without one. */
  path: string
  page: number
}

export interface RenderContext {
  locale: string
  defaultLocale: string
  locales: readonly string[]
  preview: boolean
  page: number
  baseUrl: string
  alternates: Array<{ locale: string; path: string; fallback: boolean }>
  /** Alt is the value's, then the media's default, then `''`. `null` when the media is missing. */
  image(v: ImageValue | null | undefined): ResolvedImage | null
  file(v: FileValue | null | undefined): ResolvedFile | null
  /** `null` when the target document isn't live. Text is the value's, then the target's title, then the URL. */
  link(v: LinkValue | null | undefined): ResolvedLink | null
  richText(doc: RichTextDoc | null | undefined): SafeHtml
  /** Live entries in the given order; ones that aren't live are skipped. */
  entries<F = Record<string, unknown>>(ids: string | readonly string[] | null | undefined): Promise<Entry<F>[]>
  /** Every live entry of the collection, filtered, sorted (`newest` by default) and paginated. */
  query<T extends TemplateDef = TemplateDef>(
    collection: string | CollectionDef<T>,
    opts?: QueryOptions<z.output<T['fields']>>,
  ): Promise<QueryResult<z.output<T['fields']>>>
  global<T extends TemplateDef = TemplateDef>(g: string | GlobalDef<T>): Promise<z.output<T['fields']> | null>
}
