import { createCore } from '../../src/core/core.js'
import { InlayError } from '../../src/core/errors.js'
import { f } from '../../src/core/fields/builtins.js'
import { fieldMeta } from '../../src/core/fields/define.js'
import { defineCollection, defineSingleton, defineSite } from '../../src/core/registry/define.js'
import { defineRoute } from '../../src/core/registry/route.js'
import { buildRegistry } from '../../src/core/registry/registry.js'
import {
  encodePath,
  normalizePath,
  singletonPath,
  splitLocale,
  withLocale,
} from '../../src/core/site/paths.js'
import { routedSite } from '../fixtures/routes.js'
import { BasicPage, Post, site } from '../fixtures/site.js'
import { makeCore } from '../helpers/core.js'

const registry = buildRegistry(site)

describe('normalizePath', () => {
  it('accepts clean paths', () => {
    expect(normalizePath('/about')).toBe('/about')
    expect(normalizePath('/about/')).toBe('/about')
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('/caf%C3%A9')).toBe('/café')
  })
  it('rejects anything that could leave the site', () => {
    for (const p of ['//evil.com', '/\\evil.com', '/%2F%2Fevil.com', '/a/../b', '/%E0%A4%A', '/a%00b', 'about']) {
      expect(normalizePath(p)).toBeNull()
    }
  })
})

describe('path helpers', () => {
  it('encodes segments', () => expect(encodePath('/café menu')).toBe('/caf%C3%A9%20menu'))
  it('splits locales', () => {
    expect(splitLocale(registry, '/es')).toEqual({ locale: 'es', rest: '/' })
    expect(splitLocale(registry, '/es/acerca')).toEqual({ locale: 'es', rest: '/acerca' })
    expect(splitLocale(registry, '/espresso')).toEqual({ locale: 'en', rest: '/espresso' })
    expect(splitLocale(registry, '/en/about')).toEqual({ locale: 'en', rest: '/en/about' })
  })
  it('adds locales', () => {
    expect(withLocale(registry, 'es', '/')).toBe('/es')
    expect(withLocale(registry, 'es', '/x')).toBe('/es/x')
    expect(withLocale(registry, 'en', '/x')).toBe('/x')
  })
  it('resolves singleton paths', () => {
    const about = site.singletons.find((s) => s.name === 'about')!
    expect(singletonPath(about, 'es', 'en')).toBe('/acerca')
  })
})

describe('registry path rules', () => {
  const page = (name: string, path: string) =>
    defineSingleton({ name, label: name, template: BasicPage, path })
  const build = (singletons: ReturnType<typeof page>[], collections = [] as ReturnType<typeof defineCollection>[]) =>
    buildRegistry(defineSite({ locales: ['en', 'es'], defaultLocale: 'en', singletons, collections }))
  const code = (fn: () => unknown) => {
    try {
      fn()
    } catch (e) {
      return (e as InlayError).code
    }
    return null
  }

  it('rejects bad singleton paths', () => {
    for (const p of ['/admin/x', '/es/x', '/about/']) expect(code(() => build([page('a', p)]))).toBe('definition')
  })
  it('rejects duplicate singleton paths', () => {
    try {
      build([page('a', '/about'), page('b', '/about')])
      expect.unreachable()
    } catch (e) {
      expect((e as InlayError).messageId).toBe('definition.pathDuplicate')
    }
  })
  it('rejects ? and # in singleton paths and route prefixes', () => {
    for (const p of ['/a?b', '/a#b']) expect(code(() => build([page('a', p)]))).toBe('definition')
    for (const route of ['/blog?x/:slug', '/blog#x/:slug', '/blog/:slug?x']) {
      const c = defineCollection({ name: 'x', label: 'X', template: Post, route })
      expect(code(() => build([], [c]))).toBe('definition')
    }
  })
  it('rejects a reserved route', () => {
    for (const route of ['/media/:slug', '/public/:slug']) {
      const c = defineCollection({ name: 'x', label: 'X', template: Post, route })
      expect(code(() => build([], [c]))).toBe('definition')
    }
  })
  it('reserves /public for its files', () => {
    expect(code(() => build([page('a', '/public')]))).toBe('definition')
    expect(code(() => build([page('a', '/public/x')]))).toBe('definition')
    expect(code(() => build([page('a', '/publications')]))).toBeNull()
  })
})

