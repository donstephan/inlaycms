import type { z } from 'zod'
import { parsePath } from '../../../core/agent/format.js'
import { fieldMeta, type AdminWidget, type AgentRefs, type FieldMeta, type FormValues } from '../../../core/fields/define.js'
import { jsonWidget, textWidget } from '../../../core/fields/widgets.js'
import { defOf, isRecord, unwrap, type Schema } from '../../../core/fields/zod-internals.js'
import { t } from '../../../core/messages/index.js'
import type { SlotDef, TypeDef } from '../../../core/registry/define.js'
import type { Registry } from '../../../core/registry/registry.js'
import type { ContentIssue, DocumentData, PathSegment } from '../../../core/types.js'
import type { Html, Renderable } from '../../../jsx/html.js'
import { Icon } from '../views/icons.js'
import { Badge } from '../views/status.js'

/** What the document form is rendered for. */
export interface FormContext {
  registry: Registry
  type: string
  locale: string
  refs: AgentRefs
  /** The form's action, for the list buttons' `hx-post`. Without it they only submit the form. */
  action?: string
  readOnly?: boolean
  /** Save problems by form name. */
  problems?: Map<string, string[]>
  /** "Needed before publishing" hints by form name. */
  hints?: Map<string, string[]>
  /** Form names of list items to render open (besides any with problems or hints). */
  open?: Set<string>
  /** Card keys to render closed: 'fields' or a slot key. */
  closed?: Set<string>
}

/** The form name of a document path: its segments joined with dots. */
export const formName = (path: PathSegment[]): string => path.map(String).join('.')

/** The id of the control for a form name. Field names can't contain `-`, so ids are unique. */
export const formId = (name: string): string => `f-${name.replaceAll('.', '-')}`

type Shape = Record<string, Schema>

type Node =
  | { kind: 'group'; meta: FieldMeta; shape: Shape }
  | { kind: 'list'; meta: FieldMeta; element: Schema }
  | { kind: 'leaf'; meta: FieldMeta; widget: AdminWidget }

const metaOf = (s: Schema): FieldMeta | undefined => fieldMeta(s as z.ZodType)
const shapeOf = (s: Schema): Shape | undefined => defOf(unwrap(s)).shape
const isOptional = (s: Schema): boolean => s._zod.optin === 'optional'

function nodeOf(s: Schema, key: string): Node {
  const meta = metaOf(s) ?? { kind: 'unknown', label: key }
  if (meta.kind === 'group') {
    const shape = shapeOf(s)
    if (shape) return { kind: 'group', meta, shape }
  }
  if (meta.kind === 'list') {
    const element = defOf(unwrap(s)).element
    if (element) return { kind: 'list', meta, element }
  }
  return { kind: 'leaf', meta, widget: meta.admin ?? jsonWidget }
}

/** The fields of a list item that is an object; `undefined` for an item that is one value. */
function itemShape(element: Schema): Shape | undefined {
  const meta = metaOf(element)
  return meta && meta.kind !== 'group' ? undefined : shapeOf(element)
}

/** The leaf that renders a list item that is one value. */
const itemLeaf = (element: Schema, label: string): Node & { kind: 'leaf' } => {
  const meta: FieldMeta = { ...(metaOf(element) ?? { kind: 'unknown' }), label }
  return { kind: 'leaf', meta, widget: meta.admin ?? jsonWidget }
}

/**
 * The name of the hidden input that marks a stored group or list, so one left absent stays absent while one the
 * user emptied is still saved.
 */
const presentName = (name: string): string => `${name}._present`

function Present({ ctx, name, value }: { ctx: FormContext; name: string; value: unknown }) {
  if (value === undefined) return null
  return <input type="hidden" name={presentName(name)} value="" disabled={ctx.readOnly === true} />
}

const isCollection = (def: TypeDef): def is TypeDef & { kind: 'collection' } => def.kind === 'collection'

const slugMeta = (): FieldMeta => ({ kind: 'text', label: t('label.slug'), help: t('admin.form.slugHint') })
const pathMeta = (): FieldMeta => ({ kind: 'text', label: t('label.path') })

// ---------------------------------------------------------------------------
// Rendering

