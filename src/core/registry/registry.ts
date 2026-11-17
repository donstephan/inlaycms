import type { z } from 'zod'
import { resolveTheme } from '../theme.js'
import { InlayError } from '../errors.js'
import { isTitleTemplate } from '../fields/builtins.js'
import { fieldMeta } from '../fields/define.js'
import { defOf, unwrap } from '../fields/zod-internals.js'
import type { MessageId } from '../messages/index.js'
import { isReserved, normalizePath, routeRegExp, singletonPath, withLocale } from '../site/paths.js'
import { paramNames, ruleIndex, type RuleIndex } from '../redirects/collapse.js'
import { cleanPath, defaultLocalePrefix, externalTarget, redirectFrom } from '../redirects/rule.js'
import type { MatchRule } from '../types.js'
import { KEY_PATTERN, type ShippedDocument } from './content.js'
import type { BlockDef, SiteDefinition, TemplateDef, TypeDef } from './define.js'

/** A redirect rule from the site's code: `from` in its stored form, `to` a decoded path or an `href`. */
export interface CodeRule {
  from: string
  to: string
  status: 301 | 302
}

export interface Registry {
  site: SiteDefinition
  locales: readonly string[]
  defaultLocale: string
  types: ReadonlyMap<string, TypeDef>
  /** Every block used by any type, by name. */
  blocks: ReadonlyMap<string, BlockDef>
  /** Every template used by any type, by name. */
  templates: ReadonlyMap<string, TemplateDef>
  /** Shipped documents by type. */
  content: ReadonlyMap<string, readonly ShippedDocument[]>
  /** The site's code redirects, checked, in definition order. */
  redirects: readonly CodeRule[]
  /** The code redirects indexed for matching. */
  redirectIndex: RuleIndex<MatchRule>
  /** The global and top-level field holding `f.seoDefaults()`, if any. */
  seoDefaults: { global: string; field: string } | null
  /** The paths of the GET code routes. */
  getRoutePaths: ReadonlySet<string>
  /** Throws `InlayError('not_found')` for an unknown type. */
  getType(name: string): TypeDef
}

const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/
const NAME = /^[a-z][A-Za-z0-9_]*$/
const SECRET = /^[A-Z][A-Z0-9_]*$/
/** An HTTP header name (RFC 9110's token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
/** Headers Inlay sets on its own responses, which a site's `headers` can't replace. */
const OWN_HEADERS = new Set([
  'cache-control',
  'connection',
  'content-length',
  'content-type',
  'etag',
  'location',
  'set-cookie',
  'transfer-encoding',
  'vary',
])

function fail(messageId: MessageId, params: Record<string, string | number>): never {
  throw new InlayError('definition', messageId, params)
}

/** Checks every field of `shape` at any depth; `where` is the developer-facing dotted path prefix. */
function checkShape(
  shape: Record<string, z.core.$ZodType>,
  where: string,
  collections: ReadonlySet<string>,
  nested: boolean,
): void {
  for (const [key, schema] of Object.entries(shape)) {
    const field = `${where}.${key}`
    if (!NAME.test(key)) fail('definition.fieldName', { field })
    const meta = fieldMeta(schema as z.ZodType)
    if (!meta) fail('definition.fieldWithoutMeta', { field })
    if (meta.kind === 'ref' && (meta.target === undefined || !collections.has(meta.target))) {
      fail('definition.refUnknown', { field, target: meta.target ?? '' })
    }
    if (meta.seoDefaults && nested) fail('definition.seoDefaultsPlace', { field })
    const def = defOf(unwrap(schema))
    if (meta.kind === 'group' && def.shape) checkShape(def.shape, field, collections, true)
    if (meta.kind === 'list' && def.element) {
      if (fieldMeta(def.element as z.ZodType)?.seoDefaults) fail('definition.seoDefaultsPlace', { field })
      const item = defOf(unwrap(def.element))
      if (item.shape) checkShape(item.shape, field, collections, true)
    }
  }
}

