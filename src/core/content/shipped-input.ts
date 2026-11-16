import { readFile } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { z } from 'zod'
import { InlayError } from '../errors.js'
import type { ShippedDocumentRef } from '../registry/content.js'
import type { FieldMeta } from '../fields/define.js'
import { fieldValues } from '../fields/walk.js'
import { isRecord } from '../fields/zod-internals.js'
import type { MessageId } from '../messages/index.js'
import { inspectUpload } from '../media/library.js'
import { markdownToRichText } from '../richtext/markdown.js'
import type { RichTextOptions } from '../richtext/schema.js'
import type { Registry } from '../registry/registry.js'
import type { ContentInput, ContentIssue, CoreDeps, IssueCode, PathSegment } from '../types.js'
import { docLabels } from './schema.js'
import { contentIssue } from './validate.js'

/** A file named in shipped content, read and checked, waiting to be imported. */
export interface PendingFile {
  bytes: Uint8Array
  id: string
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
}

/** The group id of a shipped document, or null when the key isn't shipped. */
export type KeyResolver = (ref: ShippedDocumentRef) => string | null

const KINDS: ReadonlySet<string> = new Set(['image', 'file', 'richText', 'ref', 'link'])

/** The start of a Markdown link target `](inlay:key/<type>` or `](inlay:key/<type>/<key>`; text elsewhere is left alone. */
const KEY_HREF = /\]\(inlay:key\/([\w-]+)(?:\/([\w-]+))?(?=[\s)])/g

/** `root` with the value at `path` replaced, copying only the containers along the path. */
function setAt(root: unknown, path: PathSegment[], value: unknown): unknown {
  const [head, ...rest] = path
  if (head === undefined) return value
  if (Array.isArray(root)) {
    const copy = [...root] as unknown[]
    copy[head as number] = setAt(copy[head as number], rest, value)
    return copy
  }
  const record = isRecord(root) ? root : {}
  return { ...record, [head]: setAt(record[head], rest, value) }
}

/** The source a `file` value is written as: a URL's href, or the string itself. */
function fileSource(file: unknown): string | null {
  if (file instanceof URL) return file.href
  return typeof file === 'string' ? file : null
}

/**
 * The absolute path a `file` value names, or null if it isn't an absolute path or a file: URL. A source in
 * `shipped` (a loaded release's copies of its files) is read from where the release put it.
 */
function localPath(file: unknown, shipped?: ReadonlyMap<string, string>): string | null {
  const source = fileSource(file)
  const mapped = source === null ? undefined : shipped?.get(source)
  if (mapped !== undefined) return mapped
  try {
    if (file instanceof URL) return file.protocol === 'file:' ? fileURLToPath(file) : null
    if (typeof file !== 'string') return null
    if (file.startsWith('file:')) return fileURLToPath(file)
    return isAbsolute(file) ? file : null
  } catch {
    return null
  }
}

/** Shipped content can't contain images in rich text: there is no way to name their files. */
function withoutImages(opts: RichTextOptions | undefined): Partial<RichTextOptions> | undefined {
  return opts && { ...opts, features: opts.features.filter((f) => f !== 'image') }
}

/**
 * Turns shipped content as a developer writes it into the stored shape:
 * Markdown strings in rich text fields become rich text, and `{ file, alt? }`
 * in image and file fields is read from disk, checked like an upload, and
 * replaced by `{ media, alt? }`. References to other shipped documents by key
 * become their group ids: `{ key }` in `ref` fields, `{ document: { type, key? } }`
 * in `link` fields and `inlay:key/<type>[/<key>]` links in Markdown. Covers the
 * template fields and every slot that isn't switched off. Returns the files to
 * import and any problems.
 */