function notesFor(ctx: FormContext, name: string, id: string, help: string | undefined) {
  const problems = ctx.problems?.get(name) ?? []
  const hints = ctx.hints?.get(name) ?? []
  const ids: string[] = []
  if (help !== undefined) ids.push(`${id}-help`)
  if (problems.length > 0) ids.push(`${id}-problem`)
  if (hints.length > 0) ids.push(`${id}-hint`)
  const notes = (
    <>
      {help !== undefined && (
        <p id={`${id}-help`} class="text-sm text-base-content/70">
          {help}
        </p>
      )}
      {problems.length > 0 && (
        <ul id={`${id}-problem`} class="text-sm text-error">
          {problems.map((p) => (
            <li>{p}</li>
          ))}
        </ul>
      )}
      {hints.length > 0 && (
        <ul id={`${id}-hint`} class="w-fit rounded-box bg-warning px-3 py-1 text-sm text-warning-content">
          {hints.map((h) => (
            <li>{h}</li>
          ))}
        </ul>
      )}
    </>
  )
  return { notes, describedBy: ids.length > 0 ? ids.join(' ') : undefined, invalid: problems.length > 0 }
}

/** Whether any problem or hint sits on one of `names` or inside it, so a collapsed area holding it opens. */
function hasNotes(ctx: FormContext, names: string[]): boolean {
  const keys = [...(ctx.problems?.keys() ?? []), ...(ctx.hints?.keys() ?? [])]
  return keys.some((key) => names.some((name) => key === name || key.startsWith(`${name}.`)))
}

/** How many hints sit on one of `names` or inside it. */
function neededCount(ctx: FormContext, names: string[]): number {
  return [...(ctx.hints?.keys() ?? [])].filter((key) => names.some((name) => key === name || key.startsWith(`${name}.`))).length
}

function OptionalMark({ optional }: { optional: boolean }) {
  if (!optional) return null
  return <span class="ms-2 text-sm font-normal text-base-content/60">{t('admin.form.optional')}</span>
}

const SUMMARY = 'flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden'

/** The chevron of a `<details>` summary, turned down while it is open. */
const Chevron = () => <Icon name="chevron-right" class="opacity-60 transition-transform [[open]>summary>&]:rotate-90" />

/** A string value on one line, or `''` for anything else. */
const oneLine = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

/** The non-empty values of the top-level text and textarea fields of `value`, in schema order. */
function textsOf(shape: Shape, value: unknown): Array<{ key: string; kind: string; text: string }> {
  const record = isRecord(value) ? value : {}
  const out: Array<{ key: string; kind: string; text: string }> = []
  for (const [key, schema] of Object.entries(shape)) {
    const kind = metaOf(schema)?.kind
    if (kind !== 'text' && kind !== 'textarea') continue
    const text = oneLine(Object.hasOwn(record, key) ? record[key] : undefined)
    if (text !== '') out.push({ key, kind, text })
  }
  return out
}

function itemsText(n: number): string {
  if (n === 0) return t('admin.form.items.none')
  if (n === 1) return t('admin.form.items.one')
  return t('admin.form.items', { n })
}

/**
 * The key of a shape's only entry when that entry is a list or group outside the settings and SEO areas, which
 * then takes its name from the card.
 */
function soleContainer(shape: Shape): string | undefined {
  const entries = Object.entries(shape)
  if (entries.length !== 1) return undefined
  const [key, schema] = entries[0]!
  const node = nodeOf(schema, key)
  if (node.meta.seo === true || node.meta.setting === true) return undefined
  return node.kind === 'list' || node.kind === 'group' ? key : undefined
}

/** A card's one-line summary: its first text, or how many items its only list has. */
function cardSummary(shape: Shape, value: unknown): string {
  const sole = soleContainer(shape)
  if (sole !== undefined && nodeOf(shape[sole]!, sole).kind === 'list') {
    const record = isRecord(value) ? value : {}
    const items = Object.hasOwn(record, sole) ? record[sole] : undefined
    return itemsText(Array.isArray(items) ? items.length : 0)
  }
  const first = textsOf(shape, value)[0]
  return first ? clip(first.text, 60) : ''
}

/** The id of a card's heading. The `--` keeps it apart from field ids, whose names are never empty. */
const cardTitleId = (base: string): string => `${formId(base)}--title`