function checkTemplate(
  template: TemplateDef,
  collections: ReadonlySet<string>,
  checked: Set<TemplateDef>,
): void {
  if (checked.has(template)) return
  checked.add(template)
  if (template.ogType !== undefined && template.ogType !== 'website' && template.ogType !== 'article') {
    fail('definition.ogType', { name: template.name, value: String(template.ogType) })
  }
  checkShape(template.fields.shape, template.name, collections, false)
  for (const [key, slot] of Object.entries(template.slots)) {
    if (!NAME.test(key)) fail('definition.slotName', { name: key, template: template.name })
    checkShape(slot.block.schema.shape, slot.block.name, collections, true)
  }
}

function checkPath(name: string, path: string, locales: readonly string[]): void {
  const first = path.split('/')[1] ?? ''
  if (normalizePath(path) !== path || /[?#]/.test(path) || isReserved(path) || locales.includes(first)) {
    fail('definition.path', { name, path })
  }
}

function checkType(type: TypeDef, site: SiteDefinition): void {
  switch (type.kind) {
    case 'singleton':
      if (type.path !== null && typeof type.path === 'object' && !Object.hasOwn(type.path, site.defaultLocale)) {
        fail('definition.pathDefaultLocale', { name: type.name, locale: site.defaultLocale })
      }
      if (type.path !== null) {
        for (const p of typeof type.path === 'string' ? [type.path] : Object.values(type.path)) {
          checkPath(type.name, p, site.locales)
        }
      }
      break
    case 'collection': {
      const route = type.route
      if (route !== null && (!route.startsWith('/') || route.split(':slug').length !== 2 || /[?#]/.test(route))) {
        fail('definition.route', { name: type.name, route })
      }
      if (route !== null) {
        const prefix = route.split(':slug')[0]!.replace(/\/$/, '')
        if (prefix !== '') checkPath(type.name, prefix, site.locales)
      }
      const shape = type.template.fields.shape
      const title = Object.hasOwn(shape, type.titleField) ? shape[type.titleField] : undefined
      if (!title || fieldMeta(title as z.ZodType)?.kind !== 'text') {
        fail('definition.titleField', { name: type.name, field: type.titleField })
      }
      break
    }
  }
}

function checkSettings(site: SiteDefinition, types: ReadonlyMap<string, TypeDef>): void {
  resolveTheme(site.admin.theme)
  const { titleTemplate, description, image } = site.seo
  if (titleTemplate !== undefined && (typeof titleTemplate !== 'string' || !isTitleTemplate(titleTemplate))) {
    fail('definition.seoTitleTemplate', { value: String(titleTemplate) })
  }
  if (image !== undefined && (typeof image !== 'string' || !image.startsWith('/public/') || image.length === '/public/'.length)) {
    fail('definition.seoImage', { value: String(image) })
  }
  if (description !== undefined && typeof description !== 'string') fail('definition.seoDescription', {})
  if (site.notFound !== null) {
    const def = types.get(site.notFound)
    if (!def || def.kind !== 'singleton' || def.path !== null || !def.template.render) {
      fail('definition.notFound', { name: String(site.notFound) })
    }
  }
  for (const path of site.publicPaths) {
    if (typeof path !== 'string' || !path.startsWith('/')) fail('definition.publicPath', { path: String(path) })
  }
  const secrets = new Set<string>()
  for (const name of site.secrets) {
    if (typeof name !== 'string' || !SECRET.test(name) || secrets.has(name)) fail('definition.secretName', { name: String(name) })
    secrets.add(name)
  }
  const headers = new Set<string>()
  for (const [name, value] of Object.entries(site.headers)) {
    const lower = name.toLowerCase()
    if (!HEADER_NAME.test(name) || OWN_HEADERS.has(lower) || headers.has(lower)) fail('definition.headerName', { name })
    if (value !== false && (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value))) {
      fail('definition.headerValue', { name })
    }
    headers.add(lower)
  }
  const migrations = new Set<string>()
  for (const { name } of site.migrations) {
    if (typeof name !== 'string' || name.trim() === '' || migrations.has(name)) fail('definition.migrationName', { name: String(name) })
    migrations.add(name)
  }
}

/** Paths a route can't take: Inlay's reserved paths and the home page. */
const isRouteReserved = (path: string) => path === '/' || isReserved(path)

/** The type whose pages `path` would hide, in any locale, with or without its locale prefix. */
function shadowedType(registry: Registry, path: string): string | null {
  const { site } = registry
  for (const locale of site.locales) {
    for (const def of site.singletons) {
      const p = singletonPath(def, locale, site.defaultLocale)
      if (p !== null && (p === path || withLocale(registry, locale, p) === path)) return def.name
    }
    for (const def of site.collections) {
      if (def.route === null) continue
      if (routeRegExp(def.route).test(path) || routeRegExp(withLocale(registry, locale, def.route)).test(path)) return def.name
    }
  }
  return null
}

function checkRoutes(registry: Registry): void {
  const seen = new Set<string>()
  for (const { method, path, sitemap } of registry.site.routes) {
    if (method !== 'GET' && method !== 'POST') fail('definition.routeMethod', { method: String(method), path: String(path) })
    if (typeof path !== 'string' || normalizePath(path) !== path || /[:*?#%]/.test(path)) {
      fail('definition.routePath', { path: String(path) })
    }
    if (sitemap !== undefined && (sitemap !== true || method !== 'GET')) fail('definition.routeSitemap', { method, path })
    if (isRouteReserved(path)) fail('definition.routeReserved', { path })
    const name = shadowedType(registry, path)
    if (name !== null) fail('definition.routeShadows', { path, name })
    const key = `${method} ${path}`
    if (seen.has(key)) fail('definition.routeDuplicate', { method, path })
    seen.add(key)
  }
}

function checkRedirects(site: SiteDefinition, getPaths: ReadonlySet<string>): CodeRule[] {
  const rules: CodeRule[] = []
  const seen = new Set<string>()
  for (const def of site.redirects) {
    const shown = typeof def?.from === 'string' ? def.from : String(def?.from)
    const from = typeof def?.from === 'string' ? redirectFrom({ defaultLocale: site.defaultLocale }, def.from) : null
    if (from === null) fail('definition.redirectFrom', { from: shown })
    const status = def.status ?? 301
    if (status !== 301 && status !== 302) fail('definition.redirectStatus', { from, status: String(status) })
    const bad = () => fail('definition.redirectTo', { from, to: String(def.to) })
    if (typeof def.to !== 'string') bad()
    const names = paramNames(from)
    let to: string
    if (def.to.startsWith('/')) {
      const path = cleanPath(def.to)
      if (path === null || defaultLocalePrefix(site, path) !== null) bad()
      to = path!
      for (const name of paramNames(to)) if (!names.includes(name)) fail('definition.redirectParam', { from, name })
    } else {
      const href = externalTarget(def.to)
      if (href === null) bad()
      to = href!
      const [name] = names.length > 0 ? paramNames(new URL(to).pathname) : []
      if (name !== undefined) fail('definition.redirectUrlParam', { from, name })
    }
    if (seen.has(from)) fail('definition.redirectDuplicate', { from })
    seen.add(from)
    if (getPaths.has(from)) fail('definition.redirectRoute', { from })
    rules.push({ from, to, status })
  }
  return rules
}

/** Checks a site definition and indexes its types. Throws `InlayError('definition')` naming the offender. */
export function buildRegistry(site: SiteDefinition): Registry {
  const seenLocales = new Set<string>()
  for (const locale of site.locales) {
    if (!LOCALE.test(locale)) fail('definition.localeInvalid', { locale })
    if (seenLocales.has(locale)) fail('definition.localeDuplicate', { locale })
    seenLocales.add(locale)
  }
  if (!seenLocales.has(site.defaultLocale)) {
    fail('definition.defaultLocale', {
      locale: site.defaultLocale,
      locales: site.locales.join(', '),
    })
  }

  const all: TypeDef[] = [...site.singletons, ...site.collections, ...site.globals]
  const types = new Map<string, TypeDef>()
  for (const type of all) {
    if (!NAME.test(type.name)) fail('definition.typeName', { name: type.name })
    if (types.has(type.name)) fail('definition.typeDuplicate', { name: type.name })
    types.set(type.name, type)
  }

  const collections = new Set(site.collections.map((c) => c.name))
  const checked = new Set<TemplateDef>()
  const blocks = new Map<string, BlockDef>()
  const templates = new Map<string, TemplateDef>()
  for (const type of all) {
    const known = templates.get(type.template.name)
    if (known && known !== type.template) fail('definition.templateDuplicate', { name: type.template.name })
    templates.set(type.template.name, type.template)
    for (const { block } of Object.values(type.template.slots)) {
      const seen = blocks.get(block.name)
      if (seen && seen !== block) fail('definition.blockDuplicate', { name: block.name })
      blocks.set(block.name, block)
    }
    checkTemplate(type.template, collections, checked)
    checkType(type, site)
  }

  for (const locale of site.locales) {
    const seen = new Set<string>()
    for (const type of site.singletons) {
      const path = singletonPath(type, locale, site.defaultLocale)
      if (path === null) continue
      if (seen.has(path)) fail('definition.pathDuplicate', { path, locale })
      seen.add(path)
    }
  }

  checkSettings(site, types)

  let seoDefaults: Registry['seoDefaults'] = null
  for (const type of all) {
    for (const [key, schema] of Object.entries(type.template.fields.shape)) {
      if (!fieldMeta(schema as z.ZodType)?.seoDefaults) continue
      const here = `${type.name}.${key}`
      if (type.kind !== 'global') fail('definition.seoDefaultsPlace', { field: `${type.template.name}.${key}` })
      if (seoDefaults) fail('definition.seoDefaultsTwice', { first: `${seoDefaults.global}.${seoDefaults.field}`, second: here })
      seoDefaults = { global: type.name, field: key }
    }
  }

  const content = new Map<string, readonly ShippedDocument[]>()
  for (const shipped of site.content) {
    const type = types.get(shipped.type)
    if (!type) fail('definition.contentType', { type: shipped.type })
    if (type.kind === 'collection' && shipped.via !== 'entries') {
      fail('definition.contentUseEntries', { type: shipped.type })
    }
    if (type.kind !== 'collection' && shipped.via !== 'content') {
      fail('definition.contentUseContent', { type: shipped.type })
    }
    if (content.has(shipped.type)) fail('definition.contentDuplicate', { type: shipped.type })
    const keys = new Set<string>()
    for (const doc of shipped.documents) {
      const ref = { type: shipped.type, key: doc.key }
      if (shipped.via === 'entries' && (!KEY_PATTERN.test(doc.key) || doc.key.length > 100)) {
        fail('definition.contentKey', ref)
      }
      if (keys.has(doc.key)) fail('definition.contentKeyDuplicate', ref)
      keys.add(doc.key)
      if (!Number.isInteger(doc.edition) || doc.edition < 1) {
        fail('definition.contentEdition', { ...ref, edition: doc.edition })
      }
      const locales = Object.keys(doc.content)
      if (locales.length === 0) fail('definition.contentNoLocales', ref)
      for (const locale of locales) {
        if (!seenLocales.has(locale)) {
          fail('definition.contentLocale', { ...ref, locale, locales: site.locales.join(', ') })
        }
      }
    }
    content.set(shipped.type, shipped.documents)
  }

  const getRoutePaths = new Set(site.routes.filter((r) => r.method === 'GET').map((r) => r.path))
  const redirects = checkRedirects(site, getRoutePaths)
  const registry: Registry = {
    site,
    locales: [...site.locales],
    defaultLocale: site.defaultLocale,
    types,
    blocks,
    templates,
    content,
    redirects,
    seoDefaults,
    redirectIndex: ruleIndex(redirects.map((r): MatchRule => ({ from: r.from, to_path: r.to, to_group_id: null, status: r.status }))),
    getRoutePaths,
    getType(name) {
      const type = types.get(name)
      if (!type) throw new InlayError('not_found', 'error.typeNotFound', { name })
      return type
    },
  }
  checkRoutes(registry)
  return registry
}
