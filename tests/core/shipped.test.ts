import type { Kysely } from 'kysely'
import { z } from 'zod'
import { createCore, type Core } from '../../src/core/core.js'
import type { Database } from '../../src/core/db/schema.js'
import { InlayError } from '../../src/core/errors.js'
import { f } from '../../src/core/fields/builtins.js'
import { t } from '../../src/core/messages/index.js'
import { defineContent, defineEntries, type ShippedContent } from '../../src/core/registry/content.js'
import { defineCollection, defineSite, defineTemplate } from '../../src/core/registry/define.js'
import type { DocumentData } from '../../src/core/types.js'
import { articleSite } from '../fixtures/articles.js'
import { homeTitledSite } from '../fixtures/evolve.js'
import { aboutShipped, DEFAULT_CONTENT, homeShipped, maria, navShipped, post, shippedSite } from '../fixtures/shipped.js'
import { routedSite } from '../fixtures/routes.js'
import { makeCore } from '../helpers/core.js'

async function rejection(promise: Promise<unknown>): Promise<InlayError> {
  try {
    await promise
  } catch (e) {
    expect(e).toBeInstanceOf(InlayError)
    return e as InlayError
  }
  throw new Error('expected a rejection')
}

let time = Date.parse('2026-06-01T00:00:00.000Z')
const later = () => {
  const d = new Date(time)
  time += 1000
  return d
}

/** A core for a later version of the site over the same database. */
const again = (db: Kysely<Database>, content: ShippedContent[]): Core => createCore({ site: shippedSite(content), db, now: later })

