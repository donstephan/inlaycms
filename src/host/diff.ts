import { t } from '../core/messages/index.js'
import { canonicalJson, type ManifestCsp, type ManifestIntegration, type ManifestRedirect, type ReleaseManifest } from '../core/release/manifest.js'
import type { ReleaseDiff } from './push.js'

type Route = { method: string; path: string; sitemap?: true }
type FieldChange = 'added' | 'removed' | 'type' | 'required' | 'optional'
type Slot = { type: string; slot: string }

/** What a staged release changes, read from the manifests alone. */
export interface StructuralDiff {
  /** `changed`: types both releases have whose kind (singleton, collection, global) differs. */
  types: { added: string[]; removed: string[]; changed: Array<{ type: string; from: string; to: string }> }
  /**
   * Slots added to or removed from a type both releases have, and slots both have that can now be switched off
   * (`optional`) or are now always on (`required`).
   */
  slots: { added: Slot[]; removed: Slot[]; optional: Slot[]; required: Slot[] }
  locales: { added: string[]; removed: string[] }
  /**
   * Fields of types (and slots) both releases have, by path: `fields.seo.title`, `slots.hero.headline`, with `[]`
   * for a list's items (`fields.links[].url`).
   */
  fields: Array<{ type: string; path: string; change: FieldChange }>
  /**
   * `sitemap.added`: the staged release's sitemap routes that the current release doesn't list, new routes included.
   * `sitemap.removed`: routes both releases have that the current release lists and the staged one doesn't.
   */
  routes: { added: Route[]; removed: Route[]; sitemap: { added: Route[]; removed: Route[] } }
  /** Code redirects by `from`; `changed` holds those whose target or status differs. Absent from a host before 0.3. */
  redirects?: { added: ManifestRedirect[]; removed: ManifestRedirect[]; changed: Array<{ before: ManifestRedirect; after: ManifestRedirect }> }
  /** Integrations by name; `changed` when the label, consent category or sources differ. Absent from an older host. */
  integrations?: { added: string[]; removed: string[]; changed: string[] }
  /** What the site may newly load and no longer may, as `<directive> <source>`, over the site's sources and every integration's. */
  csp?: { added: string[]; removed: string[] }
  /** Every secret the staged release needs. */
  secrets: string[]
  /** Every migration function of the staged release, in order. */
  migrations: string[]
  shipped: {
    /** Shipped documents and locales whose content changed while their edition stayed the same, so it won't be applied. */
    stale: Array<{ type: string; key: string; locale: string; edition: number }>
  }
}

type Json = Record<string, unknown>

const isJson = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The properties and required names of an object schema, or null when it has no properties. */
function objectOf(schema: unknown): { props: Record<string, Json>; required: ReadonlySet<string> } | null {
  if (!isJson(schema) || !isJson(schema.properties)) return null
  const props: Record<string, Json> = {}
  for (const [key, value] of Object.entries(schema.properties)) if (isJson(value)) props[key] = value
  const required = Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === 'string') : []
  return { props, required: new Set(required) }
}

/**
 * Keywords that don't decide what can be stored: annotations and limits, and `x-setting` (only where the admin shows a
 * field). Every other keyword counts, Inlay's own field kinds (such as `richText`) among them.
 */
const IGNORED = new Set([
  'title',
  'description',
  'default',
  'examples',
  '$schema',
  '$id',
  '$comment',
  'deprecated',
  'readOnly',
  'writeOnly',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'contentMediaType',
  'contentEncoding',
  'x-setting',
])

/** Keywords whose value is a schema, or a list of them, compared by shape in turn. */
const SCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems'])
const SCHEMAS = new Set([
  'items',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
])
/** Keywords whose value maps names to schemas. */
const SCHEMA_MAPS = new Set(['patternProperties', 'dependentSchemas', '$defs', 'definitions'])

