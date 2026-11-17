import { isRasterImage } from '../media/detect.js'
import { missingMediaLabel } from '../media/labels.js'
import { t } from '../messages/index.js'
import { DEFAULT_RICH_TEXT, parseRichText, RICH_TEXT_FEATURES, richTextIsBlank } from '../richtext/schema.js'
import type { AdminWidget, FormValues, WidgetProps } from './define.js'
import { isRecord } from './zod-internals.js'

/** The attributes every control shares. */
const control = (p: WidgetProps) => ({
  id: p.id,
  name: p.name,
  disabled: p.readOnly,
  'aria-invalid': p.invalid ? 'true' : undefined,
  'aria-describedby': p.describedBy,
})

/** A stored value as text for a control: strings as they are, other values written out. */
function asText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** Browsers drop one newline right after `<textarea>`, so a value starting with one gets an extra. */
const textareaBody = (s: string): string => (s.startsWith('\n') ? `\n${s}` : s)

/** A submitted value with its newlines as `\n`: browsers send them as CRLF. */
function submitted(form: FormValues, name: string): string | undefined {
  return form.get(name)?.replace(/\r\n?/g, '\n')
}

/** `''` → absent when optional; otherwise the raw text. */
function parseText(form: FormValues, name: string, optional: boolean): string | undefined {
  const raw = submitted(form, name)
  if (raw === undefined) return undefined
  return raw === '' && optional ? undefined : raw
}

/** `''` → absent; otherwise the raw text. */
function parseNonEmpty(form: FormValues, name: string): string | undefined {
  const raw = submitted(form, name)
  return raw === undefined || raw === '' ? undefined : raw
}

/** A one-line text input, which browsers would strip of newlines, as a free text box with the stored value as it is. */
const plainInput = (p: WidgetProps, value: string) => <input type="text" value={value} class="input input-bordered w-full" {...control(p)} />

/** The control's attributes, with the counter's id added to what describes it when there is a counter. */
const countedControl = (p: WidgetProps) =>
  p.meta.suggestedLength === undefined ? control(p) : { ...control(p), 'aria-describedby': [p.describedBy, `${p.id}-length`].filter((x) => x !== undefined).join(' ') }

/** A live character count under a control, with a hint that shows once the text is past the suggested length. */
function LengthCounter({ p, value }: { p: WidgetProps; value: string }) {
  const n = p.meta.suggestedLength
  if (n === undefined) return null
  const length = value.length
  return (
    <p id={`${p.id}-length`} data-length-for={p.id} data-suggested-length={n} data-label={t('admin.form.length', { count: '{count}', suggested: n })} aria-live="polite" class="text-sm text-base-content/70">
      <span data-length-count>{t('admin.form.length', { count: length, suggested: n })}</span>{' '}
      <span data-length-hint hidden={length <= n}>
        {t('admin.form.lengthOver', { suggested: n })}
      </span>
    </p>
  )
}

export const textWidget: AdminWidget = {
  render(p) {
    const value = asText(p.value)
    const attrs = countedControl(p)
    // A one-line input would drop the newlines of a stored value, so it gets a text box instead.
    const input = /[\r\n]/.test(value) ? (
      <textarea rows="3" class="textarea textarea-bordered w-full" {...attrs}>
        {textareaBody(value)}
      </textarea>
    ) : (
      <input type="text" value={value} class="input input-bordered w-full" {...attrs} />
    )
    return (
      <>
        {input}
        <LengthCounter p={p} value={value} />
      </>
    )
  },
  parse: (form, name, _meta, optional) => parseText(form, name, optional),
}

export const textareaWidget: AdminWidget = {
  render(p) {
    const value = asText(p.value)
    return (
      <>
        <textarea rows="4" class="textarea textarea-bordered w-full" {...countedControl(p)}>
          {textareaBody(value)}
        </textarea>
        <LengthCounter p={p} value={value} />
      </>
    )
  },
  parse: (form, name, _meta, optional) => parseText(form, name, optional),
}

/** HTML's valid floating-point number: what a `type=number` input keeps; it blanks anything else. */
const VALID_FLOAT = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/