function Card({ ctx, cardKey, base, names, label, optional, summary, children }: {
  ctx: FormContext
  cardKey: string
  base: string
  /** The form names inside the card, for its notes. */
  names: string[]
  label: string
  optional: boolean
  summary: string
  children?: Renderable
}) {
  const needed = neededCount(ctx, names)
  const open = hasNotes(ctx, names) || ctx.closed?.has(cardKey) !== true
  return (
    <details data-card={cardKey} open={open} class="rounded-box border border-base-300 bg-base-100">
      <summary class={`${SUMMARY} px-4 py-3`}>
        <Chevron />
        <h2 id={cardTitleId(base)} class="font-semibold">
          {label}
        </h2>
        <OptionalMark optional={optional} />
        {summary !== '' && <span class="min-w-0 truncate text-sm text-base-content/60">{summary}</span>}
        {needed > 0 && (
          <Badge tone="warning" class="ms-auto shrink-0">
            {t('admin.form.neededCount', { n: needed })}
          </Badge>
        )}
      </summary>
      <div class="border-t border-base-300 px-4 py-4">{children}</div>
    </details>
  )
}

function Leaf({ ctx, node, name, value, optional }: {
  ctx: FormContext
  node: Node & { kind: 'leaf' }
  name: string
  value: unknown
  optional: boolean
}) {
  const { meta, widget } = node
  const id = formId(name)
  const { notes, describedBy, invalid } = notesFor(ctx, name, id, meta.help)
  const control = widget.render({
    name,
    id,
    value,
    meta,
    optional,
    readOnly: ctx.readOnly === true,
    describedBy,
    invalid,
    refs: ctx.refs,
    locale: ctx.locale,
  })
  const title = (
    <>
      {meta.label}
      {meta.kind === 'datetime' && ` ${t('admin.form.utc')}`}
      <OptionalMark optional={optional} />
    </>
  )
  if (widget.fieldset) {
    return (
      <fieldset class="fieldset mb-4" aria-describedby={describedBy}>
        <legend class="fieldset-legend">{title}</legend>
        {notes}
        {control}
      </fieldset>
    )
  }
  if (meta.kind === 'boolean') {
    return (
      <div class="mb-4 flex flex-col gap-1">
        <div class="flex items-center gap-2">
          {control}
          <label for={id} class="font-medium">
            {title}
          </label>
        </div>
        {notes}
      </div>
    )
  }
  return (
    <div class="mb-4 flex flex-col gap-1">
      <label for={id} class="font-medium">
        {title}
      </label>
      {notes}
      {control}
    </div>
  )
}

function OpButton({ ctx, op, label, title, class: cls = 'btn btn-sm', children }: {
  ctx: FormContext
  op: string
  label?: string
  title?: string
  class?: string
  children?: Renderable
}) {
  return (
    <button
      type="submit"
      name="_op"
      value={op}
      formnovalidate
      class={cls}
      aria-label={label}
      title={title}
      hx-post={ctx.action}
      hx-target="#editor-form"
      hx-select="#editor-form"
      hx-swap="outerHTML"
    >
      {children}
    </button>
  )
}

/**
 * Each item's title, from its first text (its own value for an item that is one value), else its list label and
 * number. A title another item shares gets its number too, so the item buttons' labels stay apart.
 */
function itemTitles(meta: FieldMeta, shape: Shape | undefined, items: unknown[]): Array<{ title: string; blank: boolean; snippet: string }> {
  const raw = items.map((item, i) => {
    const texts = shape ? textsOf(shape, item) : []
    const first = shape ? texts.find((x) => x.kind === 'text') : undefined
    const own = shape ? (first?.text ?? '') : oneLine(item)
    const second = texts.find((x) => x !== first)
    return {
      title: own === '' ? `${meta.itemLabel ?? meta.label} ${i + 1}` : clip(own, 60),
      blank: own === '',
      snippet: second ? clip(second.text, 80) : '',
    }
  })
  const suffixed = raw.map((r, i) => (raw.some((o, j) => j !== i && o.title === r.title) ? { ...r, title: `${r.title} (${i + 1})` } : r))
  // A suffixed title can still match another item's own title ("Same (2)"), so any title already taken gets the
  // item's number again until it is free.
  const taken = new Set<string>()
  return suffixed.map((r, i) => {
    let title = r.title
    while (taken.has(title)) title = `${title} (${i + 1})`
    taken.add(title)
    return title === r.title ? r : { ...r, title }
  })
}

const ITEM_BUTTON = 'btn btn-ghost btn-xs btn-square'

