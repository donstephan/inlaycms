import { z } from 'zod'
import { InlayError } from '../errors.js'
import { missingMediaLabel } from '../media/labels.js'
import { t } from '../messages/index.js'
import { INLINE_TEXT, markdownToInlineText, parseInlineText } from '../richtext/inline.js'
import { markdownToRichText, richTextToMarkdown } from '../richtext/markdown.js'
import {
  DEFAULT_RICH_TEXT,
  parseRichText,
  RICH_TEXT_FEATURES,
  richTextIsBlank,
  richTextRefs,
  richTextText,
  type RichTextDoc,
  type RichTextFeature,
  type RichTextOptions,
} from '../richtext/schema.js'
import type { ContentRef } from '../types.js'
import { defineField, isSafeUrl, type AgentCodec, type AgentRefs } from './define.js'
import {
  booleanWidget,
  datetimeWidget,
  dateWidget,
  fileWidget,
  imageWidget,
  inlineTextWidget,
  linkWidget,
  multiSelectWidget,
  numberWidget,
  refsWidget,
  refWidget,
  richTextWidget,
  selectWidget,
  textareaWidget,
  textWidget,
} from './widgets.js'
import { isRecord } from './zod-internals.js'

interface BaseOptions {
  label: string
  help?: string
  setting?: boolean
}

function base(o: BaseOptions) {
  return {
    label: o.label,
    ...(o.help !== undefined && { help: o.help }),
    ...(o.setting !== undefined && { setting: o.setting }),
  }
}

const HEX64 = /^[0-9a-f]{64}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

function isRealDate(s: string): boolean {
  if (!DATE.test(s)) return false
  const [y, m, d] = s.split('-').map(Number) as [number, number, number]
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

interface TextOptions extends BaseOptions {
  maxLength?: number
  suggestedLength?: number
}

/** Marks the issue from text and textarea's non-blank check (in `params.check`). */
export const NON_BLANK = 'nonBlank'
/** The `check` param of the refinements that make a date or datetime field reject a malformed value. */
export const DATE_CHECK = 'date'
export const DATETIME_CHECK = 'datetime'

/** The `check` param of the refinement that holds an inline-text field to its `maxLength` (in `params.max`). */
export const INLINE_TEXT_MAX = 'inlineTextMax'

/** The `check` param of the refinement that makes a title template need exactly one `%s`. */
export const TITLE_TEMPLATE_CHECK = 'titleTemplate'

/** Whether `s` has `%s` exactly once. */
export function isTitleTemplate(s: string): boolean {
  return s.split('%s').length === 2
}

function stringField(
  kind: 'text' | 'textarea',
  o: TextOptions,
  also?: { test: (s: string) => boolean; check: string },
) {
  let draft = z.string()
  if (o.maxLength !== undefined) draft = draft.max(o.maxLength)
  if (also) draft = draft.refine(also.test, { params: { check: also.check } })
  const strict = draft.refine((s) => s.trim().length > 0, { params: { check: NON_BLANK } })
  return defineField(strict, {
    kind,
    ...base(o),
    ...(o.suggestedLength !== undefined && { suggestedLength: o.suggestedLength }),
    draft,
    admin: kind === 'text' ? textWidget : textareaWidget,
    empty: '',
  })
}

const documentRef = (id: string): ContentRef => ({ kind: 'document', id })

/** The options in canonical order, checked when the field is defined. */
function richTextOptions(o: { label: string; features?: RichTextFeature[]; headings?: number[] }): RichTextOptions {
  const fail = (value: unknown): never => {
    throw new InlayError('definition', 'definition.richText', {
      field: o.label,
      value: String(value),
      features: RICH_TEXT_FEATURES.join(', '),
    })
  }
  const features = o.features ?? DEFAULT_RICH_TEXT.features
  for (const feature of features) if (!RICH_TEXT_FEATURES.includes(feature)) fail(feature)
  const headings = o.headings ?? DEFAULT_RICH_TEXT.headings
  for (const level of headings) if (!Number.isInteger(level) || level < 1 || level > 6) fail(level)
  return {
    features: RICH_TEXT_FEATURES.filter((feature) => features.includes(feature)),
    headings: [...new Set(headings)].sort((a, b) => a - b),
  }
}

// ---------------------------------------------------------------------------
// Agent codecs: how image, file, ref, link and rich text values look to an assistant.

const readOnly = () => ({ type: 'string', readOnly: true, description: t('agent.readOnly') })

const unchanged = (value: unknown) => ({ ok: true as const, value })

const withText = (v: Record<string, unknown>) => (v.text !== undefined ? { text: v.text } : {})

function readMedia(value: unknown, refs: AgentRefs, image: boolean): unknown {
  if (!isRecord(value) || typeof value.media !== 'string') return value
  const id = value.media
  const alt = image && value.alt !== undefined ? { alt: value.alt } : {}
  const status = refs.media(id)
  if (status.status === 'present') return { id, filename: status.media.filename, ...alt, url: refs.mediaUrl(id) }
  if (status.status === 'deleted') return { id, filename: status.filename, ...alt, missing: missingMediaLabel(status) }
  return { id, ...alt, missing: t('agent.mediaUnknown') }
}

function mediaCodec(image: boolean): AgentCodec {
  return {
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: t('agent.mediaId') },
        ...(image && { alt: { type: 'string', description: t('agent.alt') } }),
        filename: readOnly(),
        url: readOnly(),
        missing: readOnly(),
      },
      required: ['id'],
    },
    read: (value, refs) => readMedia(value, refs, image),
    write(value) {
      if (!isRecord(value)) return unchanged(value)
      const id = typeof value.id === 'string' ? value.id : value.media
      if (typeof id !== 'string') return unchanged(value)
      return unchanged({ media: id, ...(image && value.alt !== undefined && { alt: value.alt }) })
    },
  }
}