export const numberWidget: AdminWidget = {
  render(p) {
    const value = asText(p.value)
    // A value the number input would blank is shown as it is, so it is seen and saving keeps it.
    if (value !== '' && !VALID_FLOAT.test(value)) return plainInput(p, value)
    return <input type="number" step="any" value={value} class="input input-bordered w-full" {...control(p)} />
  },
  parse(form, name) {
    const raw = form.get(name)
    if (raw === undefined || raw.trim() === '') return undefined
    const n = Number(raw)
    return Number.isFinite(n) ? n : raw
  },
}

export const booleanWidget: AdminWidget = {
  render: (p) => <input type="checkbox" value="true" checked={p.value === true} class="checkbox" {...control(p)} />,
  parse: (form, name) => form.get(name) === 'true',
}

export const selectWidget: AdminWidget = {
  render(p) {
    const options = p.meta.options ?? []
    const current = typeof p.value === 'string' ? p.value : undefined
    // A value that isn't one of the options is kept as its own choice, so saving doesn't change it.
    const unknown = current !== undefined && current !== '' && !options.includes(current)
    return (
      <select class="select select-bordered w-full" {...control(p)}>
        {(p.optional || current === undefined) && <option value="">{t('admin.form.none')}</option>}
        {unknown && (
          <option value={current} selected>
            {current}
          </option>
        )}
        {options.map((o) => (
          <option value={o} selected={o === current}>
            {o}
          </option>
        ))}
      </select>
    )
  },
  parse: (form, name) => parseNonEmpty(form, name),
}

/** Whether `text` is HTML's valid date string (`YYYY-MM-DD`, a real day), which a `type=date` input keeps. */
function isDateInput(text: string): boolean {
  const m = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(text)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false
  const date = new Date(0)
  date.setUTCFullYear(y, mo - 1, d)
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
}

export const dateWidget: AdminWidget = {
  render(p) {
    const value = asText(p.value)
    // A value the date input would blank is shown as it is, so it is seen and saving keeps it.
    if (value !== '' && !isDateInput(value)) return plainInput(p, value)
    return <input type="date" value={value} class="input input-bordered w-full" {...control(p)} />
  },
  parse: (form, name) => parseNonEmpty(form, name),
}

/** A stored datetime as a `datetime-local` value in UTC (`YYYY-MM-DDTHH:MM:SS`); anything unreadable as it is. */
function utcInput(value: unknown): string {
  const text = asText(value)
  const ms = Date.parse(text)
  return Number.isNaN(ms) ? text : new Date(ms).toISOString().slice(0, 19)
}

const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

/** `YYYY-MM-DDTHH:MM(:SS)?` read as UTC, written `YYYY-MM-DDTHH:MM:SSZ`; `undefined` if it isn't a real time. */
function fromUtcInput(raw: string): string | undefined {
  const m = LOCAL_DATETIME.exec(raw)
  if (!m) return undefined
  const [y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0] = m.slice(1).map((part) => Number(part ?? 0))
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  const real =
    date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d &&
    date.getUTCHours() === h && date.getUTCMinutes() === mi && date.getUTCSeconds() === s
  return real ? `${raw.slice(0, 16)}:${String(s).padStart(2, '0')}Z` : undefined
}

export const datetimeWidget: AdminWidget = {
  render(p) {
    const shown = utcInput(p.value)
    // A value the datetime input would blank is shown as it is, so it is seen and saving keeps it.
    const readable = shown === '' || fromUtcInput(shown) !== undefined
    return (
      <>
        {readable ? (
          <input type="datetime-local" step="1" value={shown} class="input input-bordered w-full" {...control(p)} />
        ) : (
          plainInput(p, asText(p.value))
        )}
        <input type="hidden" name={`${p.name}.was`} value={asText(p.value)} disabled={p.readOnly} />
      </>
    )
  },
  parse(form, name) {
    const raw = form.get(name)
    if (raw === undefined) return undefined
    const was = form.get(`${name}.was`)
    if (was !== undefined && was !== '') {
      // Browsers drop zero seconds from a datetime input's value, so the time is compared rather than the text.
      const shown = utcInput(was)
      const time = fromUtcInput(raw)
      if (raw === was || raw === shown || (time !== undefined && time === fromUtcInput(shown))) return was
    }
    if (raw === '') return undefined
    return fromUtcInput(raw) ?? raw
  },
}