function List({ ctx, node, name, value, optional, labelledBy }: {
  ctx: FormContext
  node: Node & { kind: 'list' }
  name: string
  value: unknown
  optional: boolean
  labelledBy?: string
}) {
  const { meta, element } = node
  const id = formId(name)
  const items = Array.isArray(value) ? (value as unknown[]) : []
  const shape = itemShape(element)
  const { notes, describedBy } = notesFor(ctx, name, id, meta.help)
  const readOnly = ctx.readOnly === true
  const titles = itemTitles(meta, shape, items)
  return (
    <fieldset
      class={labelledBy === undefined ? 'fieldset mb-4 gap-2 rounded-box border border-base-300 p-4' : 'fieldset mb-4 gap-2'}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
    >
      {labelledBy === undefined && (
        <legend class="fieldset-legend">
          {meta.label}
          <OptionalMark optional={optional} />
        </legend>
      )}
      {notes}
      <Present ctx={ctx} name={name} value={value} />
      {items.map((item, i) => {
        const itemName = `${name}.${i}`
        const { title, blank, snippet } = titles[i]!
        const open = ctx.open?.has(itemName) === true || hasNotes(ctx, [itemName])
        return (
          <div class="grid grid-cols-[1fr_auto] items-start rounded-field border border-base-300 bg-base-100">
            <details data-item={itemName} open={open} class="min-w-0">
              <summary class={`${SUMMARY} min-w-0 py-2 ps-2 pe-1`}>
                <Chevron />
                <span class={blank ? 'shrink-0 font-medium text-base-content/50' : 'shrink-0 font-medium'}>{title}</span>
                {snippet !== '' && <span class="min-w-0 truncate text-sm text-base-content/50 [[open]>summary>&]:hidden">{snippet}</span>}
              </summary>
              <fieldset class="fieldset border-t border-base-300 px-3 pt-3">
                <legend class="sr-only">{title}</legend>
                {shape ? (
                  <>
                    <input type="hidden" name={`${itemName}._item`} value="" disabled={readOnly} />
                    <Fields ctx={ctx} shape={shape} value={item} prefix={itemName} />
                  </>
                ) : (
                  <Leaf ctx={ctx} node={itemLeaf(element, `${meta.itemLabel ?? meta.label} ${i + 1}`)} name={itemName} value={item} optional={false} />
                )}
              </fieldset>
            </details>
            {!readOnly && (
              <div class="flex items-center gap-0.5 py-1 pe-1">
                {i > 0 && (
                  <OpButton ctx={ctx} op={`up:${itemName}`} label={t('admin.form.upItem', { item: title })} title={t('admin.form.up')} class={ITEM_BUTTON}>
                    <Icon name="arrow-up" />
                  </OpButton>
                )}
                {i < items.length - 1 && (
                  <OpButton ctx={ctx} op={`down:${itemName}`} label={t('admin.form.downItem', { item: title })} title={t('admin.form.down')} class={ITEM_BUTTON}>
                    <Icon name="arrow-down" />
                  </OpButton>
                )}
                <OpButton
                  ctx={ctx}
                  op={`remove:${itemName}`}
                  label={t('admin.form.removeItem', { item: title })}
                  title={t('admin.form.remove')}
                  class={`${ITEM_BUTTON} hover:text-error`}
                >
                  <Icon name="trash" />
                </OpButton>
              </div>
            )}
          </div>
        )
      })}
      {!readOnly && (
        <OpButton ctx={ctx} op={`add:${name}`} class="btn btn-sm btn-ghost w-full border border-dashed border-base-300">
          <Icon name="plus" />
          {meta.itemLabel !== undefined
            ? t('admin.form.add', { item: meta.itemLabel })
            : t('admin.form.addItem', { list: meta.label })}
        </OpButton>
      )}
    </fieldset>
  )
}

function Group({ ctx, node, name, value, optional, labelledBy }: {
  ctx: FormContext
  node: Node & { kind: 'group' }
  name: string
  value: unknown
  optional: boolean
  labelledBy?: string
}) {
  const id = formId(name)
  const { notes, describedBy } = notesFor(ctx, name, id, node.meta.help)
  return (
    <fieldset
      class={labelledBy === undefined ? 'fieldset mb-4 rounded-box border border-base-300 p-4' : 'fieldset mb-4'}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
    >
      {labelledBy === undefined && (
        <legend class="fieldset-legend">
          {node.meta.label}
          <OptionalMark optional={optional} />
        </legend>
      )}
      {notes}
      <Present ctx={ctx} name={name} value={value} />
      <Fields ctx={ctx} shape={node.shape} value={value} prefix={name} />
    </fieldset>
  )
}

