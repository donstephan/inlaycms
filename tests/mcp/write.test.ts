import { z } from 'zod'
import type { Core } from '../../src/core/core.js'
import { f } from '../../src/core/fields/builtins.js'
import { t } from '../../src/core/messages/index.js'
import { defineCollection, defineTemplate, type SiteDefinition } from '../../src/core/registry/define.js'
import type { Ctx } from '../../src/core/types.js'
import { Quotes, webSite } from '../fixtures/web.js'
import { makeCore } from '../helpers/core.js'
import { mcpClient, type McpTestClient } from '../helpers/mcp.js'

/** A post with a ref field and an optional slot, so create_entry has both to write. */
const Post = defineTemplate({
  name: 'post',
  label: 'Post',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    date: f.date({ label: 'Date' }),
    body: f.richText({ label: 'Body' }),
    featured: f.ref('testimonials', { label: 'Featured testimonial' }).optional(),
  }),
  slots: { x: { block: Quotes, optional: true } },
  render: ({ fields }) => `<h1>${fields.title}</h1>`,
})

const site: SiteDefinition = {
  ...webSite,
  collections: webSite.collections.map((c) =>
    c.name === 'posts' ? defineCollection({ name: 'posts', label: 'Posts', template: Post, route: '/blog/:slug' }) : c,
  ),
}

let core: Core
let owner: Ctx
let editor: Ctx
let mcp: McpTestClient

beforeEach(async () => {
  ;({ core, owner, editor } = await makeCore({ site }))
  await core.applyShippedContent()
  mcp = await mcpClient({ core, actor: editor.actor })
})

afterEach(async () => {
  await mcp.close()
})

const home = async () => (await core.findSingleton('home'))!

