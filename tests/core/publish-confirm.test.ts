import { defineCollection } from '../../src/core/registry/define.js'
import type { Core } from '../../src/core/core.js'
import type { Ctx } from '../../src/core/types.js'
import { InlayError } from '../../src/core/errors.js'
import { webSite, Testimonial } from '../fixtures/web.js'
import { defineSite } from '../../src/core/registry/define.js'
import { makeCore } from '../helpers/core.js'
import type { Kysely } from 'kysely'
import type { Database } from '../../src/core/db/schema.js'

describe('confirmed publishing', () => {
  let core: Core
  let db: Kysely<Database>
  let editor: Ctx
  let home: string

  beforeEach(async () => {
    ;({ core, db, editor } = await makeCore({ site: webSite }))
    await core.applyShippedContent()
    home = (await core.findSingleton('home'))!.id
  })

  const edit = async (id: string, mutate: (data: any) => void) => {
    const doc = (await core.getDocument(id))!
    const data = structuredClone(doc.data)
    mutate(data)
    return core.saveDraft(id, { baseRevisionId: doc.headRev, data }, editor)
  }
  const row = (id: string) => db.selectFrom('documents').selectAll().where('id', '=', id).executeTakeFirstOrThrow()

  it('dryRun reports without writing or notifying', async () => {
    await core.publish([home], editor)
    await edit(home, (d) => (d.slots.hero.data.headline = 'Hello'))
    const before = await row(home)
    const eventsBefore = await db.selectFrom('publish_events').selectAll().execute()
    let fired = 0
    core.onLiveChange(() => void fired++)
    const result = await core.publish([home], editor, { dryRun: true })
    expect(result.eventId).toBeNull()
    expect(result.items).toHaveLength(1)
    expect((await row(home)).published_rev).toBe(before.published_rev)
    expect(await db.selectFrom('publish_events').selectAll().execute()).toEqual(eventsBefore)
    expect(fired).toBe(0)
    const un = await core.unpublish([], editor, { dryRun: true })
    expect(un.items).toEqual([])
  })

  it('dryRun fails validation like a real publish', async () => {
    const entry = await core.createEntry('posts', { fields: { title: 'No body' } }, editor)
    const err = await core.publish([entry.id], editor, { dryRun: true }).catch((e) => e)
    expect(err).toBeInstanceOf(InlayError)
    expect(err.code).toBe('validation')
    expect(err.details.documents).toHaveLength(1)
  })

  it('expect with a moved head conflicts and publishes nothing', async () => {
    const about = (await core.findSingleton('about'))!
    await edit(about.id, (d) => (d.fields.title = 'About v2'))
    const oldAbout = (await core.getDocument(about.id))!.headRev
    const oldHome = (await core.getDocument(home))!.headRev
    await edit(home, (d) => (d.slots.hero.data.headline = 'Moved'))
    const publishedBefore = [(await row(home)).published_rev, (await row(about.id)).published_rev]
    const err = await core
      .publish([about.id, home], editor, { expect: { [home]: oldHome, [about.id]: oldAbout } })
      .catch((e) => e)
    expect(err).toBeInstanceOf(InlayError)
    expect(err.code).toBe('conflict')
    expect([(await row(home)).published_rev, (await row(about.id)).published_rev]).toEqual(publishedBefore)
  })

  it('expect with the current head publishes', async () => {
    await edit(home, (d) => (d.slots.hero.data.headline = 'Fresh'))
    const head = (await core.getDocument(home))!.headRev
    const result = await core.publish([home], editor, { expect: { [home]: head } })
    expect(result.items).toHaveLength(1)
    expect((await row(home)).published_rev).toBe(head)
  })

  it('describeChanges lists changes, new entries and caps long lists', async () => {
    await core.publish([home], editor)
    await edit(home, (d) => (d.slots.hero.data.headline = 'Hello'))
    const [changed] = await core.describeChanges([home])
    expect(changed!.isNew).toBe(false)
    expect(changed!.lines).toContain('Hero → Headline: “Welcome to Inlay” → “Hello”')

    const entry = await core.createEntry('testimonials', { fields: { author: 'Ann', quote: 'Nice' } }, editor)
    const [fresh] = await core.describeChanges([entry.id])
    expect(fresh!.isNew).toBe(true)
    await expect(core.describeChanges(['nope'])).rejects.toMatchObject({ code: 'not_found' })
  })

  it('describeChanges caps at 12 lines plus a more line', async () => {
    const { core: c, editor: e } = await makeCore({ site: webSite })
    await c.applyShippedContent()
    const nav = (await c.findSingleton('nav'))!
    await c.publish([nav.id], e)
    const doc = (await c.getDocument(nav.id))!
    const links = Array.from({ length: 30 }, (_, i) => ({ link: { url: `/p${i}`, text: `Link ${i}` } }))
    await c.saveDraft(nav.id, { baseRevisionId: doc.headRev, data: { ...doc.data, fields: { ...doc.data.fields, links } } }, e)
    const [out] = await c.describeChanges([nav.id])
    expect(out!.lines).toHaveLength(13)
    expect(out!.lines[12]).toMatch(/more/)
  })

  it('keeps help on the registry type', async () => {
    const site = defineSite({
      locales: ['en'],
      defaultLocale: 'en',
      collections: [defineCollection({ name: 'testimonials', label: 'T', template: Testimonial, titleField: 'author', help: 'Short client quotes.' })],
    })
    const { core: c } = await makeCore({ site })
    expect(c.registry.getType('testimonials').help).toBe('Short client quotes.')
  })
})
