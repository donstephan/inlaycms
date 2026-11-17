/// <reference path="./markdown-modules.ts" preserve="true" />
/**
 * What a site's code imports (`inlaycms/site`): the definitions and the types
 * templates, routes and migrations use, and nothing that reaches the server.
 * A release may import only this and the JSX runtime.
 */
import { richTextText, type RichTextDoc } from './core/richtext/schema.js'
export { z } from 'zod'
export { f } from './core/fields/builtins.js'
export { defineConfig, type InlayConfig } from './config.js'
export { escapeHtml, raw, SafeHtml, type Html, type Renderable } from './jsx/html.js'
export { defineField, type AdminWidget, type FieldMeta, type FormValues, type WidgetProps } from './core/fields/define.js'
export {
  defineContent,
  defineEntries,
  type ShippedContent,
  type ShippedDocument,
  type ShippedDocumentRef,
} from './core/registry/content.js'
export {
  defineBlock,
  defineCollection,
  defineGlobal,
  defineSingleton,
  defineSite,
  defineTemplate,
  type AdminSettings,
  type BlockDef,
  type CollectionDef,
  type GlobalDef,
  type SingletonDef,
  type SingletonPath,
  type SiteDefinition,
  type OgType,
  type RedirectDef,
  type SeoSettings,
  type SiteInput,
  type SlotDef,
  type TemplateDef,
  type TemplateRenderProps,
  type TypeDef,
} from './core/registry/define.js'
export {
  defineRoute,
  type QueryApi,
  type RouteContext,
  type RouteDef,
  type RouteMethod,
  type RouteRequest,
  type RouteResponse,
} from './core/registry/route.js'
export {
  defineMigration,
  type MigrationContext,
  type MigrationDocument,
  type ReleaseMigration,
} from './core/registry/migration.js'
export type {
  Entry,
  HeadApi,
  HeadLink,
  HeadMeta,
  PageInfo,
  QueryOptions,
  QueryResult,
  RenderContext,
  ResolvedFile,
  ResolvedImage,
  ResolvedLink,
} from './core/registry/render.js'
export type {
  AdminTheme,
  ContentInput,
  CustomTheme,
  DocumentData,
  FileValue,
  ImageValue,
  LinkValue,
  MediaInfo,
  ShippedFile,
  ThemeColor,
} from './core/types.js'

/** The text of a rich-text or inline-text value without its formatting; `''` for `null` or `undefined`. */
export function plainText(doc: RichTextDoc | null | undefined): string {
  return doc ? richTextText(doc) : ''
}
export type { RichTextDoc }
export type { RichTextFeature, RichTextOptions } from './core/richtext/schema.js'