/** The parts of a property schema that decide what can be stored in it: no titles, help, defaults or limits. */
function shape(schema: unknown): unknown {
  if (!isJson(schema)) return schema
  const out: Json = {}
  for (const [key, value] of Object.entries(schema)) {
    if (IGNORED.has(key) || key === 'properties' || key === 'required') continue
    if (key === 'enum' && Array.isArray(value)) out.enum = [...value].sort()
    else if (SCHEMA_LISTS.has(key) && Array.isArray(value)) out[key] = value.map(shape)
    else if (SCHEMAS.has(key)) out[key] = shape(value)
    else if (SCHEMA_MAPS.has(key) && isJson(value)) out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]))
    else out[key] = value
  }
  const object = objectOf(schema)
  if (object) {
    out.properties = Object.fromEntries(Object.entries(object.props).map(([k, v]) => [k, shape(v)]))
    out.required = [...object.required].sort()
  }
  return out
}

/** How the walk goes into a property: through an object's properties, through a list's item object, or not at all. */
function descent(schema: Json, inList: boolean): 'object' | 'list' | null {
  if (objectOf(schema)) return 'object'
  if (!inList && schema.type === 'array' && objectOf(schema.items)) return 'list'
  return null
}

/** Standard JSON Schema keywords about structure; any keyword in neither this nor `IGNORED` is one of Inlay's own. */
const STRUCTURAL = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'patternProperties',
  'propertyNames',
  'unevaluatedProperties',
  'items',
  'prefixItems',
  'unevaluatedItems',
  'contains',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'enum',
  'const',
  'format',
  '$ref',
  'dependentRequired',
  'dependentSchemas',
  '$defs',
  'definitions',
])

/** Inlay's own keywords on a schema, such as `richText`: they name the kind of field. */
function kindOf(schema: unknown): Json {
  if (!isJson(schema)) return {}
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !IGNORED.has(key) && !STRUCTURAL.has(key)))
}

/** What a property is compared by: the walk reports the inside of objects and list items field by field. */
function compared(schema: Json, how: 'object' | 'list' | null): string {
  if (how === 'object') return canonicalJson({ type: 'object', ...kindOf(schema) })
  if (how === 'list') return canonicalJson({ type: 'array', ...kindOf(schema), items: { type: 'object', ...kindOf(schema.items) } })
  return canonicalJson(shape(schema))
}

function walkFields(
  type: string,
  prefix: string,
  current: unknown,
  staged: unknown,
  inList: boolean,
  out: StructuralDiff['fields'],
): void {
  const a = objectOf(current) ?? { props: {}, required: new Set<string>() }
  const b = objectOf(staged) ?? { props: {}, required: new Set<string>() }
  for (const [name, next] of Object.entries(b.props)) {
    const path = `${prefix}.${name}`
    const prev = Object.hasOwn(a.props, name) ? a.props[name] : undefined
    if (prev === undefined) {
      out.push({ type, path, change: 'added' })
      continue
    }
    const howPrev = descent(prev, inList)
    const howNext = descent(next, inList)
    if (compared(prev, howPrev) !== compared(next, howNext)) {
      out.push({ type, path, change: 'type' })
      continue
    }
    if (a.required.has(name) !== b.required.has(name)) {
      out.push({ type, path, change: b.required.has(name) ? 'required' : 'optional' })
    }
    if (howNext === 'object') walkFields(type, path, prev, next, inList, out)
    if (howNext === 'list') walkFields(type, `${path}[]`, prev.items, next.items, true, out)
  }
  for (const name of Object.keys(a.props)) {
    if (!Object.hasOwn(b.props, name)) out.push({ type, path: `${prefix}.${name}`, change: 'removed' })
  }
}

/** The `fields` object schema of a stored-type schema. */
function fieldsOf(schema: unknown): unknown {
  return objectOf(schema)?.props.fields
}

/** The schema of a slot of a stored-type schema. */
const slotOf = (schema: unknown, slot: string): Json | undefined => objectOf(objectOf(schema)?.props.slots)?.props[slot]

/** Whether a slot can be switched off: its schema is a choice of variants rather than the data directly. */
function isOptionalSlot(schema: unknown, slot: string): boolean {
  const slotSchema = slotOf(schema, slot)
  return slotSchema !== undefined && objectOf(slotSchema)?.props.data === undefined && (Array.isArray(slotSchema.oneOf) || Array.isArray(slotSchema.anyOf))
}