describe('custom paths', () => {
  const fields = { title: 'T', date: '2026-01-01', body: 'b' }
  const issues = async (path: string, fn = 'posts') => {
    const { core, owner } = await makeCore({ site: routedSite() })
    try {
      await core.createEntry(fn, { fields, path }, owner)
    } catch (e) {
      return (e as InlayError).details.issues
    }
    return []
  }

  it('rejects taken, reserved and clashing paths', async () => {
    for (const p of ['/about', '/blog/anything', '/admin', '/es/x', '/public/site.css']) {
      expect((await issues(p))?.[0]).toMatchObject({ code: 'path_taken', path: ['path'] })
    }
  })
  it('rejects a malformed path as invalid', async () => {
    expect((await issues('/a/../b'))?.[0]).toMatchObject({ code: 'invalid' })
  })
  it('rejects ? and # in a custom path as invalid', async () => {
    for (const p of ['/a?b', '/a#b']) {
      expect((await issues(p))?.[0]).toMatchObject({ code: 'invalid', path: ['path'] })
    }
  })
  it('rejects the path of a site route', async () => {
    const site = defineSite({ ...routedSite(), routes: [defineRoute({ method: 'POST', path: '/contact', handler: () => ({}) })] })
    const { core, owner } = await makeCore({ site })
    const e = await core.createEntry('posts', { fields, path: '/contact' }, owner).catch((err: unknown) => err as InlayError)
    expect(e).toBeInstanceOf(InlayError)
    expect((e as InlayError).details.issues).toMatchObject([{ code: 'path_taken', path: ['path'], message: expect.stringContaining('/contact') }])
    await core.createEntry('posts', { fields, path: '/contact-us' }, owner)
  })
  it("rejects another post's path and allows a translation to keep it", async () => {
    const { core, owner } = await makeCore({ site: routedSite() })
    const a = await core.createEntry('posts', { fields, path: '/hello' }, owner)
    await expect(core.createEntry('posts', { fields, path: '/hello' }, owner)).rejects.toMatchObject({
      details: { issues: [{ code: 'path_taken' }] },
    })
    const es = await core.createTranslation(a.groupId, 'es', owner)
    await core.saveDraft(es.id, { baseRevisionId: es.headRev, data: { path: '/hello', fields, slots: {} } }, owner)
  })
})

describe('slugs under a bare route', () => {
  const rootSite = () =>
    defineSite({
      locales: site.locales,
      defaultLocale: site.defaultLocale,
      singletons: site.singletons,
      globals: site.globals,
      collections: site.collections.map((c) =>
        c.name === 'posts' ? defineCollection({ name: 'posts', label: 'Posts', template: Post, route: '/:slug' }) : c,
      ),
    })
  const fields = { title: 'T', date: '2026-01-01', body: 'b' }

  it('rejects slugs whose page a reserved path, locale root or singleton would hide', async () => {
    const { core, owner } = await makeCore({ site: rootSite() })
    for (const slug of ['admin', 'media', 'es', 'en', 'about']) {
      await expect(core.createEntry('posts', { fields, slug }, owner)).rejects.toMatchObject({
        details: { issues: [{ code: 'path_taken', path: ['slug'] }] },
      })
    }
    await core.createEntry('posts', { fields, slug: 'hello' }, owner)
  })

  it('checks singleton paths in the entry locale', async () => {
    const { core, owner } = await makeCore({ site: rootSite() })
    const a = await core.createEntry('posts', { fields, slug: 'acerca' }, owner)
    const es = await core.createTranslation(a.groupId, 'es', owner)
    await expect(
      core.saveDraft(es.id, { baseRevisionId: es.headRev, data: { slug: 'acerca', fields, slots: {} } }, owner),
    ).rejects.toMatchObject({ details: { issues: [{ code: 'path_taken' }] } })
    const saved = await core.saveDraft(
      es.id,
      { baseRevisionId: es.headRev, data: { slug: 'admin', fields, slots: {} } },
      owner,
    )
    expect(saved).toBeTruthy()
  })

  it('skips hidden slugs when generating one', async () => {
    const { core, owner } = await makeCore({ site: rootSite() })
    const doc = await core.createEntry('posts', { fields: { ...fields, title: 'About' } }, owner)
    expect(doc.data.slug).toBe('about-2')
  })
})