describe('update_document', () => {
  it('saves a draft from MCP and returns the changes and a preview link', async () => {
    const before = await home()
    const { isError, json } = await mcp.call('update_document', {
      id: before.id,
      baseRevisionId: before.headRev,
      changes: [{ path: 'slots.hero.data.headline', value: 'New' }],
    })
    expect(isError).toBe(false)
    expect(json.id).toBe(before.id)
    expect(json.changed).toBe(true)
    expect(json.revisionId).toBeGreaterThan(before.headRev)
    expect(json.changes.some((line: string) => line.includes('Hero → Headline'))).toBe(true)
    expect(json.previewUrl).toMatch(/^https:\/\/example\.com\/_inlay\/preview\?token=/)

    const after = (await core.getDocument(before.id))!
    expect(after.headRev).toBe(json.revisionId)
    expect(after.publishedRev).toBe(before.publishedRev)
    expect(after.data.slots.hero!.data.headline).toBe('New')
    expect(after.revision.source).toBe('mcp')
    expect(after.revision.authorId).toBe(editor.actor.id)
  })

  it('changes nothing when the content get_document returned is sent back', async () => {
    for (const type of ['home', 'about', 'nav']) {
      const read = await mcp.call('get_document', { type })
      expect(read.isError).toBe(false)
      const { content, id, revisionId } = read.json
      const changes = [
        { path: 'fields', value: content.fields },
        ...Object.entries(content.slots).map(([key, slot]) => ({ path: `slots.${key}`, value: slot })),
      ]
      const { isError, text, json } = await mcp.call('update_document', { id, baseRevisionId: revisionId, changes })
      expect(isError, text).toBe(false)
      expect(json).toMatchObject({ changed: false, revisionId, changes: [] })
    }
  })

  it('writes and reads a table as Markdown', async () => {
    const md = '| Plan | Price |\n| --- | --- |\n| **Pro** | [Buy](https://example.com/buy) |\n| *Lite* | free |\n'
    const about = (await core.findSingleton('about'))!
    const { isError, text } = await mcp.call('update_document', {
      id: about.id,
      baseRevisionId: about.headRev,
      changes: [{ path: 'fields.body', value: md }],
    })
    expect(isError, text).toBe(false)
    const stored = (await core.getDocument(about.id))!.data.fields.body as { content: { type: string }[] }
    expect(stored.content[0]).toMatchObject({ type: 'table' })
    const read = await mcp.call('get_document', { type: 'about' })
    expect(read.json.content.fields.body).toBe(md)
  })

  it('rejects Markdown the field does not allow, with line numbers, and saves nothing', async () => {
    const about = (await core.findSingleton('about'))!
    const { isError, text, json } = await mcp.call('update_document', {
      id: about.id,
      baseRevisionId: about.headRev,
      changes: [{ path: 'fields.body', value: 'Intro.\n\n```\ncode\n```\n' }],
    })
    expect(isError).toBe(true)
    expect(json.error.code).toBe('validation')
    expect(text).toMatch(/Line 3/)
    expect(text).toContain('fields.body')
    expect((await core.getDocument(about.id))!.headRev).toBe(about.headRev)
  })

  it('names the valid fields for a misspelt path', async () => {
    const doc = await home()
    const { isError, text, json } = await mcp.call('update_document', {
      id: doc.id,
      baseRevisionId: doc.headRev,
      changes: [{ path: 'slots.hero.data.headlin', value: 'New' }],
    })
    expect(isError).toBe(true)
    expect(json.error.issues[0].path).toBe('slots.hero.data.headlin')
    expect(text).toContain('headline (Headline)')
  })

  it('tells the assistant to read the document again after a conflict', async () => {
    const doc = await home()
    await core.patchDraft(doc.id, { baseRevisionId: doc.headRev, ops: [{ path: ['fields', 'title'], value: 'Mine' }] }, owner)
    const { isError, text, json } = await mcp.call('update_document', {
      id: doc.id,
      baseRevisionId: doc.headRev,
      changes: [{ path: 'fields.title', value: 'Theirs' }],
    })
    expect(isError).toBe(true)
    expect(json.error.code).toBe('conflict')
    expect(text).toContain('get_document')
  })

  it('words a conflict for an assistant, not for someone looking at a screen', async () => {
    const doc = await home()
    await core.patchDraft(doc.id, { baseRevisionId: doc.headRev, ops: [{ path: ['fields', 'title'], value: 'Mine' }] }, owner)
    const { json } = await mcp.call('update_document', {
      id: doc.id,
      baseRevisionId: doc.headRev,
      changes: [{ path: 'fields.title', value: 'Theirs' }],
    })
    expect(json.error.message).toBe(t('mcp.conflict', { title: 'Home' }))
    expect(json.error.message).not.toMatch(/Reload/)
  })

  it('reports the problems of every change at once', async () => {
    const doc = await home()
    const { isError, json } = await mcp.call('update_document', {
      id: doc.id,
      baseRevisionId: doc.headRev,
      changes: [
        { path: 'slots.nope.data.x', value: 1 },
        { path: 'fields.title', value: 5 },
        { path: 'slots.hero.data..x', value: 1 },
        { path: 'slots.hero.data.headline', value: 'Fine' },
      ],
    })
    expect(isError).toBe(true)
    expect(json.error.issues.map((i: { path: string }) => i.path)).toEqual(['', 'slots.nope', 'fields.title'])
    expect((await home()).headRev).toBe(doc.headRev)
  })

  it('removes an optional field, and refuses to remove a required one', async () => {
    const doc = await home()
    const set = await mcp.call('update_document', {
      id: doc.id,
      baseRevisionId: doc.headRev,
      changes: [{ path: 'slots.hero.data.cta', value: { url: 'https://example.org/', text: 'Go' } }],
    })
    expect(set.isError, set.text).toBe(false)
    expect((await core.getDocument(doc.id))!.data.slots.hero!.data.cta).toEqual({ url: 'https://example.org/', text: 'Go' })

    const removed = await mcp.call('update_document', {
      id: doc.id,
      baseRevisionId: set.json.revisionId,
      changes: [{ path: 'slots.hero.data.cta', remove: true }],
    })
    expect(removed.isError, removed.text).toBe(false)
    expect(removed.json.changed).toBe(true)
    expect((await core.getDocument(doc.id))!.data.slots.hero!.data).not.toHaveProperty('cta')

    const required = await mcp.call('update_document', {
      id: doc.id,
      baseRevisionId: removed.json.revisionId,
      changes: [{ path: 'slots.hero.data.headline', remove: true }],
    })
    expect(required.isError).toBe(true)
    expect(required.text.split('\n')[0]).toBe(t('error.validation'))
    expect(required.text).toContain(t('mcp.change.required', { field: 'Hero → Headline' }))
    expect(required.json.error.issues[0]).toMatchObject({ path: 'slots.hero.data.headline' })
    expect((await core.getDocument(doc.id))!.headRev).toBe(removed.json.revisionId)
    expect(required.text).not.toMatch(/\n\s+at /)
  })

  it('needs exactly one of value and remove, and a well-formed path', async () => {
    const doc = await home()
    const { isError, json } = await mcp.call('update_document', {
      id: doc.id,
      baseRevisionId: doc.headRev,
      changes: [
        { path: 'fields.title', value: 'A', remove: true },
        { path: 'fields.title' },
        { path: 'fields..title', value: 'B' },
      ],
    })
    expect(isError).toBe(true)
    expect(json.error.issues).toHaveLength(3)
    expect((await core.getDocument(doc.id))!.headRev).toBe(doc.headRev)
  })

  it("refuses a document id where a reference needs the entry's groupId, naming the right one", async () => {
    const maria = await core.createEntry('testimonials', { fields: { author: 'María', quote: 'Great' } }, owner)
    const doc = await home()
    const { isError, json } = await mcp.call('update_document', {
      id: doc.id,
      baseRevisionId: doc.headRev,
      changes: [{ path: 'slots.quotes', value: { enabled: true, data: { items: [{ id: maria.groupId }, maria.id] } } }],
    })
    expect(isError).toBe(true)
    expect(json.error.code).toBe('validation')
    expect(json.error.issues).toHaveLength(1)
    const [issue] = json.error.issues
    expect(issue.path).toBe('slots.quotes.data.items.1')
    expect(issue.message).toBe(t('mcp.useGroupId', { id: maria.id, groupId: maria.groupId }))
    expect((await core.getDocument(doc.id))!.headRev).toBe(doc.headRev)

    const fixed = await mcp.call('update_document', {
      id: doc.id,
      baseRevisionId: doc.headRev,
      changes: [{ path: 'slots.quotes.data.items', value: [maria.groupId] }],
    })
    expect(fixed.isError, fixed.text).toBe(false)
  })

  it('answers an unknown id with a plain sentence', async () => {
    const { isError, text } = await mcp.call('update_document', {
      id: 'nope',
      baseRevisionId: 1,
      changes: [{ path: 'fields.title', value: 'A' }],
    })
    expect(isError).toBe(true)
    expect(text.split('\n')[0]).toBe(t('mcp.documentNotFound', { id: 'nope' }))
  })
})

