import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ZodType } from 'zod'
import { extractArchive } from '../archive.js'
import { InlayError } from '../errors.js'
import { t } from '../messages/index.js'
import { paramNames } from '../redirects/collapse.js'
import { cleanPath, redirectFrom } from '../redirects/redirects.js'
import { externalTarget } from '../redirects/rule.js'
import type { Registry } from '../registry/registry.js'
import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  contentRecordSchema,
  manifestSchema,
  mediaIndexSchema,
  redirectsSchema,
  type DocumentRecord,
  type Manifest,
  type MediaDeletionRecord,
  type MediaRecord,
  type PublishEventRecord,
  type RedirectRecord,
  type RevisionRecord,
} from './format.js'

export interface ExportBundle {
  dir: string
  manifest: Manifest
  documents: DocumentRecord[]
  revisions: RevisionRecord[]
  publishEvents: PublishEventRecord[]
  redirects: RedirectRecord[]
  media: MediaRecord[]
  deletions: MediaDeletionRecord[]
  /** A `files` entry whose file is missing or whose sha256 isn't its id; not in `media`. */
  damaged: MediaRecord[]
  /** Removes `dir`. */
  close(): Promise<void>
}

const FIXED = ['manifest.json', 'content.ndjson', 'redirects.json', 'media.json']
const MEDIA_ID = /^[0-9a-f]{64}$/
const allowed = (path: string): boolean => FIXED.includes(path) || /^media\/[0-9a-f]{64}$/.test(path)

const invalid = (detail: string) => new InlayError('validation', 'error.exportInvalid', { detail })
const damaged = (detail: string, lines?: Array<{ line: number; message: string }>) =>
  new InlayError('validation', 'error.exportDamaged', { detail }, lines === undefined ? {} : { lines })

export async function readExport(archive: string): Promise<ExportBundle> {
  const dir = await mkdtemp(join(tmpdir(), 'inlay-import-'))
  try {
    const got = new Set(await extractArchive(archive, dir, allowed))
    const manifest = await readManifest(dir, got)
    const { documents, revisions, publishEvents } = await readContent(dir, got, manifest)
    const redirects = await readJson(dir, got, 'redirects.json', redirectsSchema)
    const index = await readJson(dir, got, 'media.json', mediaIndexSchema)
    checkRedirects(redirects, documents, manifest)
    checkMediaIndex(index.files)

    const media: MediaRecord[] = []
    const bad: MediaRecord[] = []
    for (const row of index.files) {
      const ok = MEDIA_ID.test(row.id) && got.has(`media/${row.id}`) && (await hashFile(join(dir, 'media', row.id))) === row.id
      if (ok) media.push(row)
      else bad.push(row)
    }
    return {
      dir,
      manifest,
      documents,
      revisions,
      publishEvents,
      redirects,
      media,
      deletions: index.deletions,
      damaged: bad,
      close: () => rm(dir, { recursive: true, force: true }),
    }
  } catch (e) {
    await rm(dir, { recursive: true, force: true })
    throw e
  }
}

async function readText(dir: string, got: Set<string>, name: string): Promise<string> {
  if (!got.has(name)) throw invalid(name)
  return readFile(join(dir, name), 'utf8')
}

async function readJson<T>(dir: string, got: Set<string>, name: string, schema: ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = JSON.parse(await readText(dir, got, name))
  } catch (e) {
    if (e instanceof InlayError) throw e
    throw invalid(name)
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw invalid(name)
  return parsed.data
}

async function readManifest(dir: string, got: Set<string>): Promise<Manifest> {
  let raw: unknown
  try {
    raw = JSON.parse(await readText(dir, got, 'manifest.json'))
  } catch (e) {
    if (e instanceof InlayError) throw e
    throw invalid('manifest.json')
  }
  if (typeof raw !== 'object' || raw === null || (raw as { format?: unknown }).format !== EXPORT_FORMAT) {
    throw invalid('manifest.json')
  }
  const version = (raw as { formatVersion?: unknown }).formatVersion
  if (typeof version === 'number' && Number.isInteger(version) && version > EXPORT_FORMAT_VERSION) {
    throw new InlayError('validation', 'error.exportNewer', { version })
  }
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) throw invalid('manifest.json')
  return parsed.data as Manifest
}

/** The document kind each type kind holds. */
const KIND_OF_TYPE = { singleton: 'singleton', collection: 'entry', global: 'global' } as const