/** The `data` object schema of a slot: directly on an always-on slot, on the switched-on variant of an optional one. */
function slotDataOf(schema: unknown, slot: string): unknown {
  const slotSchema = slotOf(schema, slot)
  if (!slotSchema) return undefined
  const direct = objectOf(slotSchema)?.props.data
  if (direct) return direct
  const variants = Array.isArray(slotSchema.oneOf) ? slotSchema.oneOf : Array.isArray(slotSchema.anyOf) ? slotSchema.anyOf : []
  const on = variants.find((v) => objectOf(v)?.props.enabled?.const === true) ?? variants.find((v) => objectOf(v)?.props.data)
  return objectOf(on)?.props.data
}

function added<T>(from: readonly T[], to: readonly T[], key: (t: T) => string = String): T[] {
  const known = new Set(from.map(key))
  return to.filter((t) => !known.has(key(t)))
}

const routeKey = (r: Route) => `${r.method} ${r.path}`

/**
 * What changes in structure when `staged` replaces `current` (null for the first release), from their manifests
 * alone. Fields are compared by presence, required-ness and the shape of their schema; a renamed field is one
 * removed and one added. Types and slots that are added or removed are reported as such, not field by field.
 */
export function structuralDiff(current: ReleaseManifest | null, staged: ReleaseManifest): StructuralDiff {
  const curTypes = current?.types ?? {}
  const curNames = Object.keys(curTypes)
  const stagedNames = Object.keys(staged.types)

  const slots: StructuralDiff['slots'] = { added: [], removed: [], optional: [], required: [] }
  const changed: StructuralDiff['types']['changed'] = []
  const fields: StructuralDiff['fields'] = []
  for (const type of stagedNames) {
    const prev = Object.hasOwn(curTypes, type) ? curTypes[type] : undefined
    const next = staged.types[type]
    if (!prev || !next || !current) continue
    if (prev.kind !== next.kind) changed.push({ type, from: prev.kind, to: next.kind })
    for (const slot of added(prev.slots, next.slots)) slots.added.push({ type, slot })
    for (const slot of added(next.slots, prev.slots)) slots.removed.push({ type, slot })
    const before = current.schema[type]
    const after = staged.schema[type]
    walkFields(type, 'fields', fieldsOf(before), fieldsOf(after), false, fields)
    for (const slot of next.slots) {
      if (!prev.slots.includes(slot)) continue
      const was = isOptionalSlot(before, slot)
      const is = isOptionalSlot(after, slot)
      if (was !== is) (is ? slots.optional : slots.required).push({ type, slot })
      walkFields(type, `slots.${slot}`, slotDataOf(before, slot), slotDataOf(after, slot), false, fields)
    }
  }

  const shippedKey = (s: { type: string; key: string }) => `${s.type}\u0000${s.key}`
  const curShipped = new Map((current?.shipped ?? []).map((s) => [shippedKey(s), s]))
  const stale: StructuralDiff['shipped']['stale'] = []
  for (const doc of staged.shipped) {
    const prev = curShipped.get(shippedKey(doc))
    if (!prev || prev.edition !== doc.edition) continue
    const locales = [...Object.keys(doc.locales), ...added(Object.keys(doc.locales), Object.keys(prev.locales))]
    for (const locale of locales) {
      if (doc.locales[locale] !== prev.locales[locale]) {
        stale.push({ type: doc.type, key: doc.key, locale, edition: doc.edition })
      }
    }
  }

  const curRedirects = new Map((current?.redirects ?? []).map((r) => [r.from, r]))
  const stagedRedirects = new Map((staged.redirects ?? []).map((r) => [r.from, r]))
  const redirects: NonNullable<StructuralDiff['redirects']> = { added: [], removed: [], changed: [] }
  for (const [from, after] of stagedRedirects) {
    const before = curRedirects.get(from)
    if (!before) redirects.added.push(after)
    else if (before.to !== after.to || before.status !== after.status) redirects.changed.push({ before, after })
  }
  for (const [from, before] of curRedirects) if (!stagedRedirects.has(from)) redirects.removed.push(before)

  const curIntegrations = new Map((current?.integrations ?? []).map((i) => [i.name, i]))
  const stagedIntegrations = new Map((staged.integrations ?? []).map((i) => [i.name, i]))
  const integrations: NonNullable<StructuralDiff['integrations']> = { added: [], removed: [], changed: [] }
  for (const [name, after] of stagedIntegrations) {
    const before = curIntegrations.get(name)
    if (!before) integrations.added.push(name)
    else if (canonicalJson(before) !== canonicalJson(after)) integrations.changed.push(name)
  }
  for (const name of curIntegrations.keys()) if (!stagedIntegrations.has(name)) integrations.removed.push(name)

  const curCsp = cspSources(current)
  const stagedCsp = cspSources(staged)

  const listed = new Set((current?.routes ?? []).filter((r) => r.sitemap === true).map(routeKey))
  return {
    types: { added: added(curNames, stagedNames), removed: added(stagedNames, curNames), changed },
    slots,
    locales: { added: added(current?.locales ?? [], staged.locales), removed: added(staged.locales, current?.locales ?? []) },
    fields,
    routes: {
      added: added(current?.routes ?? [], staged.routes, routeKey),
      removed: added(staged.routes, current?.routes ?? [], routeKey),
      sitemap: {
        added: staged.routes.filter((r) => r.sitemap === true && !listed.has(routeKey(r))),
        removed: staged.routes.filter((r) => r.sitemap !== true && listed.has(routeKey(r))),
      },
    },
    redirects,
    integrations,
    csp: { added: added(curCsp, stagedCsp), removed: added(stagedCsp, curCsp) },
    secrets: [...staged.secrets],
    migrations: [...staged.migrations],
    shipped: { stale },
  }
}

