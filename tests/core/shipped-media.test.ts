import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { createCore } from '../../src/core/core.js'
import { openDatabase } from '../../src/core/db/connection.js'
import { migrateSystem } from '../../src/core/db/migrate.js'
import { InlayError } from '../../src/core/errors.js'
import { t } from '../../src/core/messages/index.js'
import { f } from '../../src/core/fields/builtins.js'
import { realInside, realInsideSync } from '../../src/core/content/shipped-images.js'
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

function teamSite(
  fields: Record<string, unknown>,
  opts: { edition?: number; template?: TemplateDef; siteDir?: string } = {},
): SiteDefinition {
  const site = defineSite({
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
  return opts.siteDir === undefined ? site : { ...site, siteDir: opts.siteDir }
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
    const { core } = await makeCore({ site: teamSite({ photo: { file: photoPath }, intro: '---' }), media: true })
    const e = await rejection(core.applyShippedContent())
    expect(e.code).toBe('shipped_content')
    const issues = e.details.issues as Array<{ labels: string[]; message: string }>
    expect(issues[0]!.labels).toEqual(['Intro'])
    expect(issues[0]!.message).toContain('Line 1')
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

const IntroPage = defineTemplate({
  name: 'teamPage',
  label: 'Team page',
  fields: z.object({ title: f.text({ label: 'Title' }), intro: f.richText({ label: 'Intro' }) }),
})

type Doc = { content: Array<{ type: string; content?: Array<{ type: string; attrs?: Record<string, unknown> }> }> }

/** The image nodes in a stored rich-text doc, in order. */
function imagesOf(doc: Doc): Array<Record<string, unknown> | undefined> {
  return doc.content.flatMap((block) => (block.content ?? []).filter((n) => n.type === 'image').map((n) => n.attrs))
}

describe('images in shipped rich text', () => {
  let root: string
  let dir: string
  let siteDir: string
  let bytes: Buffer

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'inlay-shipped-images-'))
    dir = join(root, 'site')
    await mkdir(join(dir, 'images'), { recursive: true })
    siteDir = pathToFileURL(dir).href + '/'
    bytes = await png(30, 10)
    await writeFile(join(dir, 'images', 'team.png'), bytes)
  })

  afterEach(() => rm(root, { recursive: true, force: true }))

  const site = (intro: string, template: TemplateDef = IntroPage) => teamSite({ intro }, { template, siteDir })

  async function introOf(core: Awaited<ReturnType<typeof makeCore>>['core'], name = 'team'): Promise<Doc> {
    const found = await core.findSingleton(name, 'en')
    const doc = await core.getDocument(found!.id, { state: 'published' })
    return doc!.data.fields.intro as Doc
  }

  it('imports an image named by a relative path, with its alt', async () => {
    const { core, db } = await makeCore({ site: site('Hello\n\n![Team photo](images/team.png)'), media: true })
    await core.applyShippedContent()
    expect(imagesOf(await introOf(core))).toEqual([{ media: sha256(bytes), alt: 'Team photo' }])
    expect(await mediaCount(db)).toBe(1)
    expect(await core.getMedia(sha256(bytes))).toMatchObject({ filename: 'team.png', mime: 'image/png', width: 30, height: 10 })
  })

  it('takes ./ paths and file: URLs to the same image', async () => {
    const url = pathToFileURL(join(dir, 'images', 'team.png')).href
    const intro = `![a](images/team.png)\n\n![b](./images/team.png)\n\n![c](${url})`
    const { core, db } = await makeCore({ site: site(intro), media: true })
    await core.applyShippedContent()
    const id = sha256(bytes)
    expect(imagesOf(await introOf(core))).toEqual([
      { media: id, alt: 'a' },
      { media: id, alt: 'b' },
      { media: id, alt: 'c' },
    ])
    expect(await mediaCount(db)).toBe(1)
  })

  it('two documents sharing an image add one media row', async () => {
    const base = site('![Team](images/team.png)')
    const two: SiteDefinition = {
      ...base,
      singletons: [...base.singletons, defineSingleton({ name: 'crew', label: 'Crew', template: IntroPage, path: '/crew' })],
      content: [
        ...(base.content ?? []),
        defineContent('crew', { edition: 1, content: { en: { fields: { title: 'Crew', intro: '![Us](./images/team.png)' } } } }),
      ],
    }
    const { core, db } = await makeCore({ site: two, media: true })
    await core.applyShippedContent()
    expect(imagesOf(await introOf(core))).toEqual([{ media: sha256(bytes), alt: 'Team' }])
    expect(imagesOf(await introOf(core, 'crew'))).toEqual([{ media: sha256(bytes), alt: 'Us' }])
    expect(await mediaCount(db)).toBe(1)
  })

  it('finds a path with spaces and parentheses', async () => {
    const chart = await png(12, 12, '#cc3366')
    await writeFile(join(dir, 'images', 'my chart (1).png'), chart)
    const { core } = await makeCore({ site: site('![a](<images/my chart (1).png>)'), media: true })
    await core.applyShippedContent()
    expect(imagesOf(await introOf(core))).toEqual([{ media: sha256(chart), alt: 'a' }])
  })

  it('refuses images it may not read, each with its issue', async () => {
    await writeFile(join(root, 'outside.png'), await png(5, 5))
    await symlink(join(root, 'outside.png'), join(dir, 'images', 'link.png'))
    await writeFile(join(dir, 'images', 'doc.pdf'), pdf())
    const NoImages = defineTemplate({
      name: 'teamPage',
      label: 'Team page',
      fields: z.object({ title: f.text({ label: 'Title' }), intro: f.richText({ label: 'Intro', features: ['bold'] }) }),
    })
    const cases: Array<[string, string, TemplateDef?]> = [
      ['../outside.png', t('issue.shippedImageOutside', { field: 'Intro', line: 1, src: '../outside.png' })],
      ['images/link.png', t('issue.shippedImageOutside', { field: 'Intro', line: 1, src: 'images/link.png' })],
      ['https://example.com/x.png', t('issue.shippedImageRemote', { field: 'Intro', line: 1, src: 'https://example.com/x.png' })],
      ['/x.png', t('issue.shippedImageRooted', { field: 'Intro', line: 1, src: '/x.png' })],
      ['images/missing.png', t('issue.shippedImageMissing', { field: 'Intro', line: 1, src: 'images/missing.png' })],
      ['images/doc.pdf', t('issue.shippedImageNotImage', { field: 'Intro', line: 1, src: 'images/doc.pdf' })],
      [
        'images/team.png',
        t('issue.richText', {
          field: 'Intro',
          problem: t('richtext.notAllowed', { line: 1, feature: t('richtext.feature.image') }),
        }),
        NoImages,
      ],
    ]
    for (const [src, message, template] of cases) {
      const { core, db } = await makeCore({ site: site(`![x](${src})`, template), media: true })
      const e = await rejection(core.applyShippedContent())
      expect(e.code, src).toBe('shipped_content')
      const issues = e.details.issues as Array<{ labels: string[]; message: string }>
      expect(issues, src).toHaveLength(1)
      expect(issues[0]!.labels).toEqual(['Intro'])
      expect(issues[0]!.message, src).toBe(message)
      expect(await mediaCount(db)).toBe(0)
    }
  })

  it('with a release\'s files, names an image the release lacks without reading it', async () => {
    const url = pathToFileURL(join(dir, 'images', 'team.png')).href
    const copy = join(root, 'release-copy.png')
    const copied = await png(8, 8, '#00aa00')
    await writeFile(copy, copied)
    const db = openDatabase(':memory:')
    const media = await mkdtemp(join(tmpdir(), 'inlay-shipped-images-store-'))
    try {
      await migrateSystem(db)
      const lacking = createCore({ site: site('![x](images/team.png)'), db, media, shippedFiles: new Map([['file:///elsewhere.png', copy]]) })
      const e = await rejection(lacking.applyShippedContent())
      expect((e.details.issues as Array<{ message: string }>).map((i) => i.message)).toEqual([
        t('issue.shippedImageUnknown', { field: 'Intro', line: 1, src: 'images/team.png' }),
      ])
      expect(await mediaCount(db)).toBe(0)

      const having = createCore({ site: site('![x](images/team.png)'), db, media, shippedFiles: new Map([[url, copy]]) })
      await having.applyShippedContent()
      const found = await having.findSingleton('team', 'en')
      const doc = await having.getDocument(found!.id)
      expect(imagesOf(doc!.data.fields.intro as Doc)).toEqual([{ media: sha256(copied), alt: 'x' }])
    } finally {
      await db.destroy()
      await rm(media, { recursive: true, force: true })
    }
  })
})