function Field({ ctx, schema, keyName, name, value, labelledBy }: {
  ctx: FormContext
  schema: Schema
  keyName: string
  name: string
  value: unknown
  labelledBy?: string
}) {
  const node = nodeOf(schema, keyName)
  const optional = isOptional(schema)
  const named = labelledBy !== undefined ? { labelledBy } : {}
  if (node.kind === 'group') return <Group ctx={ctx} node={node} name={name} value={value} optional={optional} {...named} />
  if (node.kind === 'list') return <List ctx={ctx} node={node} name={name} value={value} optional={optional} {...named} />
  return <Leaf ctx={ctx} node={node} name={name} value={value} optional={optional} />
}

/** A collapsed area inside a card: settings, SEO, or a hidden slot's fields. */
function Area({ open, title, children }: { open: boolean; title: Renderable; children?: Renderable }) {
  return (
    <details class="mb-4 rounded-box border border-base-300" open={open}>
      <summary class={`${SUMMARY} px-4 py-3 font-medium`}>
        <Chevron />
        {title}
      </summary>
      <div class="border-t border-base-300 px-4 py-4">{children}</div>
    </details>
  )
}

/**
 * The fields of an object, in schema order. With `split`, settings and SEO groups go in their own collapsed areas.
 * `labelledBy` names the card heading that the shape's only list or group takes its name from.
 */
function Fields({ ctx, shape, value, prefix, split = false, labelledBy }: {
  ctx: FormContext
  shape: Shape
  value: unknown
  prefix: string
  split?: boolean
  labelledBy?: string
}) {
  const record = isRecord(value) ? value : {}
  const entries = Object.entries(shape)
  const sole = labelledBy !== undefined ? soleContainer(shape) : undefined
  const field = ([key, schema]: [string, Schema]) => (
    <Field
      ctx={ctx}
      schema={schema}
      keyName={key}
      name={`${prefix}.${key}`}
      value={Object.hasOwn(record, key) ? record[key] : undefined}
      {...(sole === key && labelledBy !== undefined && { labelledBy })}
    />
  )
  if (!split) return <>{entries.map(field)}</>
  const seo = entries.filter(([, s]) => metaOf(s)?.seo === true)
  const settings = entries.filter(([, s]) => metaOf(s)?.setting === true && metaOf(s)?.seo !== true)
  const copy = entries.filter((e) => !seo.includes(e) && !settings.includes(e))
  const names = (list: Array<[string, Schema]>) => list.map(([key]) => `${prefix}.${key}`)
  return (
    <>
      {copy.map(field)}
      {settings.length > 0 && (
        <Area open={hasNotes(ctx, names(settings))} title={t('admin.form.settings')}>
          {settings.map(field)}
        </Area>
      )}
      {seo.map((e) => (
        <Area open={hasNotes(ctx, names([e]))} title={t('admin.form.seo')}>
          {field(e)}
        </Area>
      ))}
    </>
  )
}

function Slot({ ctx, slotKey, slot, state }: {
  ctx: FormContext
  slotKey: string
  slot: SlotDef
  state: DocumentData['slots'][string] | undefined
}) {
  const base = `slots.${slotKey}`
  const label = slot.label ?? slot.block.label
  const enabled = state?.enabled ?? slot.optional !== true
  const shape = defOf(slot.block.schema).shape ?? {}
  const fields = <Fields ctx={ctx} shape={shape} value={state?.data} prefix={`${base}.data`} split labelledBy={cardTitleId(base)} />
  const toggleName = `${base}.enabled`
  const toggleId = formId(toggleName)
  const toggle = notesFor(ctx, toggleName, toggleId, undefined)
  return (
    <Card
      ctx={ctx}
      cardKey={slotKey}
      base={base}
      names={[base]}
      label={label}
      optional={slot.optional === true}
      summary={enabled ? cardSummary(shape, state?.data) : t('admin.form.hiddenSummary')}
    >
      {slot.block.help !== undefined && <p class="mb-4 text-sm text-base-content/70">{slot.block.help}</p>}
      {slot.optional === true && (
        <div class="mb-4 flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <input
              type="checkbox"
              id={toggleId}
              name={toggleName}
              value="true"
              checked={enabled}
              class="toggle"
              disabled={ctx.readOnly === true}
              aria-invalid={toggle.invalid ? 'true' : undefined}
              aria-describedby={toggle.describedBy}
            />
            <label for={toggleId} class="font-medium">
              {t('admin.form.showSection')}
            </label>
          </div>
          {toggle.notes}
        </div>
      )}
      {enabled ? (
        fields
      ) : (
        <Area open={hasNotes(ctx, [`${base}.data`])} title={t('admin.form.hiddenSection')}>
          {fields}
        </Area>
      )}
    </Card>
  )
}