/** Every `<directive> <source>` a manifest lets the site load, its own and its integrations'. */
function cspSources(m: { integrations?: ManifestIntegration[]; csp?: ManifestCsp } | null): string[] {
  const out = new Set<string>()
  const add = (csp: ManifestCsp | undefined) => {
    for (const [directive, sources] of Object.entries(csp ?? {})) for (const source of sources) out.add(`${directive} ${source}`)
  }
  add(m?.csp)
  for (const i of m?.integrations ?? []) add(i.csp)
  return [...out]
}

/** How a line names a shipped document: a singleton by its type, an entry as `type/key`. */
const docName = (type: string, key: string) => (key === type ? type : `${type}/${key}`)

/** A field's path as a line shows it: `seo.title` for the type's own fields, `slots.hero.headline` for a slot's. */
const fieldName = (path: string) => path.replace(/^fields\./, '')

const FIELD_LINES = {
  added: 'diff.release.fieldAdded',
  removed: 'diff.release.fieldRemoved',
  type: 'diff.release.fieldType',
  required: 'diff.release.fieldRequired',
  optional: 'diff.release.fieldOptional',
} as const

/**
 * The release diff as plain-language lines, one per item: what is removed (and the content that will be hidden),
 * added and changed, the gaps and shipped documents the content half found, a warning per shipped document whose
 * content changed without a new edition, then migrations, routes and the secrets the release needs. A release that
 * changes nothing says so.
 */
