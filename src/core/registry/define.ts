import type { z } from 'zod'
import type { Renderable, SafeHtml } from '../../jsx/html.js'
import type { AdminTheme } from '../types.js'
import type { ShippedContent } from './content.js'
import type { ReleaseMigration } from './migration.js'
import type { PageInfo, RenderContext } from './render.js'
import type { RouteDef } from './route.js'

export interface BlockDef<S extends z.ZodObject = z.ZodObject> {
  kind: 'block'
  name: string
  label: string
  help?: string
  schema: S
  /** Receives the slot's stored data. */
  render?(props: z.output<S>, ctx: RenderContext): Renderable
}

export interface BlockInput<S extends z.ZodObject> {
  name: string
  label: string
  help?: string
  schema: S
  render?: (props: z.output<S>, ctx: RenderContext) => Renderable
}

export function defineBlock<S extends z.ZodObject>(def: BlockInput<S>): BlockDef<S> {
  return { ...def, kind: 'block' }
}

export interface SlotDef {
  block: BlockDef
  label?: string
  optional?: boolean
}

export type Slots = Record<string, SlotDef>

export interface TemplateRenderProps<F extends z.ZodObject, S extends Slots> {
  fields: z.output<F>
  /** Each slot's rendered block; `null` when an optional slot is off. */
  slots: { [K in keyof S]: SafeHtml | null }
  /** Each slot's stored data; `null` when an optional slot is off. */
  data: { [K in keyof S]: z.output<S[K]['block']['schema']> | null }
  page: PageInfo
}

export type OgType = 'website' | 'article'

export interface TemplateDef<F extends z.ZodObject = z.ZodObject, S extends Slots = Slots> {
  kind: 'template'
  name: string
  label?: string
  fields: F
  /** Slot order is key order. */
  slots: S
  /** The page's Open Graph type (default `website`). */
  ogType?: OgType
  render?(props: TemplateRenderProps<F, S>, ctx: RenderContext): Renderable
}

export interface TemplateInput<F extends z.ZodObject, S extends Slots> {
  name: string
  label?: string
  fields: F
  slots?: S
  ogType?: OgType
  render?: (props: TemplateRenderProps<F, S>, ctx: RenderContext) => Renderable
}

export function defineTemplate<F extends z.ZodObject, S extends Slots = {}>(
  def: TemplateInput<F, S>,
): TemplateDef<F, S> {
  return {
    ...def,
    kind: 'template',
    slots: def.slots ?? ({} as S),
  }
}

export type SingletonPath = string | Record<string, string> | null

export interface SingletonDef {
  kind: 'singleton'
  name: string
  label: string
  help?: string
  template: TemplateDef
  path: SingletonPath
}

export function defineSingleton(def: Omit<SingletonDef, 'kind'>): SingletonDef {
  return { ...def, kind: 'singleton' }
}

export interface GlobalDef<T extends TemplateDef = TemplateDef> {
  kind: 'global'
  name: string
  label: string
  help?: string
  template: T
}

export function defineGlobal<T extends TemplateDef>(def: Omit<GlobalDef<T>, 'kind'>): GlobalDef<T> {
  return { ...def, kind: 'global' }
}

export interface CollectionDef<T extends TemplateDef = TemplateDef> {
  kind: 'collection'
  name: string
  label: string
  help?: string
  template: T
  /** URL pattern containing `:slug`; `null` for a data collection. */
  route: string | null
  customPaths: boolean
  titleField: string
}

export interface CollectionInput<T extends TemplateDef = TemplateDef> {
  name: string
  label: string
  help?: string
  template: T
  route?: string | null
  customPaths?: boolean
  titleField?: string
}

export function defineCollection<T extends TemplateDef>(def: CollectionInput<T>): CollectionDef<T> {
  return {
    ...def,
    kind: 'collection',
    route: def.route ?? null,
    customPaths: def.customPaths ?? false,
    titleField: def.titleField ?? 'title',
  }
}

export type TypeDef = SingletonDef | GlobalDef | CollectionDef

export interface AdminSettings {
  /** Shown in the admin's header; defaults to "Inlay". */
  name?: string
  /** A URL path under `/public/`, such as `/public/logo.svg`, shown in place of the name. */
  logo?: string
  /** A built-in daisyUI theme name, or colors laid over a base theme. */
  theme?: AdminTheme
}

/**
 * A redirect shipped in the site's code. `from` is a path (an old site's full URL is accepted; only its path is
 * used) that may have `:name` params; `to` is a path using those params, or an absolute `https://` URL.
 */
export interface RedirectDef {
  from: string
  to: string
  /** 301 (default) or 302. */
  status?: 301 | 302
}

/** Search and sharing defaults shipped in the site's code; a global's `f.seoDefaults()` values win over them. */
export interface SeoSettings {
  /** Contains `%s` exactly once, where a page's title goes, such as `%s | My Site`. */
  titleTemplate?: string
  description?: string
  /** A path under `/public/`, such as `/public/share.png`. */
  image?: string
}

export interface SiteDefinition {
  locales: string[]
  defaultLocale: string
  singletons: SingletonDef[]
  collections: CollectionDef[]
  globals: GlobalDef[]
  /** Serve the default-locale page when a translation is missing (default `true`). */
  translationFallback: boolean
  /** Content shipped with the site, activated by editions. */
  content: ShippedContent[]
  guide?: string
  admin: AdminSettings
  /** Search and sharing defaults. */
  seo: SeoSettings
  /** A singleton with `path: null`, rendered with status 404 when no page matches. */
  notFound: string | null
  /** Exact paths that answer without the site password, such as a health check. */
  publicPaths: string[]
  /** Names of the secrets the host provides, such as `SLACK_WEBHOOK`. */
  secrets: string[]
  /**
   * Response headers laid over Inlay's security defaults, by name; `false` leaves a default out. A header a response
   * sets itself (the admin's CSP, a route's own) wins over both.
   */
  headers: Record<string, string | false>
  routes: RouteDef[]
  /** Redirects shipped with the site's code. */
  redirects: RedirectDef[]
  migrations: ReleaseMigration[]
}

export interface SiteInput {
  locales: string[]
  defaultLocale: string
  singletons?: SingletonDef[]
  collections?: CollectionDef[]
  globals?: GlobalDef[]
  translationFallback?: boolean
  content?: ShippedContent[]
  guide?: string
  admin?: AdminSettings
  seo?: SeoSettings
  notFound?: string | null
  publicPaths?: string[]
  secrets?: string[]
  headers?: Record<string, string | false>
  routes?: RouteDef[]
  redirects?: RedirectDef[]
  migrations?: ReleaseMigration[]
}

export function defineSite(def: SiteInput): SiteDefinition {
  return {
    ...def,
    singletons: def.singletons ?? [],
    collections: def.collections ?? [],
    globals: def.globals ?? [],
    translationFallback: def.translationFallback ?? true,
    content: def.content ?? [],
    admin: def.admin ?? {},
    seo: def.seo ?? {},
    notFound: def.notFound ?? null,
    publicPaths: def.publicPaths ?? [],
    secrets: def.secrets ?? [],
    headers: def.headers ?? {},
    routes: def.routes ?? [],
    redirects: def.redirects ?? [],
    migrations: def.migrations ?? [],
  }
}