describe('create_entry', () => {
  it('creates an unpublished draft from the agent format', async () => {
    const maria = await core.createEntry('testimonials', { fields: { author: 'María', quote: 'Great' } }, owner)
    const { isError, text, json } = await mcp.call('create_entry', {
      collection: 'posts',
      content: {
        fields: { title: 'Hello World', date: '2026-02-03', body: 'Some **bold** text.', featured: { id: maria.groupId } },
        slots: { x: { enabled: false } },
      },
      message: 'First post',
    })
    expect(isError, text).toBe(false)
    expect(json).toMatchObject({ title: 'Hello World', url: null })
    expect(json.previewUrl).toMatch(/^https:\/\/example\.com\/_inlay\/preview\?token=.*&path=%2Fblog%2Fhello-world$/)

    const doc = (await core.getDocument(json.id))!
    expect(doc.groupId).toBe(json.groupId)
    expect(doc.headRev).toBe(json.revisionId)
    expect(doc.publishedRev).toBeNull()
    expect(doc.revision.source).toBe('mcp')
    expect(doc.data.slug).toBe('hello-world')
    expect(doc.data.fields.featured).toBe(maria.groupId)
    expect(doc.data.fields.body).toMatchObject({ type: 'doc' })
    expect(doc.data.slots.x!.enabled).toBe(false)
  })

  it('refuses bad Markdown and creates nothing', async () => {
    const { isError, text } = await mcp.call('create_entry', {
      collection: 'posts',
      content: { fields: { title: 'Bad', date: '2026-02-03', body: '```\ncode\n```' } },
    })
    expect(isError).toBe(true)
    expect(text).toMatch(/Line 1/)
    expect(await core.listEntries('posts')).toEqual([])
  })

  it("refuses a document id in a reference and creates nothing", async () => {
    const maria = await core.createEntry('testimonials', { fields: { author: 'María', quote: 'Great' } }, owner)
    const { isError, json } = await mcp.call('create_entry', {
      collection: 'posts',
      content: { fields: { title: 'Hello', date: '2026-02-03', body: 'Hi.', featured: maria.id } },
    })
    expect(isError).toBe(true)
    expect(json.error.issues).toHaveLength(1)
    expect(json.error.issues[0].path).toBe('fields.featured')
    expect(json.error.issues[0].message).toContain(maria.groupId)
    expect(await core.listEntries('posts')).toEqual([])
  })

  it('refuses fields, parts and a path the collection does not have, naming each, and creates nothing', async () => {
    const { isError, json } = await mcp.call('create_entry', {
      collection: 'posts',
      content: {
        path: '/somewhere',
        fields: { title: 'Hello', date: '2026-02-03', body: 'Hi.', bogus: 1, also: 2 },
        slots: { nope: { enabled: true }, x: { data: { items: [], extra: 1 } } },
      },
    })
    expect(isError).toBe(true)
    expect(json.error.issues.map((i: { path: string }) => i.path).sort()).toEqual(
      ['fields.also', 'fields.bogus', 'path', 'slots.nope', 'slots.x.data.extra'].sort(),
    )
    expect(await core.listEntries('posts')).toEqual([])
  })

  it('reports bad Markdown and a bad date together', async () => {
    const { isError, json } = await mcp.call('create_entry', {
      collection: 'posts',
      content: { fields: { title: 'Hello', date: 'October 15, 2026', body: '# Too big' } },
    })
    expect(isError).toBe(true)
    expect(json.error.issues.map((i: { path: string }) => i.path).sort()).toEqual(['fields.body', 'fields.date'])
    expect(json.error.issues.find((i: { path: string }) => i.path === 'fields.date').message).toBe(
      t('issue.date', { field: 'Date' }),
    )
  })

  it('refuses a type that is not a collection', async () => {
    const { isError, json } = await mcp.call('create_entry', { collection: 'home', content: { fields: {} } })
    expect(isError).toBe(true)
    expect(json.error.code).toBe('invalid_operation')
  })
})

