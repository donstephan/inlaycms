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

export interface TemplateDef<F extends z.ZodObject = z.ZodObject, S extends Slots = Slots> {
  kind: 'template'
  name: string
  label?: string
  fields: F
  /** Slot order is key order. */
  slots: S
  render?(props: TemplateRenderProps<F, S>, ctx: RenderContext): Renderable
}

export interface TemplateInput<F extends z.ZodObject, S extends Slots> {
  name: string
  label?: string
  fields: F
  slots?: S
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
  /** A singleton with `path: null`, rendered with status 404 when no page matches. */
  notFound: string | null
  /** Exact paths that answer without the site password, such as a health check. */
  publicPaths: string[]
  /** Names of the secrets the host provides, such as `SLACK_WEBHOOK`. */
  secrets: string[]
  routes: RouteDef[]
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
  notFound?: string | null
  publicPaths?: string[]
  secrets?: string[]
  routes?: RouteDef[]
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
    notFound: def.notFound ?? null,
    publicPaths: def.publicPaths ?? [],
    secrets: def.secrets ?? [],
    routes: def.routes ?? [],
    migrations: def.migrations ?? [],
  }
}