/** The fallback for fields without a widget of their own: the value as JSON. */
export const jsonWidget: AdminWidget = {
  render: (p) => (
    <textarea rows="6" class="textarea textarea-bordered w-full font-mono text-sm" {...control(p)}>
      {textareaBody(p.value === undefined ? '' : JSON.stringify(p.value, null, 2))}
    </textarea>
  ),
  parse(form, name) {
    const raw = submitted(form, name)
    if (raw === undefined || raw.trim() === '') return undefined
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return raw
    }
  },
}

// ---------------------------------------------------------------------------
// Pickers: media, references and links. `client/admin/picker.ts` opens the picker and fills them in.

/** What a picker shows for the current value; `missing` marks it as no longer there. */
interface Shown {
  label: string
  thumb?: string
  missing?: boolean
}

function shownMedia(id: string, refs: WidgetProps['refs']): Shown {
  const status = refs.media(id)
  if (status.status === 'present') {
    const { media } = status
    return { label: media.filename, ...(isRasterImage(media.mime) && { thumb: `/media/${media.id}/320.webp` }) }
  }
  if (status.status === 'deleted') return { label: missingMediaLabel(status), missing: true }
  return { label: t('admin.form.missingMedia'), missing: true }
}

function shownDocument(id: string, refs: WidgetProps['refs']): Shown {
  const found = refs.document(id)
  return found ? { label: found.title } : { label: t('admin.form.missingEntry'), missing: true }
}

/** The chosen value's name (and thumbnail), which `applyPick` and `clearField` update. */
function Preview({ id, shown, thumbs }: { id: string; shown: Shown | undefined; thumbs: boolean }) {
  return (
    <div class="flex items-center gap-3">
      {thumbs && (
        <img
          data-picker-thumb
          src={shown?.thumb}
          alt=""
          hidden={shown?.thumb === undefined}
          class="h-16 w-16 rounded-box bg-base-200 object-cover"
        />
      )}
      <span
        id={id}
        data-picker-label
        data-empty={t('admin.form.nothingChosen')}
        class={
          shown?.missing === true
            ? 'rounded-box bg-warning px-2 text-warning-content'
            : shown === undefined
              ? 'text-base-content/70'
              : undefined
        }
      >
        {shown?.label ?? t('admin.form.nothingChosen')}
      </span>
    </div>
  )
}

/** "Choose…" and, when the field may be left empty, "Remove". */
function PickerButtons({ p, label }: { p: WidgetProps; label: string }) {
  if (p.readOnly) return null
  const describedBy = [`${p.id}-chosen`, p.describedBy].filter((x) => x !== undefined).join(' ')
  return (
    <div class="flex flex-wrap gap-2">
      <button type="button" id={p.id} data-picker-open class="btn btn-sm" aria-describedby={describedBy} aria-invalid={p.invalid ? 'true' : undefined}>
        {label}
      </button>
      {p.optional && (
        <button type="button" data-picker-clear class="btn btn-ghost btn-sm">
          {t('admin.form.clear')}
        </button>
      )}
    </div>
  )
}

const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