/** The id in an id string or `{ id }`; anything else unchanged. */
const idOf = (v: unknown): unknown => (isRecord(v) && typeof v.id === 'string' ? v.id : v)

function readDocument(id: string, refs: AgentRefs): { id: string; title: string; url: string | null } | { id: string; missing: string } {
  const found = refs.document(id)
  return found ? { id, ...found } : { id, missing: t('agent.documentMissing') }
}

function readRef(value: unknown, refs: AgentRefs): unknown {
  if (typeof value !== 'string') return value
  const found = readDocument(value, refs)
  return 'missing' in found ? found : { id: value, title: found.title }
}

/** An id string, or `{ id }` with the read-only keys it is read with. */
function documentIdSchema(readKeys: string[]) {
  const id = { type: 'string', description: t('agent.documentId') }
  const read = Object.fromEntries(readKeys.map((key) => [key, readOnly()]))
  return { anyOf: [id, { type: 'object', properties: { id, ...read }, required: ['id'] }] }
}

function refCodec(many: boolean, min?: number, max?: number): AgentCodec {
  if (!many) {
    return { schema: documentIdSchema(['title', 'missing']), read: readRef, write: (value) => unchanged(idOf(value)) }
  }
  return {
    schema: {
      type: 'array',
      items: documentIdSchema(['title', 'missing']),
      ...(min !== undefined && { minItems: min }),
      ...(max !== undefined && { maxItems: max }),
    },
    read: (value, refs) => (Array.isArray(value) ? value.map((v) => readRef(v, refs)) : value),
    write: (value) => unchanged(Array.isArray(value) ? value.map(idOf) : value),
  }
}

function linkCodec(): AgentCodec {
  const text = { type: 'string', description: t('agent.linkText') }
  const document = documentIdSchema(['title', 'url', 'missing'])
  const url = { type: 'string', description: t('agent.linkUrl') }
  return {
    schema: {
      anyOf: [
        { type: 'object', properties: { document, text }, required: ['document'] },
        { type: 'object', properties: { url, text }, required: ['url'] },
      ],
    },
    read(value, refs) {
      if (!isRecord(value) || typeof value.document !== 'string') return value
      return { document: readDocument(value.document, refs), ...withText(value) }
    },
    write(value) {
      if (!isRecord(value)) return unchanged(value)
      if (value.document !== undefined) return unchanged({ document: idOf(value.document), ...withText(value) })
      if (value.url !== undefined) return unchanged({ url: value.url, ...withText(value) })
      return unchanged(value)
    },
  }
}

/** Several options as an array of them, as stored. */
function multiSelectCodec(options: readonly string[], min?: number, max?: number): AgentCodec {
  return {
    schema: {
      type: 'array',
      items: { enum: [...options] },
      uniqueItems: true,
      ...(min !== undefined && { minItems: min }),
      ...(max !== undefined && { maxItems: max }),
    },
    read: (value) => value,
    write: unchanged,
  }
}

/** The formatting `opts` allows, in plain words: "bold text, links, headings of level 2, 3 (…)". */
function allowedFeatures(opts: RichTextOptions): string[] {
  return RICH_TEXT_FEATURES.filter((feature) => opts.features.includes(feature)).flatMap((feature) => {
    if (feature !== 'heading') return [t(`richtext.feature.${feature}`)]
    return opts.headings.length > 0 ? [t('agent.richTextHeadings', { levels: opts.headings.join(', ') })] : []
  })
}

/** What a rich-text field accepts, in plain words: "Markdown. Allowed: bold text, links, headings of level 2, 3 (…)." */
function richTextDescription(opts: RichTextOptions): string {
  const allowed = allowedFeatures(opts)
  return allowed.length > 0 ? t('agent.richText', { features: allowed.join(', ') }) : t('agent.richTextNone')
}

