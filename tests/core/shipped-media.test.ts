import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { createCore } from '../../src/core/core.js'
import { openDatabase } from '../../src/core/db/connection.js'
import { migrateSystem } from '../../src/core/db/migrate.js'
import { InlayError } from '../../src/core/errors.js'
import { f } from '../../src/core/fields/builtins.js'
import { defineContent } from '../../src/core/registry/content.js'
import { defineSingleton, defineSite, defineTemplate, type SiteDefinition, type TemplateDef } from '../../src/core/registry/define.js'
import { articleSite } from '../fixtures/articles.js'
import { pdf, png, sha256 } from '../fixtures/media.js'
import { makeCore } from '../helpers/core.js'

const TeamPage = defineTemplate({
  name: 'teamPage',
  label: 'Team page',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    photo: f.image({ label: 'Photo' }),
    intro: f.richText({ label: 'Intro' }),
  }),
})

function teamSite(fields: Record<string, unknown>, opts: { edition?: number; template?: TemplateDef } = {}): SiteDefinition {
  return defineSite({
    ...articleSite,
    singletons: [
      ...articleSite.singletons,
      defineSingleton({ name: 'team', label: 'Team', template: opts.template ?? TeamPage, path: '/team' }),
    ],
    content: [
      defineContent('team', {
        edition: opts.edition ?? 1,
        content: { en: { fields: { title: 'Team', intro: '## Hello\n\nWe **build** sites.', ...fields } } },
      }),
    ],
  })
}

async function rejection(p: Promise<unknown>): Promise<InlayError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(InlayError)
    return e as InlayError
  }
  throw new Error('expected a rejection')
}