describe('realInside', () => {
  let root: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'inlay-real-inside-')))
    await mkdir(join(root, 'site', 'images'), { recursive: true })
    await writeFile(join(root, 'site', 'images', 'team.png'), await png(4, 4))
    await writeFile(join(root, 'outside.png'), await png(4, 4))
    await symlink(join(root, 'site', 'images', 'team.png'), join(root, 'site', 'inside.png'))
    await symlink(join(root, 'outside.png'), join(root, 'site', 'outside.png'))
  })

  afterEach(() => rm(root, { recursive: true, force: true }))

  it('gives the real path of a link inside the folder, and null for one leading out or missing', async () => {
    const siteDir = pathToFileURL(join(root, 'site')).href + '/'
    const real = join(root, 'site', 'images', 'team.png')
    expect(await realInside(join(root, 'site', 'inside.png'), siteDir)).toBe(real)
    expect(realInsideSync(join(root, 'site', 'inside.png'), siteDir)).toBe(real)
    expect(await realInside(join(root, 'site', 'outside.png'), siteDir)).toBeNull()
    expect(realInsideSync(join(root, 'site', 'outside.png'), siteDir)).toBeNull()
    expect(await realInside(join(root, 'site', 'missing.png'), siteDir)).toBeNull()
    expect(realInsideSync(join(root, 'site', 'missing.png'), siteDir)).toBeNull()
  })
})