export function formatDiff(diff: ReleaseDiff): string[] {
  const { structural: s, content } = diff
  const lines: string[] = []
  const hiddenTypes = new Map((content?.hidden.types ?? []).map((h) => [h.type, h.documents]))
  const hiddenLocales = new Map((content?.hidden.locales ?? []).map((h) => [h.locale, h.documents]))

  for (const type of s.types.removed) {
    const count = hiddenTypes.get(type) ?? 0
    lines.push(count > 0 ? t('diff.release.typeRemovedCount', { type, count }) : t('diff.release.typeRemoved', { type }))
  }
  for (const { type, slot } of s.slots.removed) lines.push(t('diff.release.slotRemoved', { type, slot }))
  for (const locale of s.locales.removed) {
    const count = hiddenLocales.get(locale) ?? 0
    lines.push(count > 0 ? t('diff.release.localeRemovedCount', { locale, count }) : t('diff.release.localeRemoved', { locale }))
  }
  for (const type of s.types.added) lines.push(t('diff.release.typeAdded', { type }))
  for (const change of s.types.changed ?? []) lines.push(t('diff.release.typeKind', change))
  for (const { type, slot } of s.slots.added) lines.push(t('diff.release.slotAdded', { type, slot }))
  for (const { type, slot } of s.slots.optional ?? []) lines.push(t('diff.release.slotOptional', { type, slot }))
  for (const { type, slot } of s.slots.required ?? []) lines.push(t('diff.release.slotRequired', { type, slot }))
  for (const locale of s.locales.added) lines.push(t('diff.release.localeAdded', { locale }))
  for (const { type, path, change } of s.fields) lines.push(t(FIELD_LINES[change], { type, field: fieldName(path) }))

  if (content !== null) {
    for (const gap of content.gaps) lines.push(t('diff.release.gaps', { label: gap.label, count: gap.documents }))
    const { shipped } = content
    for (const i of shipped.created) lines.push(t('diff.release.shippedCreated', { doc: docName(i.type, i.key), locale: i.locale }))
    for (const i of shipped.replaced) {
      lines.push(t('diff.release.shippedReplaced', { doc: docName(i.type, i.key), locale: i.locale, edition: i.edition }))
    }
    for (const i of shipped.skipped) lines.push(t('diff.release.shippedSkipped', { doc: docName(i.type, i.key), locale: i.locale }))
    for (const { item, target, field } of shipped.deletedRefs) {
      lines.push(
        t('diff.release.shippedDeletedRef', {
          doc: docName(item.type, item.key),
          locale: item.locale,
          field,
          target: docName(target.type, target.key),
        }),
      )
    }
    for (const w of shipped.warnings) lines.push(t('diff.release.warning', { message: w.message }))
  }

  // One line per document, however many of its locales changed.
  const stale = new Map<string, { doc: string; edition: number }>()
  for (const d of s.shipped.stale) stale.set(`${d.type}\u0000${d.key}`, { doc: docName(d.type, d.key), edition: d.edition })
  for (const d of stale.values()) lines.push(t('diff.release.stale', d))

  for (const name of s.migrations) lines.push(t('diff.release.migration', { name }))
  for (const r of s.routes.added) lines.push(t('diff.release.routeAdded', { method: r.method, path: r.path }))
  for (const r of s.routes.removed) lines.push(t('diff.release.routeRemoved', { method: r.method, path: r.path }))
  for (const r of s.routes.sitemap?.added ?? []) lines.push(t('diff.release.routeSitemapAdded', { path: r.path }))
  for (const r of s.routes.sitemap?.removed ?? []) lines.push(t('diff.release.routeSitemapRemoved', { path: r.path }))
  for (const r of s.redirects?.added ?? []) lines.push(t('diff.release.redirectAdded', { from: r.from, to: r.to, status: r.status }))
  for (const r of s.redirects?.removed ?? []) lines.push(t('diff.release.redirectRemoved', { from: r.from, to: r.to }))
  for (const { after } of s.redirects?.changed ?? []) {
    lines.push(t('diff.release.redirectChanged', { from: after.from, to: after.to, status: after.status }))
  }
  for (const name of s.integrations?.added ?? []) lines.push(t('diff.release.integrationAdded', { name }))
  for (const name of s.integrations?.removed ?? []) lines.push(t('diff.release.integrationRemoved', { name }))
  for (const name of s.integrations?.changed ?? []) lines.push(t('diff.release.integrationChanged', { name }))
  for (const source of s.csp?.added ?? []) lines.push(t('diff.release.cspAdded', { source }))
  for (const source of s.csp?.removed ?? []) lines.push(t('diff.release.cspRemoved', { source }))
  if (lines.length === 0) lines.push(t('diff.release.nothing'))
  if (s.secrets.length > 0) lines.push(t('diff.release.secrets', { count: s.secrets.length, names: s.secrets.join(', ') }))
  return lines
}