async function mediaCount(db: Awaited<ReturnType<typeof makeCore>>['db']): Promise<number> {
  return Number((await db.selectFrom('media').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)
}

async function revisionCount(db: Awaited<ReturnType<typeof makeCore>>['db']): Promise<number> {
  return Number((await db.selectFrom('revisions').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)
}

describe('shipped content with media and rich text', () => {
  let dir: string
  let photoPath: string
  let bytes: Buffer

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inlay-shipped-media-'))
    photoPath = join(dir, 'team.png')
    bytes = await png(40, 20)
    await writeFile(photoPath, bytes)
  })

  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('imports the image and converts the Markdown', async () => {
    const { core, mediaDir } = await makeCore({ site: teamSite({ photo: { file: photoPath, alt: 'Our team' } }), media: true })
    await core.applyShippedContent()
    const team = await core.findSingleton('team', 'en')
    const doc = await core.getDocument(team!.id, { state: 'published' })
    const fields = doc!.data.fields as { photo: { media: string; alt?: string }; intro: { content: Array<{ type: string; attrs?: { level: number } }> } }
    expect(fields.photo).toEqual({ media: sha256(bytes), alt: 'Our team' })
    const media = await core.getMedia(sha256(bytes))
    expect(media).toMatchObject({ filename: 'team.png', createdBy: 'System', mime: 'image/png', width: 40, height: 20 })
    expect(existsSync(join(mediaDir!, sha256(bytes)))).toBe(true)
    expect(fields.intro.content[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } })
  })

  it('adds nothing when run again', async () => {
    const { core, db } = await makeCore({ site: teamSite({ photo: { file: photoPath, alt: 'Our team' } }), media: true })
    await core.applyShippedContent()
    const before = { media: await mediaCount(db), revisions: await revisionCount(db) }
    expect((await core.applyShippedContent()).created).toEqual([])
    expect({ media: await mediaCount(db), revisions: await revisionCount(db) }).toEqual(before)
  })

  it('accepts a file: URL', async () => {
    const { core } = await makeCore({ site: teamSite({ photo: { file: new URL('file://' + photoPath) } }), media: true })
    await core.applyShippedContent()
    const team = await core.findSingleton('team', 'en')
    const doc = await core.getDocument(team!.id)
    expect(doc!.data.fields.photo).toEqual({ media: sha256(bytes) })
  })

  it('reports a missing file with its path', async () => {
    const missing = join(dir, 'nope.png')
    const { core, db } = await makeCore({ site: teamSite({ photo: { file: missing } }), media: true })
    const e = await rejection(core.applyShippedContent())
    expect(e.code).toBe('shipped_content')
    const issues = e.details.issues as Array<{ labels: string[]; message: string }>
    expect(issues).toHaveLength(1)
    expect(issues[0]!.labels).toEqual(['Photo'])
    expect(issues[0]!.message).toContain(missing)
    expect(await revisionCount(db)).toBe(0)
  })

  it('with a release\'s files, reports a source the release does not have instead of reading it', async () => {
    const other = join(dir, 'other.png')
    await writeFile(other, await png(4, 4))
    const db = openDatabase(':memory:')
    const media = await mkdtemp(join(tmpdir(), 'inlay-shipped-media-store-'))
    try {
      await migrateSystem(db)
      const site = teamSite({ photo: { file: other } })
      const core = createCore({ site, db, media, shippedFiles: new Map([[photoPath, photoPath]]) })
      const e = await rejection(core.applyShippedContent())
      expect(e.code).toBe('shipped_content')
      const issues = e.details.issues as Array<{ labels: string[]; message: string }>
      expect(issues).toHaveLength(1)
      expect(issues[0]!.message).toContain(other)
      expect(issues[0]!.message).toContain("isn't part of this release")
      expect(await mediaCount(db)).toBe(0)
    } finally {
      await db.destroy()
      await rm(media, { recursive: true, force: true })
    }
  })

  it('rejects a relative path', async () => {
    const { core } = await makeCore({ site: teamSite({ photo: { file: 'team.png' } }), media: true })
    const e = await rejection(core.applyShippedContent())
    expect(e.code).toBe('shipped_content')
    expect((e.details.issues as Array<{ labels: string[] }>)[0]!.labels).toEqual(['Photo'])
  })

  it('rejects a PDF in an image field', async () => {
    const pdfPath = join(dir, 'team.pdf')
    await writeFile(pdfPath, pdf())
    const { core, db } = await makeCore({ site: teamSite({ photo: { file: pdfPath } }), media: true })
    const e = await rejection(core.applyShippedContent())
    expect(e.code).toBe('shipped_content')
    expect((e.details.issues as Array<{ code: string }>).map((i) => i.code)).toEqual(['wrong_media_type'])
    expect(await mediaCount(db)).toBe(0)
  })

  it('reports Markdown the field cannot hold with its line', async () => {
    const { core } = await makeCore({ site: teamSite({ photo: { file: photoPath }, intro: '```\ncode\n```' }), media: true })
    const e = await rejection(core.applyShippedContent())
    expect(e.code).toBe('shipped_content')
    const issues = e.details.issues as Array<{ labels: string[]; message: string }>
    expect(issues[0]!.labels).toEqual(['Intro'])
    expect(issues[0]!.message).toContain('Line 1')
  })

  it('says shipped content, not the field, cannot hold an image in rich text', async () => {
    const intro = `Hello\n\n![Team](inlay:media/${'a'.repeat(64)})`
    const { core } = await makeCore({ site: teamSite({ photo: { file: photoPath }, intro }), media: true })
    const e = await rejection(core.applyShippedContent())
    expect(e.code).toBe('shipped_content')
    const issues = e.details.issues as Array<{ labels: string[]; message: string }>
    expect(issues).toHaveLength(1)
    expect(issues[0]!.labels).toEqual(['Intro'])
    expect(issues[0]!.message).toMatch(/Line 3: shipped content can't include images/)
    expect(issues[0]!.message).not.toMatch(/this field/)
  })

  it('keeps the field message when the field itself allows no images', async () => {
    const NoImages = defineTemplate({
      name: 'teamPage',
      label: 'Team page',
      fields: z.object({ title: f.text({ label: 'Title' }), intro: f.richText({ label: 'Intro', features: ['bold'] }) }),
    })
    const site = teamSite({ intro: `![Team](inlay:media/${'a'.repeat(64)})` }, { template: NoImages })
    const { core } = await makeCore({ site, media: true })
    const e = await rejection(core.applyShippedContent())
    const issues = e.details.issues as Array<{ message: string }>
    expect(issues).toHaveLength(1)
    expect(issues[0]!.message).toMatch(/this field can't contain images/)
  })

  it('needs a media store to import a file', async () => {
    const { core, db } = await makeCore({ site: teamSite({ photo: { file: photoPath } }) })
    const e = await rejection(core.applyShippedContent())
    expect(e.code).toBe('invalid_operation')
    expect(await revisionCount(db)).toBe(0)
  })

  it('a new edition imports its new image and keeps the old one in the library', async () => {
    const { core, db, mediaDir } = await makeCore({ site: teamSite({ photo: { file: photoPath, alt: 'Us' } }), media: true })
    await core.applyShippedContent()
    const newPath = join(dir, 'team-2.png')
    const newBytes = await png(20, 40, '#cc3366')
    await writeFile(newPath, newBytes)
    const next = createCore({
      site: teamSite({ photo: { file: newPath, alt: 'Us' } }, { edition: 2 }),
      db,
      now: () => new Date('2026-06-01T00:00:00.000Z'),
      media: mediaDir!,
    })
    const report = await next.applyShippedContent()
    expect(report.replaced).toHaveLength(1)
    expect(await mediaCount(db)).toBe(2)
    expect(await next.getMedia(sha256(bytes))).not.toBeNull()
    const team = await next.findSingleton('team', 'en')
    const doc = await next.getDocument(team!.id, { state: 'published' })
    expect(doc!.data.fields.photo).toEqual({ media: sha256(newBytes), alt: 'Us' })
    expect(existsSync(join(mediaDir!, sha256(newBytes)))).toBe(true)
  })

  it('a dry run stores no file and adds no media', async () => {
    const { core, db, mediaDir } = await makeCore({ site: teamSite({ photo: { file: photoPath, alt: 'Us' } }), media: true })
    const report = await core.applyShippedContent({ dryRun: true })
    expect(report.created).toHaveLength(1)
    expect(await mediaCount(db)).toBe(0)
    expect(existsSync(join(mediaDir!, sha256(bytes)))).toBe(false)
    expect(await revisionCount(db)).toBe(0)
  })
})