function mediaWidget(kind: 'image' | 'file'): AdminWidget {
  return {
    fieldset: true,
    render(p) {
      const record = isRecord(p.value) ? p.value : {}
      const id = textOf(record.media)
      const status = id === undefined ? undefined : p.refs.media(id)
      const defaultAlt = status?.status === 'present' ? status.media.defaultAlt : null
      const altId = `${p.id}-alt`
      return (
        <div data-picker={`/admin/pick/media?kind=${kind}`} data-name={p.name} class="flex flex-col gap-2">
          <input type="hidden" name={`${p.name}.media`} value={id ?? ''} data-picker-value disabled={p.readOnly} />
          <Preview id={`${p.id}-chosen`} shown={id === undefined ? undefined : shownMedia(id, p.refs)} thumbs={kind === 'image'} />
          <PickerButtons p={p} label={t('admin.form.choose')} />
          {kind === 'image' && (
            <div class="flex flex-col gap-1">
              <label for={altId} class="text-sm font-medium">
                {t('admin.form.alt')}
              </label>
              <input
                type="text"
                id={altId}
                name={`${p.name}.alt`}
                value={typeof record.alt === 'string' ? record.alt : ''}
                placeholder={defaultAlt ?? undefined}
                disabled={p.readOnly}
                aria-describedby={`${altId}-default`}
                class="input input-bordered w-full"
              />
              <p id={`${altId}-default`} class="text-sm text-base-content/70">
                {t('admin.form.altDefault')}
              </p>
            </div>
          )}
        </div>
      )
    },
    parse(form, name) {
      const media = parseNonEmpty(form, `${name}.media`)
      if (media === undefined) return undefined
      if (kind === 'file') return { media }
      const alt = parseNonEmpty(form, `${name}.alt`)
      return alt === undefined ? { media } : { media, alt }
    },
  }
}

export const imageWidget: AdminWidget = mediaWidget('image')
export const fileWidget: AdminWidget = mediaWidget('file')

const entriesPicker = (p: WidgetProps): string =>
  `/admin/pick/entries?${new URLSearchParams({ collection: p.meta.target ?? '', locale: p.locale }).toString()}`

/** A reference to one entry: its title and the picker buttons. */
export const refWidget: AdminWidget = {
  render(p) {
    const id = textOf(p.value)
    return (
      <div data-picker={entriesPicker(p)} data-name={p.name} class="flex flex-col gap-2">
        <input type="hidden" name={p.name} value={id ?? ''} data-picker-value disabled={p.readOnly} />
        <Preview id={`${p.id}-chosen`} shown={id === undefined ? undefined : shownDocument(id, p.refs)} thumbs={false} />
        <PickerButtons p={p} label={t('admin.form.choose')} />
      </div>
    )
  },
  parse: (form, name) => parseNonEmpty(form, name),
}

function Chip({ name, value, label, missing, readOnly }: { name: string; value: string; label: string; missing: boolean; readOnly: boolean }) {
  return (
    <li class="flex items-center gap-2 rounded-box border border-base-300 px-3 py-1">
      <input type="hidden" name={name} value={value} disabled={readOnly} />
      <span data-chip-label class={missing ? 'rounded-box bg-warning px-2 text-warning-content' : undefined}>
        {label}
      </span>
      {!readOnly && (
        <button type="button" data-picker-remove class="btn btn-ghost btn-xs" aria-label={t('admin.form.removeItem', { item: label })}>
          {t('admin.form.remove')}
        </button>
      )}
    </li>
  )
}

/**
 * References to several entries, as a list of chips. A hidden `<name>.many` marks a stored list, so a list left
 * empty stays empty and an absent one stays absent.
 */
export const refsWidget: AdminWidget = {
  fieldset: true,
  render(p) {
    const ids = Array.isArray(p.value) ? (p.value as unknown[]).filter((v): v is string => typeof v === 'string') : []
    return (
      <div data-picker={entriesPicker(p)} data-name={p.name} data-many class="flex flex-col gap-2">
        {Array.isArray(p.value) && <input type="hidden" name={`${p.name}.many`} value="" disabled={p.readOnly} />}
        <ul data-picker-list id={`${p.id}-chosen`} class="flex flex-wrap gap-2">
          {ids.map((id) => {
            const shown = shownDocument(id, p.refs)
            return <Chip name={p.name} value={id} label={shown.label} missing={shown.missing === true} readOnly={p.readOnly} />
          })}
        </ul>
        {!p.readOnly && (
          <template data-picker-chip data-remove-label={t('admin.form.removeItem', { item: '{item}' })}>
            <Chip name={p.name} value="" label="" missing={false} readOnly={false} />
          </template>
        )}
        <PickerButtons p={{ ...p, optional: false }} label={t('admin.form.add.chosen')} />
      </div>
    )
  },
  parse(form, name) {
    const ids = form.all(name).filter((id) => id !== '')
    if (ids.length > 0) return ids
    return form.get(`${name}.many`) === undefined ? undefined : []
  },
}

