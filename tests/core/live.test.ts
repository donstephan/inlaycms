import { createCore, type Core } from '../../src/core/core.js'
import type { SiteDefinition } from '../../src/core/registry/define.js'
import type { Ctx, DocumentView, RouteMatch } from '../../src/core/types.js'
import { routedSite } from '../fixtures/routes.js'
import { defineEntries } from '../../src/core/registry/content.js'
import { aboutShipped, homeShipped, maria, navShipped, shippedSite } from '../fixtures/shipped.js'
import { makeCore } from '../helpers/core.js'

const fields = { title: 'Hello world', date: '2026-02-01', body: 'Hi' }

async function world(site: SiteDefinition = routedSite()) {
  const w = await makeCore({ site })
  await w.core.applyShippedContent()
  const post = await w.core.createEntry('posts', { fields }, w.owner)
  await w.core.publish([post.id], w.owner)
  return { ...w, post }
}

const page = (m: RouteMatch) => {
  if (m.kind !== 'page') throw new Error(`expected a page, got ${JSON.stringify(m)}`)
  return m.document
}

async function translate(core: Core, owner: Ctx, post: DocumentView, slug: string, publish: boolean) {
  const es = await core.createTranslation(post.groupId, 'es', owner)
  const saved = await core.saveDraft(
    es.id,
    { baseRevisionId: es.headRev, data: { ...es.data, slug, fields: { ...fields, title: 'Hola mundo' } } },
    owner,
  )
  if (publish) await core.publish([es.id], owner)
  return saved
}

describe('resolvePath: root and locales', () => {
  it('serves the home page in each locale', async () => {
    const { core } = await world()
    expect(page(await core.resolvePath('/'))).toMatchObject({ type: 'home', locale: 'en', contentLocale: 'en', path: '/' })
    expect(page(await core.resolvePath('/es'))).toMatchObject({
      type: 'home',
      locale: 'es',
      contentLocale: 'es',
      fallback: false,
      path: '/es',
    })
  })
  it('uses per-locale singleton paths and falls back to the default locale', async () => {
    const { core } = await world()
    expect(await core.resolvePath('/acerca')).toEqual({ kind: 'not_found', locale: 'en' })
    expect(page(await core.resolvePath('/es/acerca'))).toMatchObject({
      type: 'about',
      locale: 'es',
      contentLocale: 'en',
      fallback: true,
      path: '/es/acerca',
    })
  })
})

describe('resolvePath: normalizing redirects', () => {
  it('strips trailing slashes and the default-locale prefix', async () => {
    const { core } = await world()
    expect(await core.resolvePath('/about/')).toEqual({ kind: 'redirect', location: '/about', status: 301 })
    expect(await core.resolvePath('/en/about')).toEqual({ kind: 'redirect', location: '/about', status: 301 })
    expect(await core.resolvePath('/en')).toEqual({ kind: 'redirect', location: '/', status: 301 })
    expect(await core.resolvePath('/es/')).toEqual({ kind: 'redirect', location: '/es', status: 301 })
  })
  it('never redirects off the site', async () => {
    const { core } = await world()
    for (const p of ['//evil.com/', '/%2F%2Fevil.com/', '/\\evil.com/', '//evil.com']) {
      expect((await core.resolvePath(p)).kind).toBe('not_found')
    }
  })
  it('emits encoded locations', async () => {
    const { core, owner } = await world()
    const p = await core.createEntry('posts', { fields, path: '/café menu' }, owner)
    await core.publish([p.id], owner)
    expect(page(await core.resolvePath('/caf%C3%A9%20menu')).documentId).toBe(p.id)
    expect(await core.resolvePath('/caf%C3%A9%20menu/')).toEqual({
      kind: 'redirect',
      location: '/caf%C3%A9%20menu',
      status: 301,
    })
  })
})

describe('resolvePath: drafts and deletions', () => {
  it('serves a draft-only post in preview only', async () => {
    const { core, owner } = await world()
    await core.createEntry('posts', { fields: { ...fields, title: 'Draft only' } }, owner)
    expect((await core.resolvePath('/blog/draft-only')).kind).toBe('not_found')
    expect(page(await core.resolvePath('/blog/draft-only', { state: 'preview' })).title).toBe('Draft only')
  })
  it('never serves a deleted post', async () => {
    const { core, owner, post } = await world()
    expect(page(await core.resolvePath('/blog/hello-world')).documentId).toBe(post.id)
    await core.deleteEntry(post.groupId, owner)
    expect((await core.resolvePath('/blog/hello-world')).kind).toBe('not_found')
    expect((await core.resolvePath('/blog/hello-world', { state: 'preview' })).kind).toBe('not_found')
  })
})