async function readContent(dir: string, got: Set<string>, manifest: Manifest) {
  const text = await readText(dir, got, 'content.ndjson')
  const documents: Array<{ line: number; rec: DocumentRecord }> = []
  const revisions: Array<{ line: number; rec: RevisionRecord }> = []
  const events: Array<{ line: number; rec: PublishEventRecord }> = []
  const fail = (line: number, message: string): never => {
    throw damaged(t('export.line', { line, message }), [{ line, message }])
  }

  text.split('\n').forEach((raw, i) => {
    const line = i + 1
    if (raw.trim() === '') return
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      fail(line, t('export.badJson'))
    }
    const parsed = contentRecordSchema.safeParse(json)
    if (!parsed.success) fail(line, t('export.badRecord'))
    else if (parsed.data.record === 'document') documents.push({ line, rec: parsed.data as DocumentRecord })
    else if (parsed.data.record === 'revision') revisions.push({ line, rec: parsed.data as RevisionRecord })
    else events.push({ line, rec: parsed.data as PublishEventRecord })
  })

  const typeKind = new Map(manifest.types.map((type) => [type.name, KIND_OF_TYPE[type.kind]]))
  const docById = new Map<string, DocumentRecord>()
  const translations = new Set<string>()
  for (const { line, rec } of documents) {
    if (docById.has(rec.id)) fail(line, t('export.duplicate', { id: rec.id }))
    docById.set(rec.id, rec)
    const translation = JSON.stringify([rec.groupId, rec.locale])
    if (translations.has(translation)) fail(line, t('export.duplicateTranslation', { id: rec.groupId, locale: rec.locale }))
    translations.add(translation)
    const kind = typeKind.get(rec.type)
    if (kind !== undefined && kind !== rec.kind) fail(line, t('export.wrongKind', { type: rec.type }))
  }
  const revById = new Map<number, RevisionRecord>()
  for (const { line, rec } of revisions) {
    if (revById.has(rec.id)) fail(line, t('export.duplicate', { id: rec.id }))
    if (!docById.has(rec.documentId)) fail(line, t('export.unknownDocument', { id: rec.documentId }))
    revById.set(rec.id, rec)
  }
  for (const { line, rec } of documents) {
    for (const id of [rec.headRevision, rec.publishedRevision]) {
      if (id !== null && revById.get(id)?.documentId !== rec.id) fail(line, t('export.foreignRevision', { id }))
    }
  }
  const eventIds = new Set<number>()
  for (const { line, rec } of events) {
    if (eventIds.has(rec.id)) fail(line, t('export.duplicate', { id: rec.id }))
    eventIds.add(rec.id)
    for (const item of rec.items) {
      if (!docById.has(item.documentId)) fail(line, t('export.unknownDocument', { id: item.documentId }))
      if (item.revisionId !== null && revById.get(item.revisionId)?.documentId !== item.documentId) {
        fail(line, t('export.foreignRevision', { id: item.revisionId }))
      }
    }
  }
  return {
    documents: documents.map((d) => d.rec),
    revisions: revisions.map((r) => r.rec),
    publishEvents: events.map((e) => e.rec),
  }
}

const PARAM_SEGMENT = /^:[A-Za-z_][A-Za-z0-9_]*$/
const ENCODED_SEPARATOR = /%(2f|5c)/i

/**
 * The stored (decoded) form of a path, checked the way creating it would. Each segment is encoded first, since a
 * stored `/100%-off` is not itself a valid URL, then the result must come back unchanged. Params stay as they are.
 * A literal `%2F` or `%5C` is refused outright: it is only ever a disguised separator.
 */
function storedPath(path: string, check: (encoded: string) => string | null): string | null {
  if (ENCODED_SEPARATOR.test(path)) return null
  const encoded = path.split('/').map((s) => (PARAM_SEGMENT.test(s) ? s : encodeURIComponent(s))).join('/')
  return check(encoded)
}

/** Checks each redirect the way creating it would, against the exporting site's default language. */
function checkRedirects(redirects: RedirectRecord[], documents: DocumentRecord[], manifest: Manifest): void {
  const groups = new Set(documents.map((d) => d.groupId))
  // redirectFrom only needs the default language, which the manifest has.
  const site = { defaultLocale: manifest.defaultLocale } as Registry
  const ids = new Set<number>()
  const froms = new Set<string>()
  redirects.forEach((r, i) => {
    const fail = (message: string): never => {
      throw damaged(t('export.entry', { file: 'redirects.json', entry: i + 1, message }))
    }
    if (ids.has(r.id)) fail(t('export.duplicate', { id: r.id }))
    ids.add(r.id)
    if (storedPath(r.from, (p) => redirectFrom(site, p)) !== r.from) fail(t('export.redirectFrom', { path: r.from }))
    if (froms.has(r.from)) fail(t('export.duplicateFrom', { path: r.from }))
    froms.add(r.from)
    if ('group' in r.to) {
      if (!groups.has(r.to.group)) fail(t('export.unknownGroup', { id: r.to.group }))
      return
    }
    if ('url' in r.to) {
      if (externalTarget(r.to.url) !== r.to.url || (paramNames(r.from).length > 0 && paramNames(r.to.url).length > 0)) {
        fail(t('export.redirectTo', { path: r.to.url }))
      }
      return
    }
    const to = r.to.path
    const params = paramNames(r.from)
    if (storedPath(to, cleanPath) !== to || to.split('/')[1] === manifest.defaultLocale || paramNames(to).some((n) => !params.includes(n))) {
      fail(t('export.redirectTo', { path: to }))
    }
  })
}

function checkMediaIndex(files: MediaRecord[]): void {
  const ids = new Set<string>()
  files.forEach((m, i) => {
    if (ids.has(m.id)) {
      const message = t('export.duplicate', { id: m.id })
      throw damaged(t('export.entry', { file: 'media.json', entry: i + 1, message }))
    }
    ids.add(m.id)
  })
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