/** A link: a page on this site (chosen with the documents picker) or a web address, plus optional link text. */
export const linkWidget: AdminWidget = {
  fieldset: true,
  render(p) {
    const record = isRecord(p.value) ? p.value : {}
    const document = textOf(record.document)
    const url = typeof record.url === 'string' ? record.url : ''
    const mode = record.url !== undefined && record.document === undefined ? 'url' : 'document'
    const pageName = `${p.name}.document`
    const picker = `/admin/pick/documents?${new URLSearchParams({ locale: p.locale }).toString()}`
    const urlId = `${p.id}-url`
    const textId = `${p.id}-text`
    const radio = (value: 'document' | 'url', id: string, label: string) => (
      <div class="flex items-center gap-2">
        <input
          type="radio"
          id={id}
          name={`${p.name}.mode`}
          value={value}
          checked={mode === value}
          disabled={p.readOnly}
          data-link-mode={value}
          aria-describedby={p.describedBy}
          aria-invalid={p.invalid ? 'true' : undefined}
          class="radio radio-sm"
        />
        <label for={id}>{label}</label>
      </div>
    )
    return (
      <div data-link class="flex flex-col gap-3">
        <div class="flex flex-wrap gap-4">
          {radio('document', p.id, t('admin.form.link.page'))}
          {radio('url', `${p.id}-mode-url`, t('admin.form.link.url'))}
        </div>
        <div data-picker={picker} data-name={pageName} class="flex flex-col gap-2">
          <input type="hidden" name={pageName} value={document ?? ''} data-picker-value disabled={p.readOnly} />
          <Preview id={`${p.id}-page-chosen`} shown={document === undefined ? undefined : shownDocument(document, p.refs)} thumbs={false} />
          <PickerButtons p={{ ...p, id: `${p.id}-page`, optional: true, describedBy: undefined }} label={t('admin.form.choose')} />
        </div>
        <div class="flex flex-col gap-1">
          <label for={urlId} class="text-sm font-medium">
            {t('admin.form.link.urlLabel')}
          </label>
          {/* Not type="url": the browser would refuse to submit a site-relative address such as /blog. */}
          <input
            type="text"
            inputmode="url"
            id={urlId}
            name={`${p.name}.url`}
            value={url}
            disabled={p.readOnly}
            data-link-url
            class="input input-bordered w-full"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label for={textId} class="text-sm font-medium">
            {t('admin.form.link.text')}
          </label>
          <input
            type="text"
            id={textId}
            name={`${p.name}.text`}
            value={typeof record.text === 'string' ? record.text : ''}
            disabled={p.readOnly}
            class="input input-bordered w-full"
          />
        </div>
      </div>
    )
  },
  parse(form, name) {
    const mode = form.get(`${name}.mode`)
    const text = parseNonEmpty(form, `${name}.text`)
    const withText = text === undefined ? {} : { text }
    if (mode === 'url') {
      const url = parseNonEmpty(form, `${name}.url`)
      return url === undefined ? undefined : { url, ...withText }
    }
    const document = parseNonEmpty(form, `${name}.document`)
    return document === undefined ? undefined : { document, ...withText }
  },
}

// ---------------------------------------------------------------------------
// Rich text: `client/admin/editor.ts` mounts the editor and keeps the hidden JSON up to date.

/** The toolbar's labels, by command: one per feature, and one per heading level (`heading2`, …). */
function toolbarLabels(headings: readonly number[]): Record<string, string> {
  return {
    ...Object.fromEntries(headings.map((level) => [`heading${level}`, t('admin.richtext.heading', { level })])),
    bold: t('admin.richtext.bold'),
    italic: t('admin.richtext.italic'),
    link: t('admin.richtext.link'),
    bulletList: t('admin.richtext.bulletList'),
    orderedList: t('admin.richtext.orderedList'),
    blockquote: t('admin.richtext.blockquote'),
    image: t('admin.richtext.image'),
    hardBreak: t('admin.richtext.hardBreak'),
  }
}