describe('resolvePath: translations', () => {
  it('serves the default-locale post as a fallback', async () => {
    const { core, post } = await world()
    expect(page(await core.resolvePath('/es/blog/hello-world'))).toMatchObject({
      documentId: post.id,
      locale: 'es',
      contentLocale: 'en',
      fallback: true,
      path: '/es/blog/hello-world',
    })
  })
  it('redirects to a live translation with its own slug', async () => {
    const { core, owner, post } = await world()
    await translate(core, owner, post, 'hola-mundo', true)
    expect(await core.resolvePath('/es/blog/hello-world')).toEqual({
      kind: 'redirect',
      location: '/es/blog/hola-mundo',
      status: 301,
    })
    expect(page(await core.resolvePath('/es/blog/hola-mundo'))).toMatchObject({
      contentLocale: 'es',
      fallback: false,
      title: 'Hola mundo',
    })
  })
  it('treats an unpublished translation as missing', async () => {
    const { core, owner, post } = await world()
    await translate(core, owner, post, 'hola-mundo', false)
    expect(page(await core.resolvePath('/es/blog/hello-world'))).toMatchObject({ fallback: true })
    expect((await core.resolvePath('/es/blog/hola-mundo')).kind).toBe('not_found')
    expect(page(await core.resolvePath('/es/blog/hola-mundo', { state: 'preview' }))).toMatchObject({ fallback: false })
  })
  it('404s missing translations when fallback is off', async () => {
    const { core } = await world(routedSite({ translationFallback: false }))
    expect(await core.resolvePath('/es/blog/hello-world')).toEqual({ kind: 'not_found', locale: 'es' })
    expect(await core.resolvePath('/es/acerca')).toEqual({ kind: 'not_found', locale: 'es' })
    expect(page(await core.resolvePath('/es')).contentLocale).toBe('es')
  })
})

describe('resolvePath: custom paths', () => {
  it('serves a custom path and redirects the pattern URL to it', async () => {
    const { core, owner } = await world()
    const p = await core.createEntry('posts', { fields: { ...fields, title: 'Old page' }, path: '/old-site/page.html' }, owner)
    await core.publish([p.id], owner)
    expect(page(await core.resolvePath('/old-site/page.html'))).toMatchObject({
      documentId: p.id,
      path: '/old-site/page.html',
    })
    expect(await core.resolvePath('/blog/old-page')).toEqual({
      kind: 'redirect',
      location: '/old-site/page.html',
      status: 301,
    })
    expect(page(await core.resolvePath('/es/old-site/page.html'))).toMatchObject({
      fallback: true,
      path: '/es/old-site/page.html',
    })
  })
  it('never resolves a path-less singleton', async () => {
    const { core } = await world()
    for (const p of ['/notFound', '/not-found', '/page-not-found']) {
      expect((await core.resolvePath(p)).kind).toBe('not_found')
    }
  })
})

describe('live reads', () => {
  it('falls back for globals', async () => {
    const { core } = await world()
    expect(await core.liveSingleton('nav', 'es')).toMatchObject({
      kind: 'global',
      locale: 'es',
      contentLocale: 'en',
      fallback: true,
      path: null,
    })
    expect(await core.liveSingleton('nav', 'es', { state: 'preview' })).toMatchObject({ fallback: true })
  })
  it('lists live entries, newest first, with drafts only in preview', async () => {
    const { core, owner } = await world()
    await core.createEntry('posts', { fields: { ...fields, title: 'Draft only' } }, owner)
    const later = await core.createEntry('posts', { fields: { ...fields, title: 'Second' } }, owner)
    await core.publish([later.id], owner)
    expect((await core.liveEntries('posts', 'en')).map((d) => d.title)).toEqual(['Second', 'Hello world'])
    expect((await core.liveEntries('posts', 'en', { state: 'preview' })).map((d) => d.title)).toEqual([
      'Second',
      'Draft only',
      'Hello world',
    ])
    const es = await core.liveEntries('posts', 'es')
    expect(es.map((d) => [d.title, d.fallback, d.path])).toEqual([
      ['Second', true, '/es/blog/second'],
      ['Hello world', true, '/es/blog/hello-world'],
    ])
  })
  it('reads documents by group', async () => {
    const { core, post } = await world()
    const map = await core.liveDocuments([post.groupId, 'nope'], 'es')
    expect([...map.keys()]).toEqual([post.groupId])
    expect(map.get(post.groupId)).toMatchObject({ slug: 'hello-world', revisionId: post.headRev, fallback: true })
  })
  it('lists alternates', async () => {
    const { core } = await world()
    const home = (await core.findSingleton('home'))!
    const about = (await core.findSingleton('about'))!
    expect(await core.liveAlternates(home.groupId)).toEqual([
      { locale: 'en', path: '/', fallback: false },
      { locale: 'es', path: '/es', fallback: false },
    ])
    expect(await core.liveAlternates(about.groupId)).toEqual([
      { locale: 'en', path: '/about', fallback: false },
      { locale: 'es', path: '/es/acerca', fallback: true },
    ])
  })
})