export async function resolveShippedInput(
  deps: CoreDeps,
  type: string,
  input: ContentInput,
  resolveKey: KeyResolver,
): Promise<{ input: ContentInput; files: Map<string, PendingFile>; issues: ContentIssue[] }> {
  const { template } = deps.registry.getType(type)
  const files = new Map<string, PendingFile>()
  const issues: ContentIssue[] = []

  const issue = (path: PathSegment[], code: IssueCode, messageId: MessageId, params: Record<string, string> = {}) => {
    issues.push(contentIssue(path, docLabels(deps.registry, type, path) ?? path.map(String), code, messageId, params))
  }

  /** The group id `ref` names, or null after reporting it at `path`. */
  const groupOf = (path: PathSegment[], ref: ShippedDocumentRef): string | null => {
    const id = resolveKey(ref)
    if (id === null) issue(path, 'not_found', 'issue.shippedKeyUnknown', { type: ref.type, key: ref.key ?? ref.type })
    return id
  }

  /** A `ref` field's `{ key }`, as a group id; anything else is left as it is. */
  const refValue = (path: PathSegment[], target: string, value: unknown): unknown => {
    if (!isRecord(value) || typeof value.key !== 'string') return value
    return groupOf(path, { type: target, key: value.key }) ?? value
  }

  /** The stored value for one found value, or `undefined` to leave it as it is. */
  const resolve = async (path: PathSegment[], meta: FieldMeta, value: unknown): Promise<unknown> => {
    if (meta.kind === 'ref') {
      const target = meta.target ?? ''
      if (Array.isArray(value)) return value.map((item, i) => refValue([...path, i], target, item))
      return refValue(path, target, value)
    }
    if (meta.kind === 'link') {
      if (!isRecord(value) || !isRecord(value.document) || typeof value.document.type !== 'string') return undefined
      const ref: ShippedDocumentRef = { type: value.document.type }
      if (typeof value.document.key === 'string') ref.key = value.document.key
      const id = groupOf(path, ref)
      return id === null ? undefined : { ...value, document: id }
    }
    if (meta.kind === 'richText') {
      if (typeof value !== 'string') return undefined
      let unknownKey = false
      const markdown = value.replace(KEY_HREF, (href, refType: string, key: string | undefined) => {
        const id = groupOf(path, key === undefined ? { type: refType } : { type: refType, key })
        if (id === null) unknownKey = true
        return id === null ? href : `](inlay:document/${id}`
      })
      if (unknownKey) return undefined
      const result = markdownToRichText(markdown, meta.richText)
      for (const problem of result.ok ? [] : result.problems) {
        issue(path, 'invalid', 'issue.richText', { problem: problem.message })
      }
      // What only the image-free reading finds are images the field allows but shipped content can't name.
      const bare = markdownToRichText(markdown, withoutImages(meta.richText))
      const known = new Set(result.ok ? [] : result.problems.map((p) => p.message))
      const images = bare.ok ? [] : bare.problems.filter((p) => !known.has(p.message))
      for (const image of images) issue(path, 'invalid', 'issue.shippedRichTextImage', { line: String(image.line) })
      return result.ok && images.length === 0 ? result.doc : undefined
    }
    if (!isRecord(value) || !Object.hasOwn(value, 'file')) return undefined
    const source = fileSource(value.file)
    if (deps.shippedFiles && (source === null || !deps.shippedFiles.has(source))) {
      issue(path, 'not_found', 'issue.shippedFileUnknown', { path: String(source ?? value.file) })
      return undefined
    }
    const file = localPath(value.file, deps.shippedFiles)
    if (file === null) {
      issue(path, 'invalid', 'issue.shippedFilePath', { path: String(value.file) })
      return undefined
    }
    let bytes: Uint8Array
    try {
      bytes = await readFile(file)
    } catch {
      issue(path, 'not_found', 'issue.shippedFileMissing', { path: file })
      return undefined
    }
    try {
      const info = await inspectUpload(deps, bytes, basename(file))
      files.set(info.id, { bytes, ...info })
      return meta.kind === 'image' && value.alt !== undefined ? { media: info.id, alt: value.alt } : { media: info.id }
    } catch (e) {
      if (!(e instanceof InlayError) || e.code !== 'validation') throw e
      issue(path, 'invalid', 'issue.shippedFileInvalid', { problem: e.message })
      return undefined
    }
  }

  const resolveAll = async (schema: z.ZodType, value: unknown, prefix: PathSegment[]): Promise<unknown> => {
    let out = value
    for (const found of fieldValues(schema, value, KINDS)) {
      const next = await resolve([...prefix, ...found.path], found.meta, found.value)
      if (next !== undefined) out = setAt(out, found.path, next)
    }
    return out
  }

  const out: ContentInput = { ...input }
  if (input.fields !== undefined) {
    out.fields = (await resolveAll(template.fields, input.fields, ['fields'])) as Record<string, unknown>
  }
  if (input.slots !== undefined) {
    const slots: NonNullable<ContentInput['slots']> = {}
    for (const [key, given] of Object.entries(input.slots)) {
      const slot = template.slots[key]
      slots[key] =
        given === false || !slot
          ? given
          : ((await resolveAll(slot.block.schema, given, ['slots', key, 'data'])) as Record<string, unknown>)
    }
    out.slots = slots
  }
  return { input: out, files, issues }
}

const FILE_KINDS: ReadonlySet<string> = new Set(['image', 'file'])

/**
 * Every `{ file }` named in the registry's shipped content (template fields and slots), once per source: the
 * source as written (a file: URL's href or an absolute path) and the local path it names. Values that don't name
 * a local file are left out; applying the content reports them.
 */
export function shippedFiles(registry: Registry): Array<{ source: string; path: string }> {
  const found = new Map<string, string>()
  const collect = (schema: z.ZodType, value: unknown) => {
    for (const { value: v } of fieldValues(schema, value, FILE_KINDS)) {
      if (!isRecord(v) || !Object.hasOwn(v, 'file')) continue
      const source = fileSource(v.file)
      const path = localPath(v.file)
      if (source !== null && path !== null) found.set(source, path)
    }
  }
  for (const [type, documents] of registry.content) {
    const { template } = registry.getType(type)
    for (const doc of documents) {
      for (const input of Object.values(doc.content)) {
        if (input.fields !== undefined) collect(template.fields, input.fields)
        for (const [key, given] of Object.entries(input.slots ?? {})) {
          const slot = template.slots[key]
          if (given !== false && slot) collect(slot.block.schema, given)
        }
      }
    }
  }
  return [...found].map(([source, path]) => ({ source, path }))
}