/**
 * The editor form's fields for a document: a card of the entry slug and path and the page fields, then a card per
 * slot in template order.
 */
export function DocumentFields({ ctx, data, entry }: { ctx: FormContext; data: DocumentData; entry?: { customPaths: boolean } }): Html {
  const def = ctx.registry.getType(ctx.type)
  const { template } = def
  const leaf = (meta: FieldMeta): Node & { kind: 'leaf' } => ({ kind: 'leaf', meta, widget: textWidget })
  const shape = defOf(template.fields).shape ?? {}
  return (
    <>
      {(entry !== undefined || Object.keys(shape).length > 0) && (
        <Card
          ctx={ctx}
          cardKey="fields"
          base="fields"
          names={['fields', 'slug', 'path']}
          label={template.label ?? def.label}
          optional={false}
          summary={cardSummary(shape, data.fields)}
        >
          {entry && <Leaf ctx={ctx} node={leaf(slugMeta())} name="slug" value={data.slug} optional />}
          {entry?.customPaths === true && <Leaf ctx={ctx} node={leaf(pathMeta())} name="path" value={data.path} optional />}
          <Fields ctx={ctx} shape={shape} value={data.fields} prefix="fields" split {...(!entry && { labelledBy: cardTitleId('fields') })} />
        </Card>
      )}
      {Object.entries(template.slots).map(([key, slot]) => (
        <Slot ctx={ctx} slotKey={key} slot={slot} state={Object.hasOwn(data.slots, key) ? data.slots[key] : undefined} />
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Names and issues

function addNames(schema: Schema, key: string, value: unknown, name: string, out: Set<string>): void {
  out.add(name)
  const node = nodeOf(schema, key)
  if (node.kind === 'group') addShapeNames(node.shape, value, name, out)
  if (node.kind !== 'list' || !Array.isArray(value)) return
  const shape = itemShape(node.element)
  value.forEach((item: unknown, i) => {
    out.add(`${name}.${i}`)
    if (shape) addShapeNames(shape, item, `${name}.${i}`, out)
  })
}

function addShapeNames(shape: Shape, value: unknown, prefix: string, out: Set<string>): void {
  const record = isRecord(value) ? value : {}
  for (const [key, schema] of Object.entries(shape)) {
    addNames(schema, key, Object.hasOwn(record, key) ? record[key] : undefined, `${prefix}.${key}`, out)
  }
}

/** Every name the form renders for `data`: fields, groups, lists and their items, `slug`, `path` and slot switches. */
export function formNames(registry: Registry, type: string, data: DocumentData): Set<string> {
  const def = registry.getType(type)
  const out = new Set<string>()
  if (isCollection(def)) {
    out.add('slug')
    if (def.customPaths) out.add('path')
  }
  addShapeNames(defOf(def.template.fields).shape ?? {}, data.fields, 'fields', out)
  for (const [key, slot] of Object.entries(def.template.slots)) {
    if (slot.optional === true) out.add(`slots.${key}.enabled`)
    const state = Object.hasOwn(data.slots, key) ? data.slots[key] : undefined
    addShapeNames(defOf(slot.block.schema).shape ?? {}, state?.data, `slots.${key}.data`, out)
  }
  return out
}

/** Puts each issue on the longest prefix of its path that the form renders; the rest are `unplaced`. */
export function placeIssues(
  registry: Registry,
  type: string,
  data: DocumentData,
  issues: ContentIssue[],
): { byName: Map<string, string[]>; unplaced: ContentIssue[] } {
  const names = formNames(registry, type, data)
  const byName = new Map<string, string[]>()
  const unplaced: ContentIssue[] = []
  for (const issue of issues) {
    let placed = false
    for (let k = issue.path.length; k > 0 && !placed; k--) {
      const name = formName(issue.path.slice(0, k))
      if (!names.has(name)) continue
      byName.set(name, [...(byName.get(name) ?? []), issue.message])
      placed = true
    }
    if (!placed) unplaced.push(issue)
  }
  return { byName, unplaced }
}

// ---------------------------------------------------------------------------
// Reading the submitted form

const INDEX = /^(0|[1-9]\d{0,8})(?:\.|$)/

/** The sorted distinct item indexes `i` for which some submitted name is `<list>.<i>` or starts with `<list>.<i>.`. */
function listIndexes(names: readonly string[], list: string): number[] {
  const prefix = `${list}.`
  const found = new Set<number>()
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const m = INDEX.exec(name.slice(prefix.length))
    if (m) found.add(Number(m[1]))
  }
  return [...found].sort((a, b) => a - b)
}

/** Whether a group that wasn't stored got a value: a box (which always reads as ticked or not) only counts when ticked. */
function filledIn(shape: Shape, value: Record<string, unknown>): boolean {
  return Object.entries(value).some(([key, v]) => {
    const schema = shape[key]
    return !(v === false && schema !== undefined && nodeOf(schema, key).meta.kind === 'boolean')
  })
}

/**
 * One value of the submitted form. A group or list is kept, even empty, when its `_present` marker says it was
 * stored; without the marker it is saved only once something is filled in. With `loose`, the value sits in a group
 * that wasn't stored, so an empty control reads as absent even when the field is required: a group left untouched
 * stays absent.
 */
function parseNode(schema: Schema, key: string, name: string, form: FormValues, names: readonly string[], loose: boolean): unknown {
  const node = nodeOf(schema, key)
  const optional = isOptional(schema)
  const present = form.get(presentName(name)) !== undefined
  if (node.kind === 'group') {
    const value = parseShape(node.shape, name, form, names, !present)
    return present || filledIn(node.shape, value) ? value : undefined
  }
  if (node.kind === 'list') {
    const shape = itemShape(node.element)
    const items = listIndexes(names, name).map((i) => {
      const itemName = `${name}.${i}`
      if (shape) return parseShape(shape, itemName, form, names)
      const leaf = itemLeaf(node.element, '')
      return leaf.widget.parse(form, itemName, leaf.meta, false)
    })
    return items.length === 0 && !present ? undefined : items
  }
  return node.widget.parse(form, name, node.meta, optional || loose)
}

function parseShape(shape: Shape, prefix: string, form: FormValues, names: readonly string[], loose = false): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(shape)) {
    const value = parseNode(schema, key, `${prefix}.${key}`, form, names, loose)
    if (value !== undefined) out[key] = value
  }
  return out
}

/** The document a submitted editor form describes. Driven by the schema: only schema keys are read. */
export function parseDocumentForm(registry: Registry, type: string, form: FormValues): DocumentData {
  const def = registry.getType(type)
  const names = form.names()
  const out: DocumentData = { fields: {}, slots: {} }
  if (isCollection(def)) {
    const slug = textWidget.parse(form, 'slug', slugMeta(), true)
    if (typeof slug === 'string') out.slug = slug
    if (def.customPaths) {
      const path = textWidget.parse(form, 'path', pathMeta(), true)
      if (typeof path === 'string') out.path = path
    }
  }
  out.fields = parseShape(defOf(def.template.fields).shape ?? {}, 'fields', form, names)
  for (const [key, slot] of Object.entries(def.template.slots)) {
    const enabled = slot.optional === true ? form.get(`slots.${key}.enabled`) === 'true' : true
    out.slots[key] = { enabled, data: parseShape(defOf(slot.block.schema).shape ?? {}, `slots.${key}.data`, form, names) }
  }
  return out
}

// ---------------------------------------------------------------------------
// List operations

/** The schema at a document path, stopping at leaves; `undefined` if the path isn't in the schema. */
function schemaAt(def: TypeDef, path: PathSegment[]): Schema | undefined {
  const [head, ...rest] = path
  let current: Schema
  let segments: PathSegment[]
  if (head === 'fields') {
    current = def.template.fields
    segments = rest
  } else if (head === 'slots') {
    const [key, part, ...more] = rest
    if (typeof key !== 'string' || !Object.hasOwn(def.template.slots, key) || part !== 'data') return undefined
    current = def.template.slots[key]!.block.schema
    segments = more
  } else {
    return undefined
  }
  for (const segment of segments) {
    const meta = metaOf(current)
    if (meta && meta.kind !== 'group' && meta.kind !== 'list') return undefined
    if (typeof segment === 'string') {
      const shape = meta?.kind === 'list' ? undefined : shapeOf(current)
      if (!shape || !Object.hasOwn(shape, segment)) return undefined
      current = shape[segment]!
    } else {
      const element = meta?.kind === 'list' ? defOf(unwrap(current)).element : undefined
      if (!element) return undefined
      current = element
    }
  }
  return current
}

/** The object at `path` inside `root`; with `create`, absent objects on the way are made. */
function objectAt(root: unknown, path: PathSegment[], create: boolean): Record<string, unknown> | undefined {
  let current = root
  for (const segment of path) {
    if (typeof segment === 'number') {
      current = Array.isArray(current) ? (current as unknown[])[segment] : undefined
      continue
    }
    if (!isRecord(current)) return undefined
    if (!Object.hasOwn(current, segment) || current[segment] === undefined) {
      if (!create) return undefined
      current[segment] = {}
    }
    current = current[segment]
  }
  return isRecord(current) ? current : undefined
}

const OP = /^(add|remove|up|down):(.+)$/

/**
 * Applies a list button: `add:<list>` appends an empty item, and `remove|up|down:<list>.<i>` removes or moves
 * one. Anything that isn't a list or an existing item gives back `data` itself.
 */
export function applyFormOp(registry: Registry, type: string, data: DocumentData, op: string): DocumentData {
  const m = OP.exec(op)
  const path = m ? parsePath(m[2]!) : null
  if (!m || !path) return data
  const def = registry.getType(type)
  const action = m[1]

  if (action === 'add') {
    const list = schemaAt(def, path)
    const key = path.at(-1)
    if (!list || metaOf(list)?.kind !== 'list' || typeof key !== 'string') return data
    const element = defOf(unwrap(list)).element
    if (!element) return data
    const next = structuredClone(data)
    const parent = objectAt(next, path.slice(0, -1), true)
    if (!parent) return data
    const current = parent[key]
    if (current !== undefined && !Array.isArray(current)) return data
    const items: unknown[] = Array.isArray(current) ? current : []
    items.push(itemShape(element) ? {} : undefined)
    parent[key] = items
    return next
  }

  const index = path.at(-1)
  const listPath = path.slice(0, -1)
  const list = schemaAt(def, listPath)
  const key = listPath.at(-1)
  if (typeof index !== 'number' || !list || metaOf(list)?.kind !== 'list' || typeof key !== 'string') return data
  const next = structuredClone(data)
  const items = objectAt(next, listPath.slice(0, -1), false)?.[key]
  if (!Array.isArray(items) || index >= items.length) return data
  const swap = (a: number, b: number) => {
    ;[items[a], items[b]] = [items[b], items[a]]
  }
  if (action === 'remove') items.splice(index, 1)
  else if (action === 'up' && index > 0) swap(index - 1, index)
  else if (action === 'down' && index < items.length - 1) swap(index, index + 1)
  else return data
  return next
}

/** Reads the comma-separated `_open` / `_closed` form values. */
export function readOpenState(form: FormValues): { open: string[]; closed: string[] } {
  const list = (name: string) => (form.get(name) ?? '').split(',').filter((s) => s !== '')
  return { open: list('_open'), closed: list('_closed') }
}

/**
 * Item form names open after `op`, given those open before it: up/down move a name with its item, remove drops it
 * and shifts later siblings down, add opens the new item. `data` is the form's data before `op` is applied.
 */
export function remapOpen(registry: Registry, type: string, data: DocumentData, op: string, open: string[]): string[] {
  const next = applyFormOp(registry, type, data, op)
  const m = OP.exec(op)
  const path = m ? parsePath(m[2]!) : null
  if (next === data || !m || !path) return open
  if (m[1] === 'add') {
    const items = objectAt(next, path.slice(0, -1), false)?.[path.at(-1) as string]
    return Array.isArray(items) ? [...open, `${formName(path)}.${items.length - 1}`] : open
  }
  const index = path.at(-1) as number
  const prefix = `${formName(path.slice(0, -1))}.`
  const moved = (i: number): number | undefined => {
    if (m[1] === 'remove') return i === index ? undefined : i > index ? i - 1 : i
    const other = m[1] === 'up' ? index - 1 : index + 1
    return i === index ? other : i === other ? index : i
  }
  return open.flatMap((name) => {
    if (!name.startsWith(prefix)) return [name]
    const rest = name.slice(prefix.length)
    const found = INDEX.exec(rest)
    if (!found) return [name]
    const to = moved(Number(found[1]))
    return to === undefined ? [] : [`${prefix}${to}${rest.slice(found[1]!.length)}`]
  })
}