describe('create_translation', () => {
  it('copies a document into another language as a draft', async () => {
    const about = (await core.findSingleton('about'))!
    const { isError, text, json } = await mcp.call('create_translation', { id: about.id, locale: 'es' })
    expect(isError, text).toBe(false)
    expect(json).toMatchObject({ groupId: about.groupId, title: 'About', url: null })
    expect(json.previewUrl).toMatch(/^https:\/\/example\.com\/_inlay\/preview\?token=.*&path=%2Fes%2Facerca$/)
    const es = (await core.getDocument(json.id))!
    expect(es.locale).toBe('es')
    expect(es.publishedRev).toBeNull()
    expect(es.headRev).toBe(json.revisionId)
  })
})

describe('create_translation errors', () => {
  it('says a translation already exists in plain words', async () => {
    const home = (await core.findSingleton('home'))!
    expect(await core.findSingleton('home', 'es')).toBeTruthy()
    const { json } = await mcp.call('create_translation', { id: home.id, locale: 'es' })
    expect(json.error.message).toBe(t('error.translationExists', { locale: 'es' }))
    expect(json.error.message).not.toMatch(/ a es /)
  })

  it('tells the main language apart from a language the site does not have', async () => {
    const about = (await core.findSingleton('about'))!
    const main = await mcp.call('create_translation', { id: about.id, locale: 'en' })
    expect(main.json.error.message).toBe(t('error.translateDefault', { locale: 'en' }))
    const unknown = await mcp.call('create_translation', { id: about.id, locale: 'fr' })
    expect(unknown.json.error.message).toBe(t('error.translateLocale', { locale: 'fr', locales: 'es' }))
  })
})