const count = async (db: Kysely<Database>, table: 'documents' | 'revisions' | 'publish_events'): Promise<number> =>
  Number((await db.selectFrom(table).select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)
const rows = (db: Kysely<Database>) => count(db, 'documents')
const revisions = (db: Kysely<Database>) => count(db, 'revisions')

const row = (db: Kysely<Database>, type: string, key: string, locale = 'en') =>
  db
    .selectFrom('documents')
    .selectAll()
    .where('type', '=', type)
    .where('key', '=', key)
    .where('locale', '=', locale)
    .executeTakeFirstOrThrow()

const published = async (core: Core, id: string): Promise<DocumentData> => (await core.getDocument(id, { state: 'published' }))!.data
const headline = (data: DocumentData) => data.slots.hero!.data.headline

/** The fixture site with custom paths for posts, shipping `content`. */
const pathSite = (content: ShippedContent[]) => defineSite({ ...routedSite(), content })

const withMaria = (doc: typeof maria) => defineEntries('testimonials', [doc])
const rest = [aboutShipped, navShipped, withMaria(maria)]

describe('shipped content', () => {
  it('creates and publishes every shipped document and locale', async () => {
    const { core, db } = await makeCore({ site: shippedSite() })
    const report = await core.applyShippedContent()
    expect(report.created.map((i) => `${i.type}:${i.key}:${i.locale}`)).toEqual([
      'about:about:en',
      'home:home:en',
      'home:home:es',
      'nav:nav:en',
      'testimonials:maria:en',
      'testimonials:maria:es',
    ])
    expect(report.replaced).toEqual([])
    expect(report.skipped).toEqual([])
    for (const item of report.created) {
      expect(item.edition).toBe(1)
      const doc = (await core.getDocument(item.documentId!))!
      expect(doc.publishedRev).not.toBeNull()
      expect(doc.publishedRev).toBe(doc.headRev)
      expect(doc.revision.source).toBe('release')
    }
    expect(await row(db, 'home', 'home')).toMatchObject({ key: 'home', edition: 1 })
    expect(await row(db, 'testimonials', 'maria', 'es')).toMatchObject({ key: 'maria', edition: 1 })
    const events = await db.selectFrom('publish_events').selectAll().execute()
    expect(events).toHaveLength(1)
    expect(events[0]!.source).toBe('release')
    expect(JSON.parse(events[0]!.items)).toHaveLength(6)
  })

  it('resolves keys to group ids in ref and link fields', async () => {
    const { core, db } = await makeCore({ site: shippedSite() })
    await core.applyShippedContent()
    const home = await row(db, 'home', 'home')
    const about = await row(db, 'about', 'about')
    const testimonial = await row(db, 'testimonials', 'maria')
    const nav = await row(db, 'nav', 'nav')
    const data = await published(core, home.id)
    expect(data.slots.quotes!.data.items).toEqual([testimonial.group_id])
    expect(data.slots.hero!.data.cta).toEqual({ document: about.group_id, text: 'About' })
    const links = (await published(core, nav.id)).fields.links as Array<{ link: { document: string } }>
    expect(links[1]!.link.document).toBe(home.group_id)
    expect(links[0]!.link.document).toBe(about.group_id)
  })

  it('resolves inlay:key links in markdown', async () => {
    const article = (key: string, body: string) => ({ key, edition: 1, content: { en: { fields: { title: `Article ${key}`, body } } } })
    const site = defineSite({
      ...articleSite,
      content: [defineEntries('articles', [article('first', 'See [second](inlay:key/articles/second).'), article('second', 'Hello.')])],
    })
    const { core, db } = await makeCore({ site })
    await core.applyShippedContent()
    const first = await row(db, 'articles', 'first')
    const second = await row(db, 'articles', 'second')
    const body = JSON.stringify((await published(core, first.id)).fields.body)
    expect(body).toContain(`"document":"${second.group_id}"`)
    expect(body).not.toContain('inlay:key')
  })

  it('resolves inlay:key links in inline text', async () => {
    const Story = defineTemplate({
      name: 'story',
      label: 'Story',
      fields: z.object({ title: f.text({ label: 'Title' }), headline: f.inlineText({ label: 'Headline' }) }),
      render: (p) => `<h1>${p.fields.title}</h1>`,
    })
    const site = defineSite({
      ...articleSite,
      collections: [
        ...articleSite.collections,
        defineCollection({ name: 'stories', label: 'Stories', template: Story, route: '/stories/:slug' }),
      ],
      content: [
        defineEntries('articles', [{ key: 'second', edition: 1, content: { en: { fields: { title: 'Second', body: 'Hello.' } } } }]),
        defineEntries('stories', [
          { key: 'big', edition: 1, content: { en: { fields: { title: 'Big', headline: '**Big** news, see [second](inlay:key/articles/second)' } } } },
        ]),
      ],
    })
    const { core, db } = await makeCore({ site })
    await core.applyShippedContent()
    const second = await row(db, 'articles', 'second')
    const headline = (await published(core, (await row(db, 'stories', 'big')).id)).fields.headline
    expect(headline).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Big', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' news, see ' },
            { type: 'text', text: 'second', marks: [{ type: 'link', attrs: { document: second.group_id } }] },
          ],
        },
      ],
    })
  })

  it('refuses an unknown key before writing anything', async () => {
    const home = defineContent('home', {
      edition: 1,
      content: {
        en: {
          fields: { title: 'Home' },
          slots: { hero: { headline: 'Hi' }, features: { cards: [{ title: 'Fast' }] }, quotes: { items: [{ key: 'nobody' }] } },
        },
      },
    })
    const { core, db } = await makeCore({ site: shippedSite([home, aboutShipped, navShipped, withMaria(maria)]) })
    const e = await rejection(core.applyShippedContent())
    expect(e.code).toBe('shipped_content')
    expect(e.params).toMatchObject({ type: 'home', key: 'home', locale: 'en' })
    const issues = e.details.issues!
    expect(issues[0]!.message).toContain('nobody')
    expect(await rows(db)).toBe(0)
  })

  it('two entries that reference each other both resolve', async () => {
    const { core, db } = await makeCore({
      site: shippedSite([defineEntries('posts', [post('a', { related: [{ key: 'b' }] }), post('b', { related: [{ key: 'a' }] })])]),
    })
    const report = await core.applyShippedContent()
    expect(report.created).toHaveLength(2)
    const a = await row(db, 'posts', 'a')
    const b = await row(db, 'posts', 'b')
    expect((await published(core, a.id)).fields.related).toEqual([b.group_id])
    expect((await published(core, b.id)).fields.related).toEqual([a.group_id])
  })

  it('invalid shipped content writes nothing', async () => {
    const broken = { ...maria, content: { en: { fields: { author: 'Maria' } } } }
    const { core, db } = await makeCore({ site: shippedSite([aboutShipped, withMaria(broken)]) })
    const e = await rejection(core.applyShippedContent())
    expect(e.code).toBe('shipped_content')
    expect(e.params).toMatchObject({ type: 'testimonials', key: 'maria', locale: 'en' })
    expect(await rows(db)).toBe(0)
  })

  it('applying again with the same editions writes nothing', async () => {
    const { core, db } = await makeCore({ site: shippedSite() })
    await core.applyShippedContent()
    const before = { revisions: await revisions(db), events: await count(db, 'publish_events') }
    expect(await again(db, DEFAULT_CONTENT).applyShippedContent()).toEqual({ created: [], replaced: [], skipped: [], deletedRefs: [], warnings: [] })
    expect({ revisions: await revisions(db), events: await count(db, 'publish_events') }).toEqual(before)
  })

  it('a higher edition replaces the content and publishes it, one revision back', async () => {
    const { core, db } = await makeCore({ site: shippedSite() })
    await core.applyShippedContent()
    const next = again(db, [homeShipped(2, 'Hello again'), ...rest])
    const report = await next.applyShippedContent()
    expect(report.created).toEqual([])
    expect(report.replaced.map((i) => `${i.type}:${i.locale}:${i.edition}`)).toEqual(['home:en:2', 'home:es:2'])
    const home = await row(db, 'home', 'home')
    expect(report.replaced[0]!.documentId).toBe(home.id)
    expect(headline(await published(next, home.id))).toBe('Hello again')
    const doc = (await next.getDocument(home.id))!
    expect(doc.publishedRev).toBe(doc.headRev)
    expect(await next.listRevisions(home.id)).toHaveLength(2)
    expect(home.edition).toBe(2)
    expect((await row(db, 'home', 'home', 'es')).edition).toBe(2)
  })

  it('shipped content gets its activation time and keeps it across a new edition', async () => {
    const { core, db } = await makeCore({ site: shippedSite() })
    await core.applyShippedContent()
    const event = (await db.selectFrom('publish_events').select('at').executeTakeFirstOrThrow()).at
    const before = await row(db, 'home', 'home')
    expect(before.first_published_at).toBe(event)
    await again(db, [homeShipped(2, 'Hello again'), ...rest]).applyShippedContent()
    const after = await row(db, 'home', 'home')
    expect(after.edition).toBe(2)
    expect(after.first_published_at).toBe(event)
  })

  it('a lower edition leaves the content alone (rollback)', async () => {
    const { core, db } = await makeCore({ site: shippedSite([homeShipped(2), ...rest]) })
    await core.applyShippedContent()
    const report = await again(db, [homeShipped(1, 'Old'), ...rest]).applyShippedContent()
    expect(report.replaced).toEqual([])
    const home = await row(db, 'home', 'home')
    expect(headline(await published(core, home.id))).toBe('Welcome')
    expect(home.edition).toBe(2)
  })

  it('a client edit survives an equal edition', async () => {
    const { core, db, editor } = await makeCore({ site: shippedSite() })
    await core.applyShippedContent()
    const home = await row(db, 'home', 'home')
    const doc = (await core.getDocument(home.id))!
    const data = structuredClone(doc.data)
    data.slots.hero!.data.headline = 'Mine'
    await core.saveDraft(home.id, { baseRevisionId: doc.headRev, data }, editor)
    await core.publish([home.id], editor)
    const report = await again(db, DEFAULT_CONTENT).applyShippedContent()
    expect(report.replaced).toEqual([])
    expect(headline(await published(core, home.id))).toBe('Mine')
  })

  it('a client-created translation is replaced by shipped content for that locale', async () => {
    const enOnly = defineContent('home', { edition: 1, content: { en: (homeShipped(1).documents[0]!.content.en)! } })
    const { core, db, owner } = await makeCore({ site: shippedSite([enOnly, ...rest]) })
    await core.applyShippedContent()
    const home = await row(db, 'home', 'home')
    const es = await core.createTranslation(home.group_id, 'es', owner)
    const report = await again(db, DEFAULT_CONTENT).applyShippedContent()
    expect(report.created).toEqual([])
    expect(report.replaced.map((i) => `${i.type}:${i.locale}`)).toEqual(['home:es'])
    expect(report.replaced[0]!.documentId).toBe(es.id)
    const data = await published(core, es.id)
    expect(data.fields.title).toBe('Inicio')
    expect(headline(data)).toBe('Bienvenido')
    expect(await core.listRevisions(es.id)).toHaveLength(2)
    expect((await row(db, 'home', 'home', 'es')).edition).toBe(1)
  })

  it('a client draft is superseded by a higher edition', async () => {
    const { core, db, editor } = await makeCore({ site: shippedSite() })
    await core.applyShippedContent()
    const home = await row(db, 'home', 'home')
    const doc = (await core.getDocument(home.id))!
    const data = structuredClone(doc.data)
    data.slots.hero!.data.headline = 'Draft'
    await core.saveDraft(home.id, { baseRevisionId: doc.headRev, data }, editor)
    const next = again(db, [homeShipped(2, 'Hello again'), ...rest])
    await next.applyShippedContent()
    const after = (await next.getDocument(home.id))!
    expect(after.headRev).toBe(after.publishedRev)
    expect(headline(after.data)).toBe('Hello again')
    expect(await next.listRevisions(home.id)).toHaveLength(3)
    expect((await next.listPendingChanges()).map((d) => d.type)).not.toContain('home')
  })

  it('an entry the client deleted stays deleted, and a new locale for it is skipped', async () => {
    const enOnly = { ...maria, content: { en: maria.content.en! } }
    const { core, db, owner } = await makeCore({ site: shippedSite([withMaria(enOnly)]) })
    await core.applyShippedContent()
    const before = await row(db, 'testimonials', 'maria')
    await core.deleteEntry(before.group_id, owner)
    const docs = await rows(db)
    const report = await again(db, [withMaria({ ...maria, edition: 2 })]).applyShippedContent()
    expect(report.created).toEqual([])
    expect(report.replaced).toEqual([])
    expect(report.skipped.map((i) => `${i.key}:${i.locale}:${i.edition}`)).toEqual(['maria:en:2', 'maria:es:2'])
    expect(report.skipped[0]!.documentId).toBe(before.id)
    expect(report.skipped[1]!.documentId).toBeNull()
    expect(await rows(db)).toBe(docs)
    const after = await row(db, 'testimonials', 'maria')
    expect(after.deleted_at).not.toBeNull()
    expect(after.edition).toBe(1)
  })

  it('a reference to an entry the client deleted is left out and reported', async () => {
    const { core, db, owner } = await makeCore({ site: shippedSite([homeShipped(1, 'Welcome', []), ...rest]) })
    await core.applyShippedContent()
    const gone = await row(db, 'testimonials', 'maria')
    await core.deleteEntry(gone.group_id, owner)
    const next = again(db, [homeShipped(2), ...rest])
    const report = await next.applyShippedContent()
    const home = await row(db, 'home', 'home')
    expect(report.replaced.map((i) => `${i.type}:${i.locale}`)).toEqual(['home:en', 'home:es'])
    expect(home.published_rev).toBe(home.head_rev)
    expect((await published(next, home.id)).slots.quotes!.data.items).toEqual([])
    expect(report.deletedRefs).toEqual([
      {
        item: expect.objectContaining({ type: 'home', key: 'home', locale: 'en', documentId: home.id }),
        target: { type: 'testimonials', key: 'maria' },
        field: 'Testimonials › Testimonials',
      },
    ])
    expect(await next.listGaps()).toEqual([])
  })

  it('client-created entries in a shipped collection are untouched', async () => {
    const { core, db, owner } = await makeCore({ site: shippedSite() })
    await core.applyShippedContent()
    const mine = await core.createEntry('testimonials', { fields: { quote: 'Lovely.', author: 'Ana' } }, owner)
    await again(db, DEFAULT_CONTENT).applyShippedContent()
    const stored = await db.selectFrom('documents').selectAll().where('id', '=', mine.id).executeTakeFirstOrThrow()
    expect(stored.key).toBeNull()
    expect(stored.edition).toBeNull()
    expect(stored.published_rev).toBeNull()
    expect(await core.listEntries('testimonials')).toHaveLength(2)
  })

  it('a new shipped document on a later site is created without touching the rest', async () => {
    const { core, db } = await makeCore({ site: shippedSite() })
    await core.applyShippedContent()
    const before = await revisions(db)
    const report = await again(db, [...DEFAULT_CONTENT, defineEntries('posts', [post('a')])]).applyShippedContent()
    expect(report.created.map((i) => `${i.type}:${i.key}:${i.locale}`)).toEqual(['posts:a:en'])
    expect(report.replaced).toEqual([])
    expect(await revisions(db)).toBe(before + 1)
  })

  it('explicit slugs are used and generated ones avoid each other', async () => {
    const { core, db } = await makeCore({
      site: shippedSite([defineEntries('posts', [post('a', {}, 'hello'), post('b', { title: 'Post' }), post('c', { title: 'Post' })])]),
    })
    await core.applyShippedContent()
    const slugs = await Promise.all(['a', 'b', 'c'].map(async (key) => (await row(db, 'posts', key)).published_slug))
    expect(slugs[0]).toBe('hello')
    expect(slugs[1]).toBe('post')
    expect(slugs[2]).toMatch(/^post-/)
    expect(new Set(slugs).size).toBe(3)
  })

  it('a shipped slug already taken by a client entry gets a free slug and a warning', async () => {
    const { core, db, owner } = await makeCore({ site: shippedSite([defineEntries('posts', [post('a', {}, 'hello')])]) })
    await core.createEntry('posts', { slug: 'hello', fields: { title: 'Mine', date: '2026-01-01', body: 'Text' } }, owner)
    const report = await core.applyShippedContent()
    expect(report.created.map((i) => i.key)).toEqual(['a'])
    expect((await row(db, 'posts', 'a')).published_slug).toBe('hello-2')
    expect(report.warnings).toHaveLength(1)
    expect(report.warnings[0]!.item).toMatchObject({ type: 'posts', key: 'a', locale: 'en' })
    expect(report.warnings[0]!.message).toContain('hello-2')
    expect(await rows(db)).toBe(2)
  })

  it('a clashing shipped slug stays where it landed on later editions', async () => {
    const { core, db, owner } = await makeCore({ site: shippedSite([defineEntries('posts', [post('a', {}, 'hello')])]) })
    await core.createEntry('posts', { slug: 'hello', fields: { title: 'Mine', date: '2026-01-01', body: 'Text' } }, owner)
    const first = await core.applyShippedContent()
    expect((await row(db, 'posts', 'a')).published_slug).toBe('hello-2')
    expect(first.warnings).toHaveLength(1)
    for (const edition of [2, 3]) {
      const next = again(db, [defineEntries('posts', [{ ...post('a', { title: `Edition ${edition}` }, 'hello'), edition }])])
      const report = await next.applyShippedContent()
      expect(report.replaced.map((i) => i.edition)).toEqual([edition])
      const entry = await row(db, 'posts', 'a')
      expect(entry.head_slug).toBe('hello-2')
      expect(entry.published_slug).toBe('hello-2')
      expect(report.warnings).toHaveLength(1)
      expect(report.warnings[0]!.message).toContain('hello-2')
      // The live address didn't move, so nothing redirects.
      expect(await next.listRedirects()).toEqual([])
    }
  })

  it('a replace whose shipped path is taken keeps its path, with a warning', async () => {
    const withPath = (edition: number, path: string) =>
      defineEntries('posts', [{ ...post('a'), edition, content: { en: { ...post('a').content.en, path } } }])
    const { core, db, owner } = await makeCore({ site: pathSite([withPath(1, '/one')]) })
    await core.applyShippedContent()
    expect((await row(db, 'posts', 'a')).published_path).toBe('/one')
    await core.createEntry('posts', { path: '/two', fields: { title: 'Mine', date: '2026-01-01', body: 'Text' } }, owner)
    const report = await createCore({ site: pathSite([withPath(2, '/two')]), db, now: later }).applyShippedContent()
    expect(report.replaced.map((i) => i.key)).toEqual(['a'])
    const entry = await row(db, 'posts', 'a')
    expect(entry.head_path).toBe('/one')
    expect(entry.published_path).toBe('/one')
    expect(report.warnings).toEqual([
      {
        item: expect.objectContaining({ type: 'posts', key: 'a', locale: 'en', edition: 2 }),
        message: t('shipped.pathTaken', { label: 'Posts', key: 'a', locale: 'en', path: '/two', kept: '/one' }),
      },
    ])
  })

  it('a new document whose shipped path is taken is created without one, with a warning', async () => {
    const shipped = defineEntries('posts', [{ ...post('a'), content: { en: { ...post('a').content.en, path: '/taken' } } }])
    const { core, db, owner } = await makeCore({ site: pathSite([shipped]) })
    await core.createEntry('posts', { path: '/taken', fields: { title: 'Mine', date: '2026-01-01', body: 'Text' } }, owner)
    const report = await core.applyShippedContent()
    expect(report.created.map((i) => i.key)).toEqual(['a'])
    const entry = await row(db, 'posts', 'a')
    expect(entry.head_path).toBeNull()
    expect(entry.published_path).toBeNull()
    expect(report.warnings).toEqual([
      {
        item: expect.objectContaining({ type: 'posts', key: 'a', locale: 'en' }),
        message: t('shipped.pathDropped', { label: 'Posts', key: 'a', locale: 'en', path: '/taken' }),
      },
    ])
  })

  it('a replaced entry keeps its slug unless the shipped content gives one', async () => {
    const { core, db, editor } = await makeCore({ site: shippedSite([defineEntries('posts', [post('a')])]) })
    await core.applyShippedContent()
    const before = await row(db, 'posts', 'a')
    expect(before.published_slug).toBe('post-a')
    // A client draft renames it; the replace keeps the live address, not the draft's.
    const doc = (await core.getDocument(before.id))!
    await core.saveDraft(before.id, { baseRevisionId: doc.headRev, data: { ...structuredClone(doc.data), slug: 'renamed' } }, editor)
    expect((await row(db, 'posts', 'a')).head_slug).toBe('renamed')
    const report = await again(db, [defineEntries('posts', [{ ...post('a', { title: 'Renamed' }), edition: 2 }])]).applyShippedContent()
    expect(report.replaced).toHaveLength(1)
    const after = await row(db, 'posts', 'a')
    expect(after.head_slug).toBe('post-a')
    expect(after.published_slug).toBe('post-a')
    expect((await published(core, after.id)).fields.title).toBe('Renamed')
  })

  it('replacing a routed entry whose shipped slug changed redirects the old address', async () => {
    const { core, db } = await makeCore({ site: shippedSite([defineEntries('posts', [post('a', {}, 'old')])]) })
    await core.applyShippedContent()
    const next = again(db, [defineEntries('posts', [{ ...post('a', {}, 'new'), edition: 2 }])])
    await next.applyShippedContent()
    const entry = await row(db, 'posts', 'a')
    expect(entry.published_slug).toBe('new')
    expect(await next.resolvePath('/blog/old')).toEqual({ kind: 'redirect', location: '/blog/new', status: 301 })
    expect(await next.listRedirects()).toEqual([
      expect.objectContaining({ from: '/blog/old', to: { document: entry.group_id }, source: 'auto', status: 301 }),
    ])
  })

  it('a replace carries what the stored head has that the site no longer knows', async () => {
    const { core, db } = await makeCore({ site: shippedSite() })
    await core.applyShippedContent()
    const titled = defineContent('home', {
      edition: 2,
      content: {
        en: {
          fields: { title: 'Home' },
          slots: { hero: { title: 'Hello', variant: 'light' }, features: { cards: [{ title: 'Fast' }] }, quotes: { items: [{ key: 'maria' }] } },
        },
      },
    })
    const next = createCore({ site: defineSite({ ...homeTitledSite, content: [titled, ...rest] }), db, now: later })
    expect((await next.applyShippedContent()).replaced.map((i) => `${i.type}:${i.locale}`)).toEqual(['home:en'])
    const home = await row(db, 'home', 'home')
    const head = await db.selectFrom('revisions').select('data').where('id', '=', home.head_rev!).executeTakeFirstOrThrow()
    const hero = (JSON.parse(head.data) as DocumentData).slots.hero!.data
    expect(hero.title).toBe('Hello')
    expect(hero.headline).toBe('Welcome')
  })

  it('a dry run reports replaced and skipped without writing', async () => {
    const enOnly = { ...maria, content: { en: maria.content.en! } }
    const { core, db, owner } = await makeCore({ site: shippedSite([homeShipped(1, 'Welcome', []), aboutShipped, navShipped, withMaria(enOnly)]) })
    await core.applyShippedContent()
    await core.deleteEntry((await row(db, 'testimonials', 'maria')).group_id, owner)
    const before = { rows: await rows(db), revisions: await revisions(db), events: await count(db, 'publish_events') }
    const report = await again(db, [homeShipped(2, 'Hello again', []), aboutShipped, navShipped, withMaria({ ...maria, edition: 2 })]).applyShippedContent({
      dryRun: true,
    })
    expect(report.replaced.map((i) => `${i.type}:${i.locale}`)).toEqual(['home:en', 'home:es'])
    expect(report.skipped.map((i) => `${i.key}:${i.locale}`)).toEqual(['maria:en', 'maria:es'])
    expect({ rows: await rows(db), revisions: await revisions(db), events: await count(db, 'publish_events') }).toEqual(before)
    const home = await row(db, 'home', 'home')
    expect(home.edition).toBe(1)
    expect(headline(await published(core, home.id))).toBe('Welcome')
  })

  it('only a Markdown link target is read as a key', async () => {
    const article = (key: string, body: string) => ({ key, edition: 1, content: { en: { fields: { title: `Article ${key}`, body } } } })
    const text = 'Write inlay:key/articles/second in a link.'
    const site = defineSite({ ...articleSite, content: [defineEntries('articles', [article('first', text), article('second', 'Hello.')])] })
    const { core, db } = await makeCore({ site })
    await core.applyShippedContent()
    const body = JSON.stringify((await published(core, (await row(db, 'articles', 'first')).id)).fields.body)
    expect(body).toContain('inlay:key/articles/second')
    expect(body).not.toContain('inlay:document')
  })

  it('a dry run reports without writing', async () => {
    const { core, db } = await makeCore({ site: shippedSite() })
    const report = await core.applyShippedContent({ dryRun: true })
    expect(report.created).toHaveLength(6)
    for (const item of report.created) expect(item.documentId).toBeNull()
    expect(await rows(db)).toBe(0)
    expect(await count(db, 'publish_events')).toBe(0)
    expect((await core.applyShippedContent()).created).toHaveLength(6)
    expect(await rows(db)).toBe(6)
  })
})