describe('slugs shared between collections', () => {
  const twoAtRoot = (pagesRoute = '/:slug') =>
    defineSite({
      locales: site.locales,
      defaultLocale: site.defaultLocale,
      singletons: site.singletons,
      globals: site.globals,
      collections: [
        ...site.collections.map((c) =>
          c.name === 'posts' ? defineCollection({ name: 'posts', label: 'Posts', template: Post, route: '/:slug' }) : c,
        ),
        defineCollection({ name: 'pages', label: 'Pages', template: Post, route: pagesRoute }),
      ],
    })
  const fields = { title: 'T', date: '2026-01-01', body: 'b' }
  const taken = { details: { issues: [{ code: 'path_taken', path: ['slug'] }] } }

  it('rejects a slug whose page another collection already has, whichever comes first', async () => {
    const { core, owner } = await makeCore({ site: twoAtRoot() })
    await core.createEntry('posts', { fields, slug: 'hello' }, owner)
    await expect(core.createEntry('pages', { fields, slug: 'hello' }, owner)).rejects.toMatchObject(taken)
    await core.createEntry('pages', { fields, slug: 'bye' }, owner)
    await expect(core.createEntry('posts', { fields, slug: 'bye' }, owner)).rejects.toMatchObject(taken)
  })

  it('allows the same slug when the routes give different pages', async () => {
    const { core, owner } = await makeCore({ site: twoAtRoot('/pages/:slug') })
    await core.createEntry('posts', { fields, slug: 'hello' }, owner)
    await core.createEntry('pages', { fields, slug: 'hello' }, owner)
  })

  it("skips another collection's slugs when generating one", async () => {
    const { core, owner } = await makeCore({ site: twoAtRoot() })
    await core.createEntry('posts', { fields: { ...fields, title: 'Hello' } }, owner)
    const doc = await core.createEntry('pages', { fields: { ...fields, title: 'Hello' } }, owner)
    expect(doc.data.slug).toBe('hello-2')
  })

  it('counts default-language entries, which also answer under other languages', async () => {
    const { core, owner } = await makeCore({ site: twoAtRoot() })
    await core.createEntry('posts', { fields, slug: 'hola' }, owner)
    const page = await core.createEntry('pages', { fields, slug: 'other' }, owner)
    const es = await core.createTranslation(page.groupId, 'es', owner)
    await expect(
      core.saveDraft(es.id, { baseRevisionId: es.headRev, data: { slug: 'hola', fields, slots: {} } }, owner),
    ).rejects.toMatchObject(taken)
  })

  it('reports the entry an earlier collection hides', async () => {
    const { core, db, owner } = await makeCore({ site: twoAtRoot('/pages/:slug') })
    await core.createEntry('posts', { fields, slug: 'hello' }, owner)
    await core.createEntry('pages', { fields: { ...fields, title: 'Hidden' }, slug: 'hello' }, owner)
    const later = createCore({ site: twoAtRoot(), db })
    expect(await later.shadowedEntries()).toEqual([
      { document: expect.objectContaining({ type: 'pages', title: 'Hidden' }), slug: 'hello', path: '/hello' },
    ])
  })
})

describe('seo marker', () => {
  it('marks f.seo()', () => expect(fieldMeta(f.seo())?.seo).toBe(true))
})