function richTextCodec(opts: RichTextOptions, inline = false): AgentCodec {
  const description = inline
    ? t('agent.inlineText', { features: allowedFeatures(opts).join(', ') })
    : richTextDescription(opts)
  return {
    schema: { type: 'string', contentMediaType: 'text/markdown', description },
    read(value) {
      if (!isRecord(value)) return value
      try {
        return richTextToMarkdown(value as RichTextDoc)
      } catch {
        return value
      }
    },
    write(value) {
      if (typeof value !== 'string') return unchanged(value)
      const result = inline ? markdownToInlineText(value) : markdownToRichText(value, opts)
      return result.ok ? unchanged(result.doc) : { ok: false, problems: result.problems.map((p) => p.message) }
    },
  }
}

export const f = {
  text: (o: TextOptions) => stringField('text', o),
  textarea: (o: TextOptions) => stringField('textarea', o),

  number(o: BaseOptions & { min?: number; max?: number; integer?: boolean }) {
    let s = z.number()
    if (o.integer) s = s.int()
    if (o.min !== undefined) s = s.min(o.min)
    if (o.max !== undefined) s = s.max(o.max)
    return defineField(s, { kind: 'number', ...base(o), admin: numberWidget, empty: 0 })
  },

  boolean: (o: BaseOptions) =>
    defineField(z.boolean().default(false), { kind: 'boolean', ...base(o), admin: booleanWidget }),

  select<const T extends readonly [string, ...string[]]>(options: T, o: BaseOptions) {
    return defineField(z.enum(options), { kind: 'select', ...base(o), options, admin: selectWidget, empty: options[0] })
  },

  /**
   * Any of `options`, saved in the options' order without duplicates. `min` and `max` are checked at publish. A
   * stored option the code no longer offers is dropped when the value is read.
   */
  multiSelect<const T extends readonly [string, ...string[]]>(
    options: T,
    o: BaseOptions & { min?: number; max?: number },
  ): z.ZodType<T[number][], T[number][]> {
    type Option = T[number]
    const offered: readonly string[] = options
    const item = z.enum(options) as unknown as z.ZodType<Option, Option>
    const canonical = (v: Option[]): Option[] => {
      const chosen: readonly unknown[] = v
      return offered.filter((x) => chosen.includes(x)) as Option[]
    }
    const draft = z.array(item).transform(canonical)
    let checked = z.array(item)
    if (o.min !== undefined) checked = checked.min(o.min)
    if (o.max !== undefined) checked = checked.max(o.max)
    return defineField(draft.pipe(checked), {
      kind: 'multiSelect',
      ...base(o),
      options,
      many: true,
      draft,
      agent: multiSelectCodec(options, o.min, o.max),
      admin: multiSelectWidget,
      empty: [],
      readStored: (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && offered.includes(x)) : v),
    })
  },

  date: (o: BaseOptions) =>
    defineField(
      z.string().refine(isRealDate, { params: { check: DATE_CHECK } }),
      { kind: 'date', ...base(o), admin: dateWidget, empty: '' },
    ),

  datetime: (o: BaseOptions) =>
    defineField(
      z
        .string()
        .refine((s) => DATETIME.test(s) && !Number.isNaN(Date.parse(s)) && isRealDate(s.slice(0, 10)), {
          params: { check: DATETIME_CHECK },
        }),
      { kind: 'datetime', ...base(o), admin: datetimeWidget, empty: '' },
    ),

  link(o: BaseOptions) {
    const text = z.string().optional()
    const schema = z.union([
      z.object({ document: z.uuid(), text }),
      z.object({ url: z.string().refine(isSafeUrl), text }),
    ])
    return defineField(schema, {
      kind: 'link',
      ...base(o),
      agent: linkCodec(),
      admin: linkWidget,
      empty: { url: '' },
      refs: (v) =>
        isRecord(v) && typeof v.document === 'string' ? [documentRef(v.document)] : [],
    })
  },

  ref(collection: string, o: BaseOptions & { many?: boolean; min?: number; max?: number }) {
    const many = o.many === true
    if (many) {
      let arr = z.array(z.uuid())
      if (o.min !== undefined) arr = arr.min(o.min)
      if (o.max !== undefined) arr = arr.max(o.max)
      return defineField(arr, {
        kind: 'ref',
        ...base(o),
        target: collection,
        many: true,
        agent: refCodec(true, o.min, o.max),
        admin: refsWidget,
        empty: [],
        refs: (v) =>
          Array.isArray(v)
            ? v.filter((x): x is string => typeof x === 'string').map(documentRef)
            : [],
      })
    }
    return defineField(z.uuid(), {
      kind: 'ref',
      ...base(o),
      target: collection,
      many: false,
      agent: refCodec(false),
      admin: refWidget,
      empty: '',
      refs: (v) => (typeof v === 'string' ? [documentRef(v)] : []),
    })
  },

  image(o: BaseOptions) {
    const schema = z.object({ media: z.string().regex(HEX64), alt: z.string().optional() })
    return defineField(schema, {
      kind: 'image',
      ...base(o),
      agent: mediaCodec(true),
      admin: imageWidget,
      empty: { media: '' },
      refs: (v) =>
        isRecord(v) && typeof v.media === 'string' ? [{ kind: 'media', id: v.media }] : [],
    })
  },

  file(o: BaseOptions) {
    const schema = z.object({ media: z.string().regex(HEX64) })
    return defineField(schema, {
      kind: 'file',
      ...base(o),
      agent: mediaCodec(false),
      admin: fileWidget,
      empty: { media: '' },
      refs: (v) =>
        isRecord(v) && typeof v.media === 'string' ? [{ kind: 'media', id: v.media }] : [],
    })
  },

  richText(o: BaseOptions & { features?: RichTextFeature[]; headings?: number[] }) {
    const opts = richTextOptions(o)
    const draft = z
      .custom<unknown>((v) => parseRichText(v, opts).ok)
      .meta({ richText: { features: [...opts.features], headings: [...opts.headings] } })
      .transform((v) => (parseRichText(v, opts) as { ok: true; doc: RichTextDoc }).doc)
    const strict = draft.refine((doc) => !richTextIsBlank(doc), { params: { check: NON_BLANK } })
    return defineField(strict, {
      kind: 'richText',
      ...base(o),
      draft,
      richText: opts,
      agent: richTextCodec(opts),
      admin: richTextWidget,
      empty: { type: 'doc', content: [] },
      refs: (v) => (isRecord(v) ? richTextRefs(v as RichTextDoc) : []),
    })
  },

  inlineText(o: BaseOptions & { maxLength?: number }) {
    const parsed = z
      .custom<unknown>((v) => parseInlineText(v).ok)
      .meta({ inlineText: { features: [...INLINE_TEXT.features] } })
      .transform((v) => (parseInlineText(v) as { ok: true; doc: RichTextDoc }).doc)
    const max = o.maxLength
    const draft =
      max === undefined
        ? parsed
        : parsed.refine((doc) => richTextText(doc).length <= max, { params: { check: INLINE_TEXT_MAX, max } })
    const strict = draft.refine((doc) => !richTextIsBlank(doc), { params: { check: NON_BLANK } })
    return defineField(strict, {
      kind: 'inlineText',
      ...base(o),
      draft,
      richText: INLINE_TEXT,
      agent: richTextCodec(INLINE_TEXT, true),
      admin: inlineTextWidget,
      empty: { type: 'doc', content: [] },
      refs: (v) => (isRecord(v) ? richTextRefs(v as RichTextDoc) : []),
    })
  },

  list<T extends z.ZodObject>(
    item: T,
    o: BaseOptions & { min?: number; max?: number; itemLabel?: string },
  ) {
    let arr = z.array(item)
    if (o.min !== undefined) arr = arr.min(o.min)
    if (o.max !== undefined) arr = arr.max(o.max)
    return defineField(arr, {
      kind: 'list',
      ...base(o),
      ...(o.itemLabel !== undefined && { itemLabel: o.itemLabel }),
    })
  },

  group<T extends z.ZodRawShape>(shape: T, o: BaseOptions & { seo?: true }) {
    return defineField(z.object(shape), {
      kind: 'group',
      ...base(o),
      ...(o.seo && { seo: true as const }),
    })
  },

  seo(o: { label?: string } = {}) {
    return f.group(
      {
        title: f.text({ label: t('label.seo.title'), suggestedLength: 70, maxLength: 300 }).optional(),
        description: f.textarea({ label: t('label.seo.description'), suggestedLength: 160, maxLength: 500 }).optional(),
        image: f.image({ label: t('label.seo.image') }).optional(),
      },
      { label: o.label ?? t('label.seo'), seo: true },
    )
  },

  seoDefaults(o: { label?: string } = {}) {
    return defineField(
      z.object({
        titleTemplate: stringField(
          'text',
          { label: t('label.seoDefaults.titleTemplate'), help: t('label.seoDefaults.titleTemplateHelp'), maxLength: 100 },
          { test: isTitleTemplate, check: TITLE_TEMPLATE_CHECK },
        ).optional(),
        description: f
          .textarea({ label: t('label.seoDefaults.description'), suggestedLength: 160, maxLength: 500 })
          .optional(),
        image: f.image({ label: t('label.seoDefaults.image') }).optional(),
      }),
      { kind: 'group', label: o.label ?? t('label.seoDefaults'), seoDefaults: true },
    )
  },
}