describe('hidden content', () => {
  it('never resolves a document of a removed type', async () => {
    const { core, db, owner } = await world()
    const p = await core.createEntry('posts', { fields, path: '/old-site/page.html' }, owner)
    await core.publish([p.id], owner)
    const base = routedSite()
    const hidden = createCore({
      site: { ...base, collections: base.collections.filter((c) => c.name !== 'posts') },
      db,
    })
    expect((await hidden.resolvePath('/blog/hello-world')).kind).toBe('not_found')
    expect((await hidden.resolvePath('/old-site/page.html')).kind).toBe('not_found')
    expect((await hidden.resolvePath('/old-site/page.html', { state: 'preview' })).kind).toBe('not_found')
  })
})

describe('publishedAt', () => {
  const firstPublished = async (w: Awaited<ReturnType<typeof world>>, id: string) =>
    (await w.db.selectFrom('documents').select('first_published_at').where('id', '=', id).executeTakeFirstOrThrow())
      .first_published_at

  it('gives each live document its first publish time', async () => {
    const w = await world()
    const expected = await firstPublished(w, w.post.id)
    expect(expected).not.toBeNull()
    expect(page(await w.core.resolvePath('/blog/hello-world')).publishedAt).toBe(expected)
    const [live] = await w.core.liveEntries('posts', 'en')
    expect(live?.publishedAt).toBe(expected)
  })

  it('gives a fallback page the time of the document it shows', async () => {
    const w = await world()
    const about = await w.core.findSingleton('about')
    const expected = await firstPublished(w, about!.id)
    expect(expected).not.toBeNull()
    expect(page(await w.core.resolvePath('/es/acerca'))).toMatchObject({ fallback: true, publishedAt: expected })
  })

  it('gives a never-published document null in preview', async () => {
    const { core, owner } = await world()
    await core.createEntry('posts', { slug: 'draft-only', fields: { ...fields, title: 'Draft only' } }, owner)
    expect(page(await core.resolvePath('/blog/draft-only', { state: 'preview' })).publishedAt).toBeNull()
  })
})

describe('groupIdsByKey', () => {
  it('maps a keyed entry and a singleton, and leaves out a deleted or unknown one', async () => {
    const { core, owner } = await makeCore({ site: shippedSite([homeShipped(1), aboutShipped, navShipped, defineEntries('testimonials', [maria, { ...maria, key: 'lone' }])]) })
    await core.applyShippedContent()
    const refs = [
      { type: 'testimonials', key: 'lone' },
      { type: 'about', key: null },
      { type: 'testimonials', key: 'nobody' },
    ]
    const found = await core.groupIdsByKey(refs)
    expect([...found.keys()].sort()).toEqual(['about/about', 'testimonials/lone'])
    const lone = found.get('testimonials/lone')!
    expect((await core.listEntries('testimonials')).map((e) => e.groupId)).toContain(lone)
    await core.deleteEntry(lone, owner)
    expect([...(await core.groupIdsByKey(refs)).keys()]).toEqual(['about/about'])
  })

  it('gives only the keys asked for, and a singleton by its type written as its key', async () => {
    const { core } = await makeCore({ site: shippedSite([homeShipped(1), aboutShipped, navShipped, defineEntries('testimonials', [maria, { ...maria, key: 'lone' }])]) })
    await core.applyShippedContent()
    const found = await core.groupIdsByKey([
      { type: 'testimonials', key: 'maria' },
      { type: 'about', key: 'about' },
    ])
    expect([...found.keys()].sort()).toEqual(['about/about', 'testimonials/maria'])
    expect(found.get('about/about')).toBe((await core.groupIdsByKey([{ type: 'about', key: null }])).get('about/about'))
  })
})