/**
 * Formatted text. Without JavaScript only the stored JSON is kept. Parse: the stored form of a valid doc; text
 * that isn't JSON, or JSON that isn't a doc the field allows, as it is, so validation reports it; a blank doc on
 * an optional field → absent, unless a hidden `<name>._present` marks a stored value, which keeps it.
 */
export const richTextWidget: AdminWidget = {
  fieldset: true,
  render(p) {
    const opts = p.meta.richText ?? DEFAULT_RICH_TEXT
    const features = RICH_TEXT_FEATURES.filter((feature) => opts.features.includes(feature))
    const value = p.value === undefined ? '' : typeof p.value === 'string' ? p.value : JSON.stringify(p.value)
    const links = `/admin/pick/documents?${new URLSearchParams({ locale: p.locale, web: '1' }).toString()}`
    return (
      <>
        {p.value !== undefined && <input type="hidden" name={`${p.name}._present`} value="" disabled={p.readOnly} />}
        <div
          data-richtext
          data-name={p.name}
          data-features={features.join(' ')}
          data-headings={opts.headings.join(' ')}
          data-labels={JSON.stringify(toolbarLabels(opts.headings))}
          data-readonly={p.readOnly}
          data-pick-link={links}
          data-pick-image="/admin/pick/media?kind=image"
          class="flex flex-col rounded-box border border-base-300 bg-base-100"
        >
          <div role="toolbar" aria-label={t('admin.richtext.toolbar', { field: p.meta.label })} aria-controls={p.id} class="flex flex-wrap gap-1 border-b border-base-300 p-1 empty:hidden"></div>
          <div
            data-richtext-mount
            role="group"
            id={p.id}
            aria-label={p.meta.label}
            aria-describedby={p.describedBy}
            aria-invalid={p.invalid ? 'true' : undefined}
            class="min-h-40 [&_.ProseMirror]:min-h-40 [&_.ProseMirror]:p-3 [&_.ProseMirror]:outline-none [&_.ProseMirror-focused]:ring-2 [&_.ProseMirror-focused]:ring-primary [&_p]:my-2 [&_h2]:my-3 [&_h2]:text-2xl [&_h2]:font-bold [&_h3]:my-3 [&_h3]:text-xl [&_h3]:font-bold [&_h4]:my-2 [&_h4]:text-lg [&_h4]:font-semibold [&_h5]:font-semibold [&_h6]:font-semibold [&_h1]:text-3xl [&_h1]:font-bold [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_blockquote]:border-l-4 [&_blockquote]:border-base-300 [&_blockquote]:pl-4 [&_a]:text-primary [&_a]:underline [&_img]:inline-block [&_img]:max-h-40 [&_img]:rounded [&_.ProseMirror-selectednode]:outline-2 [&_.ProseMirror-selectednode]:outline-primary"
          ></div>
          <p data-richtext-error hidden class="mx-3 mb-3 rounded-box bg-warning px-3 py-1 text-sm text-warning-content">
            {t('admin.richtext.unreadable')}
          </p>
          <input type="hidden" name={p.name} value={value} disabled={p.readOnly} />
          <noscript>
            <p class="mx-3 mb-3 rounded-box bg-warning px-3 py-1 text-sm text-warning-content">{t('admin.form.needsJs')}</p>
          </noscript>
        </div>
      </>
    )
  },
  parse(form, name, meta, optional) {
    const raw = form.get(name)
    if (raw === undefined || raw === '') return undefined
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      return raw
    }
    const parsed = parseRichText(value, meta.richText ?? DEFAULT_RICH_TEXT)
    if (!parsed.ok) return value
    const stored = form.get(`${name}._present`) !== undefined
    return optional && !stored && richTextIsBlank(parsed.doc) ? undefined : parsed.doc
  },
}