describe('delete_entry', () => {
  it('refuses to delete an entry in use, listing where', async () => {
    const maria = await core.createEntry('testimonials', { fields: { author: 'María', quote: 'Great' } }, owner)
    const doc = await home()
    await core.patchDraft(
      doc.id,
      { baseRevisionId: doc.headRev, ops: [{ path: ['slots', 'quotes'], value: { enabled: true, data: { items: [maria.groupId] } } }] },
      owner,
    )
    const { isError, text, json } = await mcp.call('delete_entry', { id: maria.id })
    expect(isError).toBe(true)
    expect(json.error.code).toBe('in_use')
    expect(text).toContain(`id ${doc.id}`)
    expect((await core.getDocument(maria.id))!.deletedAt).toBeNull()
  })

  it('deletes an unused entry', async () => {
    const sam = await core.createEntry('testimonials', { fields: { author: 'Sam', quote: 'Lovely' } }, owner)
    const { isError, text, json } = await mcp.call('delete_entry', { id: sam.id })
    expect(isError, text).toBe(false)
    expect(json).toEqual({ deleted: { groupId: sam.groupId, title: 'Sam', locales: ['en'] } })
    expect((await core.getDocument(sam.id))!.deletedAt).not.toBeNull()
  })

  it('is marked destructive', async () => {
    const { tools } = await mcp.client.listTools()
    expect(tools.find((tool) => tool.name === 'delete_entry')?.annotations?.destructiveHint).toBe(true)
  })
})

describe('list_pending_changes', () => {
  it('lists an edited page with its changes', async () => {
    const doc = await home()
    await core.publish([doc.id], owner)
    const published = (await core.getDocument(doc.id))!
    const edited = await mcp.call('update_document', {
      id: doc.id,
      baseRevisionId: published.headRev,
      changes: [{ path: 'slots.hero.data.headline', value: 'New' }],
    })
    expect(edited.isError, edited.text).toBe(false)

    const { isError, json } = await mcp.call('list_pending_changes')
    expect(isError).toBe(false)
    const change = json.changes.find((c: { id: string }) => c.id === doc.id)
    expect(change).toMatchObject({ groupId: doc.groupId, type: 'home', locale: 'en', title: 'Home', isNew: false })
    expect(change.lines.some((line: string) => line.includes('Hero → Headline'))).toBe(true)
  })
})

describe('get_preview_link', () => {
  it("links to a document's page, or to the home page", async () => {
    const about = (await core.findSingleton('about'))!
    const page = await mcp.call('get_preview_link', { id: about.id })
    expect(page.isError).toBe(false)
    expect(new URL(page.json.previewUrl).searchParams.get('path')).toBe('/about')

    const nav = (await core.findSingleton('nav'))!
    const global = await mcp.call('get_preview_link', { id: nav.id })
    expect(new URL(global.json.previewUrl).searchParams.get('path')).toBe('/')

    const site = await mcp.call('get_preview_link')
    expect(new URL(site.json.previewUrl).searchParams.get('path')).toBe('/')
  })

  it('lists the editing tools as not read-only, except the two that only read', async () => {
    const { tools } = await mcp.client.listTools()
    const hint = (name: string) => tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint
    for (const name of ['update_document', 'create_entry', 'create_translation', 'delete_entry']) expect(hint(name)).toBe(false)
    for (const name of ['list_pending_changes', 'get_preview_link']) expect(hint(name)).toBe(true)
  })
})
