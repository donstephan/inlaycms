import { z } from 'zod'
import { InlayError } from '../../src/core/errors.js'
import { f } from '../../src/core/fields/builtins.js'
import { fieldMeta } from '../../src/core/fields/define.js'
import {
  defineBlock,
  defineCollection,
  defineGlobal,
  defineSingleton,
  defineSite,
  defineTemplate,
  type SiteInput,
} from '../../src/core/registry/define.js'
import { defineContent, defineEntries } from '../../src/core/registry/content.js'
import { defineIntegration } from '../../src/core/registry/integration.js'
import { buildRegistry } from '../../src/core/registry/registry.js'
import { defineRoute } from '../../src/core/registry/route.js'
import type { RenderContext } from '../../src/core/registry/render.js'
import { rootSite } from '../fixtures/code-redirects.js'
import { BasicPage, Hero, Post, Testimonial, site } from '../fixtures/site.js'

const page = (name: string, extra: Partial<Parameters<typeof defineSingleton>[0]> = {}) =>
  defineSingleton({
    name,
    label: name,
    template: BasicPage,
    path: `/${name}`,
    ...extra,
  })

const withTemplate = (fields: z.ZodObject, slots = {}) =>
  page('custom', { template: defineTemplate({ name: 'custom', fields, slots }) })

function rejects(input: Partial<SiteInput>, text: string): void {
  const build = () => buildRegistry(defineSite({ locales: ['en', 'es'], defaultLocale: 'en', ...input }))
  expect(build).toThrow(InlayError)
  try {
    build()
  } catch (e) {
    expect((e as InlayError).code).toBe('definition')
    expect((e as InlayError).message).toContain(text)
  }
}

describe('buildRegistry', () => {
  const registry = buildRegistry(site)

  it('builds the fixture site', () => {
    expect(registry.locales).toEqual(['en', 'es'])
    expect(registry.defaultLocale).toBe('en')
    expect([...registry.types.keys()].sort()).toEqual(
      ['about', 'home', 'nav', 'notFound', 'posts', 'testimonials'].sort(),
    )
    expect(registry.getType('posts').kind).toBe('collection')
    expect(registry.getType('home').kind).toBe('singleton')
    expect(registry.getType('nav').kind).toBe('global')
  })

  it('accepts readonly and transformed fields, keeping their labels', () => {
    const readonly = f.text({ label: 'X' }).readonly()
    const trimmed = f.text({ label: 'Y' }).transform((s) => s.trim())
    const block = defineBlock({ name: 'wrapped', label: 'Wrapped', schema: z.object({ readonly, trimmed }) })
    const template = defineTemplate({ name: 'custom', fields: z.object({}), slots: { wrapped: { block } } })
    expect(() => buildRegistry(defineSite({ locales: ['en'], defaultLocale: 'en', singletons: [page('custom', { template })] }))).not.toThrow()
    expect(fieldMeta(readonly)?.label).toBe('X')
    expect(fieldMeta(trimmed)?.label).toBe('Y')
  })

  it('fills collection defaults', () => {
    const posts = registry.getType('posts')
    expect(posts).toMatchObject({ route: '/blog/:slug', customPaths: false, titleField: 'title' })
  })

  it('throws not_found for an unknown type', () => {
    expect(() => registry.getType('nope')).toThrow(InlayError)
    try {
      registry.getType('nope')
    } catch (e) {
      expect((e as InlayError).code).toBe('not_found')
      expect((e as InlayError).message).toContain('nope')
    }
  })

  describe('rejects', () => {
    it('a default locale outside the locales', () => {
      rejects({ locales: ['en', 'es'], defaultLocale: 'fr' }, '"fr"')
    })

    it('duplicate locales', () => {
      rejects({ locales: ['en', 'es', 'es'] }, '"es" is listed more than once')
    })

    it('malformed locales', () => {
      rejects({ locales: ['en', 'English'] }, '"English"')
      rejects({ locales: ['en', 'pt_BR'] }, '"pt_BR"')
    })

    it('duplicate type names across kinds', () => {
      rejects(
        {
          singletons: [page('things')],
          collections: [defineCollection({ name: 'things', label: 'Things', template: Post })],
        },
        '"things"',
      )
    })

    it('malformed type names', () => {
      rejects({ singletons: [page('Bad-name')] }, '"Bad-name"')
    })

    it('malformed slot names', () => {
      rejects({ singletons: [withTemplate(z.object({ title: f.text({ label: 'T' }) }), { 'Big-hero': { block: Hero } })] }, '"Big-hero"')
    })

    it('malformed field names at any depth', () => {
      rejects({ singletons: [withTemplate(z.object({ Title: f.text({ label: 'T' }) }))] }, 'custom.Title')
      rejects(
        {
          singletons: [
            withTemplate(
              z.object({ items: f.list(z.object({ 'bad-key': f.text({ label: 'T' }) }), { label: 'Items' }) }),
            ),
          ],
        },
        'custom.items.bad-key',
      )
    })

    it('fields without field metadata, at any depth', () => {
      rejects({ singletons: [withTemplate(z.object({ title: z.string() }))] }, 'custom.title')
      rejects(
        { singletons: [withTemplate(z.object({ box: f.group({ inner: z.string() }, { label: 'Box' }) }))] },
        'custom.box.inner',
      )
      const block = defineBlock({
        name: 'promo',
        label: 'Promo',
        schema: z.object({ cards: f.list(z.object({ title: z.string() }), { label: 'Cards' }) }),
      })
      rejects(
        { singletons: [withTemplate(z.object({ title: f.text({ label: 'T' }) }), { promo: { block } })] },
        'promo.cards.title',
      )
      expect(() =>
        buildRegistry(
          defineSite({
            locales: ['en'],
            defaultLocale: 'en',
            singletons: [withTemplate(z.object({ title: z.string() }))],
          }),
        ),
      ).toThrow(/f\.\*/)
    })

    it('refs to unknown collections', () => {
      rejects(
        { singletons: [withTemplate(z.object({ pick: f.ref('people', { label: 'Pick' }) }))] },
        '"people"',
      )
      rejects(
        { singletons: [page('home'), withTemplate(z.object({ pick: f.ref('home', { label: 'Pick' }) }))] },
        '"home"',
      )
    })

    it('bad collection routes', () => {
      for (const route of ['blog/:slug', '/blog', '/:slug/:slug']) {
        rejects(
          { collections: [defineCollection({ name: 'posts', label: 'Posts', template: Post, route })] },
          `"${route}"`,
        )
      }
    })

    it('a singleton path map without the default locale', () => {
      rejects({ singletons: [page('about', { path: { es: '/acerca' } })] }, '"about"')
    })

    it('shipped content in a locale the site does not have', () => {
      const content = { fields: { title: 'x', body: 'x' } }
      rejects({ singletons: [page('about')], content: [defineContent('about', { edition: 1, content: { fr: content } })] }, '"fr"')
      rejects(
        {
          globals: [defineGlobal({ name: 'footer', label: 'Footer', template: BasicPage })],
          content: [defineContent('footer', { edition: 1, content: { en: content, de: content } })],
        },
        '"de"',
      )
      rejects(
        {
          collections: [defineCollection({ name: 'pages', label: 'Pages', template: BasicPage })],
          content: [defineEntries('pages', [{ key: 'one', edition: 1, content: { en: content, fr: content } }])],
        },
        '"fr"',
      )
    })

    it('a titleField that is not a text field of the template', () => {
      rejects(
        { collections: [defineCollection({ name: 'quotes', label: 'Quotes', template: Testimonial })] },
        '"title"',
      )
      rejects(
        {
          collections: [
            defineCollection({ name: 'quotes', label: 'Quotes', template: Testimonial, titleField: 'quote' }),
          ],
        },
        '"quote"',
      )
    })

    it('refuses an inline-text field as a collection titleField', () => {
      const Story = defineTemplate({
        name: 'story',
        fields: z.object({ headline: f.inlineText({ label: 'Headline' }) }),
      })
      const build = () =>
        buildRegistry(
          defineSite({
            locales: ['en'],
            defaultLocale: 'en',
            collections: [defineCollection({ name: 'stories', label: 'Stories', template: Story, titleField: 'headline' })],
          }),
        )
      expect(build).toThrow(InlayError)
      expect(build).toThrow(expect.objectContaining({ messageId: 'definition.titleField' }))
    })
  })
})

describe('definition types', () => {
  it('infers block render props from the schema', () => {
    const block = defineBlock({
      name: 'typed',
      label: 'Typed',
      schema: z.object({
        headline: f.text({ label: 'Headline' }),
        count: f.number({ label: 'Count' }).optional(),
        variant: f.select(['a', 'b'], { label: 'Variant' }).default('a'),
        shown: f.boolean({ label: 'Shown' }),
      }),
      render: (p) => {
        expectTypeOf(p.headline).toEqualTypeOf<string>()
        expectTypeOf(p.count).toEqualTypeOf<number | undefined>()
        expectTypeOf(p.variant).toEqualTypeOf<'a' | 'b'>()
        expectTypeOf(p.shown).toEqualTypeOf<boolean>()
        // @ts-expect-error not a field of the schema
        void p.nope
        return p.headline
      },
    })
    expect(block.render?.({ headline: 'Hi', variant: 'a', shown: false }, {} as RenderContext)).toBe('Hi')
  })

  it('infers template render fields from the schema', () => {
    defineTemplate({
      name: 'typed',
      fields: z.object({ title: f.text({ label: 'Title' }) }),
      slots: { hero: { block: Hero } },
      render: (p) => {
        expectTypeOf(p.fields.title).toEqualTypeOf<string>()
        expectTypeOf(p.slots).toHaveProperty('hero')
        return ''
      },
    })
  })
})


describe('shipped content', () => {
  const home = (patch: Partial<Parameters<typeof defineContent>[1]> = {}) =>
    defineContent('home', { edition: 1, content: { en: { fields: { title: 'Home' } } }, ...patch })
  const entry = (key: string, edition = 1) => ({ key, edition, content: { en: { fields: {} } } })
  const ship = (...content: ReturnType<typeof defineContent>[]) => ({ ...site, content })
  const bad = (content: ReturnType<typeof defineContent>[], text: string) => rejects(ship(...content), text)

  it('collects shipped documents by type, keyed by the type name for singletons', () => {
    const registry = buildRegistry(
      defineSite(
        ship(home(), defineEntries('testimonials', [{ key: 'maria', edition: 1, content: { en: { fields: { quote: 'Yes' } } } }])),
      ),
    )
    expect(registry.content.get('home')).toEqual([
      { key: 'home', edition: 1, content: { en: { fields: { title: 'Home' } } } },
    ])
    expect(registry.content.get('testimonials')?.[0]?.key).toBe('maria')
  })
  it('rejects an unknown type', () => bad([defineContent('team', { edition: 1, content: { en: {} } })], 'team'))
  it('rejects defineContent on a collection', () =>
    bad([defineContent('testimonials', { edition: 1, content: { en: {} } })], 'defineEntries'))
  it('rejects defineEntries on a singleton', () => bad([defineEntries('home', [entry('home')])], 'defineContent'))
  it('rejects shipping one type twice', () => bad([home(), home()], 'twice'))
  it('rejects a key that is not lowercase letters, digits and hyphens', () =>
    bad([defineEntries('testimonials', [entry('Maria Lopez')])], 'Maria Lopez'))
  it('rejects a duplicate key', () => bad([defineEntries('testimonials', [entry('a'), entry('a')])], '"a"'))
  it('rejects an edition that is not a whole number from 1', () => {
    bad([home({ edition: 0 })], '0')
    bad([home({ edition: 1.5 })], '1.5')
  })
  it('rejects a locale the site does not have', () => bad([home({ content: { fr: {} } })], 'fr'))
  it('rejects a document with no locales', () => bad([home({ content: {} })], 'home'))
  it('defaults content to an empty list', () =>
    expect(buildRegistry(defineSite({ locales: ['en'], defaultLocale: 'en' })).content.size).toBe(0))
  it('a camelCase singleton ships under its type name', () =>
    expect(() => buildRegistry(defineSite({ ...site, content: [defineContent('notFound', { edition: 1, content: { en: { fields: { title: 'Lost', body: 'x' } } } })] }))).not.toThrow())
})

describe('site settings', () => {
  it('fills defaults', () => {
    const r = buildRegistry(defineSite({ locales: ['en'], defaultLocale: 'en', singletons: [], collections: [], globals: [] }))
    expect(r.site).toMatchObject({ admin: {}, notFound: null, publicPaths: [], secrets: [], headers: {}, routes: [], migrations: [] })
  })
  it('has no site folder unless one is given', () => {
    const def = defineSite({ locales: ['en'], defaultLocale: 'en' })
    expect(buildRegistry(def).siteDir).toBeNull()
    expect(buildRegistry({ ...def, siteDir: 'file:///x/' }).siteDir).toBe('file:///x/')
  })
  it('accepts a path-less singleton with a render function as notFound', () =>
    expect(() => buildRegistry(defineSite({ ...site, notFound: 'notFound' }))).not.toThrow())
  it('rejects a notFound that is not a path-less singleton', () => {
    rejects({ ...site, notFound: 'about' }, 'about')
    rejects({ ...site, notFound: 'nope' }, 'nope')
  })
  it('rejects a notFound whose template has no render function', () => {
    const bare = defineTemplate({ name: 'bare', fields: z.object({ title: f.text({ label: 'Title' }) }) })
    rejects({ ...site, singletons: [...site.singletons, page('lost', { template: bare, path: null })], notFound: 'lost' }, 'lost')
  })
  it('rejects an admin theme Inlay does not have', () => {
    expect(() => buildRegistry(defineSite({ ...site, admin: { theme: 'nope' } }))).toThrow(
      expect.objectContaining({ code: 'config', messageId: 'config.adminTheme', params: { value: 'nope' } }),
    )
    expect(() => buildRegistry(defineSite({ ...site, admin: { theme: 'dark' } }))).not.toThrow()
  })
  it('rejects a public path without a leading slash', () => rejects({ ...site, publicPaths: ['pricing'] }, 'pricing'))
  it('rejects a secret name that is not UPPER_SNAKE', () => rejects({ ...site, secrets: ['slack-webhook'] }, 'slack-webhook'))
  it('rejects a duplicate secret name', () => rejects({ ...site, secrets: ['A', 'A'] }, '"A"'))
  it('accepts declared secrets and public paths', () =>
    expect(() => buildRegistry(defineSite({ ...site, secrets: ['HOOK_TOKEN', 'A'], publicPaths: ['/healthz'] }))).not.toThrow())
  it('rejects a header name that is not a valid token', () => rejects({ ...site, headers: { 'x frame': 'DENY' } }, 'x frame'))
  it('rejects a header Inlay sets itself', () => rejects({ ...site, headers: { 'Cache-Control': 'no-store' } }, 'Cache-Control'))
  it('rejects a header listed twice in different case', () =>
    rejects({ ...site, headers: { 'X-Frame-Options': 'DENY', 'x-frame-options': 'DENY' } }, 'x-frame-options'))
  it('rejects a header value with a line break', () =>
    rejects({ ...site, headers: { 'permissions-policy': 'camera=()\r\nset-cookie: a=1' } }, 'permissions-policy'))
  it('accepts headers, and false to leave a default out', () =>
    expect(() =>
      buildRegistry(defineSite({ ...site, headers: { 'Permissions-Policy': 'camera=()', 'strict-transport-security': false } })),
    ).not.toThrow())
})

describe('routes', () => {
  const route = (path: string, method: 'GET' | 'POST' = 'POST') => defineRoute({ method, path, handler: () => ({}) })
  const withRoutes = (...routes: ReturnType<typeof route>[]) => ({ ...site, routes })
  const refusal = (input: Partial<SiteInput>) => {
    try {
      buildRegistry(defineSite({ locales: ['en', 'es'], defaultLocale: 'en', ...input }))
    } catch (e) {
      return { code: (e as InlayError).code, messageId: (e as InlayError).messageId, params: (e as InlayError).params }
    }
    return null
  }

  it('accepts routes that shadow nothing', () => {
    const r = buildRegistry(defineSite(withRoutes(route('/contact'), route('/contact', 'GET'), route('/api/latest', 'GET'), route('/blog'))))
    expect(r.site.routes.map((x) => `${x.method} ${x.path}`)).toEqual(['POST /contact', 'GET /contact', 'GET /api/latest', 'POST /blog'])
  })

  it('accepts sitemap: true on a GET route', () => {
    const r = buildRegistry(defineSite(withRoutes(defineRoute({ method: 'GET', path: '/calc', sitemap: true, handler: () => ({}) }))))
    expect(r.site.routes[0]?.sitemap).toBe(true)
  })

  it('refuses sitemap: true on a POST route', () => {
    const post = defineRoute({ method: 'POST', path: '/contact', sitemap: true, handler: () => ({}) })
    expect(refusal(withRoutes(post))).toMatchObject({
      code: 'definition',
      messageId: 'definition.routeSitemap',
      params: { method: 'POST', path: '/contact' },
    })
  })

  it('defineRoute returns the definition', () => {
    const def = { method: 'GET' as const, path: '/x', handler: () => ({}) }
    expect(defineRoute(def)).toEqual(def)
  })

  it('refuses a route at a translated singleton path', () => {
    expect(refusal(withRoutes(route('/acerca')))).toMatchObject({
      code: 'definition',
      messageId: 'definition.routeShadows',
      params: { path: '/acerca', name: 'about' },
    })
    expect(refusal(withRoutes(route('/es/acerca')))).toMatchObject({ messageId: 'definition.routeShadows' })
    expect(refusal(withRoutes(route('/about')))).toMatchObject({ messageId: 'definition.routeShadows', params: { name: 'about' } })
    expect(refusal(withRoutes(route('/es')))).toMatchObject({ messageId: 'definition.routeShadows', params: { name: 'home' } })
  })

  it('refuses a route under a collection route', () => {
    expect(refusal(withRoutes(route('/blog/x')))).toMatchObject({
      messageId: 'definition.routeShadows',
      params: { path: '/blog/x', name: 'posts' },
    })
    expect(refusal(withRoutes(route('/es/blog/x', 'GET')))).toMatchObject({ messageId: 'definition.routeShadows' })
  })

  it('refuses reserved paths', () => {
    for (const path of ['/admin/x', '/public/a.css', '/public', '/mcp', '/robots.txt', '/sitemap.xml', '/api/auth/x', '/media/x', '/_inlay/unlock', '/.well-known/x', '/']) {
      expect(refusal(withRoutes(route(path))), path).toMatchObject({ messageId: 'definition.routeReserved', params: { path } })
    }
  })

  it('refuses a method other than GET or POST', () => {
    for (const method of ['PUT', 'DELETE', 'get', 'HEAD']) {
      const bad = defineRoute({ method: method as 'GET', path: '/contact', handler: () => ({}) })
      expect(refusal(withRoutes(bad)), method).toMatchObject({
        messageId: 'definition.routeMethod',
        params: { method, path: '/contact' },
      })
    }
  })

  it('refuses duplicates and bad paths', () => {
    expect(refusal(withRoutes(route('/contact'), route('/contact')))).toMatchObject({
      messageId: 'definition.routeDuplicate',
      params: { method: 'POST', path: '/contact' },
    })
    for (const path of ['contact', '/contact/', '/a//b', '/a/./b', '/a/../b', '/users/:id', '/files/*', '/a?b', '/a#b', '/a%20b', '']) {
      expect(refusal(withRoutes(route(path))), path).toMatchObject({ messageId: 'definition.routePath', params: { path } })
    }
  })
})

describe('code redirects', () => {
  const redirect = (from: string, to = '/about', status?: 301 | 302) => ({ from, to, ...(status ? { status } : {}) })
  const refusal = (input: Partial<SiteInput>) => {
    try {
      buildRegistry(defineSite({ locales: ['en', 'es'], defaultLocale: 'en', ...input }))
    } catch (e) {
      return { code: (e as InlayError).code, messageId: (e as InlayError).messageId, params: (e as InlayError).params }
    }
    return null
  }
  const withRedirects = (...redirects: Array<{ from: string; to: string; status?: 301 | 302 }>) => ({ ...site, redirects })

  it('normalizes code rules and keeps their order', () => {
    const r = buildRegistry(
      defineSite(
        withRedirects(
          { from: 'https://old.example.com/About-Us/', to: '/about' },
          { from: '/caf%C3%A9', to: 'HTTPS://Example.com/x', status: 302 },
          { from: '/blog/:slug', to: '/:slug' },
        ),
      ),
    )
    expect(r.redirects).toEqual([
      { from: '/About-Us', to: '/about', status: 301 },
      { from: '/café', to: 'https://example.com/x', status: 302 },
      { from: '/blog/:slug', to: '/:slug', status: 301 },
    ])
    expect(r.redirectIndex.exact.get('/About-Us')).toEqual({ from: '/About-Us', to_path: '/about', to_group_id: null, status: 301 })
  })

  it('collects the GET route paths', () => {
    const post = defineRoute({ method: 'POST', path: '/contact', handler: () => ({}) })
    const get = defineRoute({ method: 'GET', path: '/echo', handler: () => ({}) })
    expect([...buildRegistry(defineSite({ ...site, routes: [post, get] })).getRoutePaths]).toEqual(['/echo'])
  })

  it('accepts a rule a /:slug collection could match', () => {
    expect(() => buildRegistry(rootSite([{ from: '/old-post', to: '/blog' }]))).not.toThrow()
  })

  it('refuses malformed rules', () => {
    const cases: Array<[Parameters<typeof redirect>, string, Record<string, unknown>?]> = [
      [['/admin/x'], 'definition.redirectFrom', { from: '/admin/x' }],
      [['/en/x'], 'definition.redirectFrom'],
      [['/a/:x/:x'], 'definition.redirectFrom'],
      [[1 as unknown as string], 'definition.redirectFrom'],
      [['/a', 'about'], 'definition.redirectTo'],
      [['/a', '/en/about'], 'definition.redirectTo'],
      [['/a', '/EN/about'], 'definition.redirectTo'],
      [['/x', '/En'], 'definition.redirectTo'],
      [['/a', 'http://x.com/'], 'definition.redirectTo'],
      [['/a', '//evil.com'], 'definition.redirectTo'],
      [['/a/:x', '/:y'], 'definition.redirectParam', { name: 'y' }],
      [['/a/:x', 'https://x.com/:x'], 'definition.redirectUrlParam', { from: '/a/:x', name: 'x' }],
      [['/a', '/b', 307 as 301], 'definition.redirectStatus'],
    ]
    for (const [args, messageId, params] of cases) {
      expect(refusal(withRedirects(redirect(...args))), messageId).toMatchObject({
        code: 'definition',
        messageId,
        ...(params ? { params } : {}),
      })
    }
  })

  it('refuses a from given twice', () => {
    expect(refusal(withRedirects(redirect('/a', '/b'), redirect('/a/', '/c')))).toMatchObject({
      messageId: 'definition.redirectDuplicate',
      params: { from: '/a' },
    })
  })

  it('refuses a rule on a GET route\'s path', () => {
    const route = defineRoute({ method: 'GET', path: '/contact', handler: () => ({}) })
    expect(refusal({ ...withRedirects(redirect('/contact')), routes: [route] })).toMatchObject({
      messageId: 'definition.redirectRoute',
      params: { from: '/contact' },
    })
  })

  it('allows a rule on a POST-only route\'s path', () => {
    const route = defineRoute({ method: 'POST', path: '/contact', handler: () => ({}) })
    const r = buildRegistry(defineSite({ ...withRedirects(redirect('/contact')), routes: [route] }))
    expect(r.redirects[0]?.from).toBe('/contact')
  })
})

describe('seo', () => {
  const refusal = (input: Partial<SiteInput>) => {
    try {
      buildRegistry(defineSite({ locales: ['en', 'es'], defaultLocale: 'en', ...input }))
    } catch (e) {
      return { code: (e as InlayError).code, messageId: (e as InlayError).messageId }
    }
    return null
  }
  const withDefaults = (name: string, key = 'defaults') =>
    defineGlobal({
      name,
      label: name,
      template: defineTemplate({ name: `${name}Template`, fields: z.object({ [key]: f.seoDefaults() }) }),
    })

  it('accepts code defaults', () => {
    const seo = { titleTemplate: '%s | Site', description: 'd', image: '/public/og.png' }
    expect(buildRegistry(defineSite({ ...site, seo })).site.seo).toEqual(seo)
  })

  it('refuses a title template without exactly one %s', () => {
    for (const titleTemplate of ['Site', '%s | %s']) {
      expect(refusal({ ...site, seo: { titleTemplate } })).toEqual({ code: 'definition', messageId: 'definition.seoTitleTemplate' })
    }
  })

  it('refuses a default image outside /public/', () => {
    for (const image of ['og.png', '/media/x', '/public/']) {
      expect(refusal({ ...site, seo: { image } })).toEqual({ code: 'definition', messageId: 'definition.seoImage' })
    }
  })

  it('finds the defaults global', () => {
    expect(buildRegistry(defineSite({ ...site, globals: [...site.globals, withDefaults('settings')] })).seoDefaults).toEqual({
      global: 'settings',
      field: 'defaults',
    })
    expect(buildRegistry(site).seoDefaults).toBeNull()
  })

  it('refuses f.seoDefaults() in two globals, or twice in one', () => {
    const twice = defineGlobal({
      name: 'both',
      label: 'both',
      template: defineTemplate({ name: 'bothTemplate', fields: z.object({ a: f.seoDefaults(), b: f.seoDefaults() }) }),
    })
    for (const globals of [[withDefaults('one'), withDefaults('two')], [twice]]) {
      expect(refusal({ ...site, globals })).toEqual({ code: 'definition', messageId: 'definition.seoDefaultsTwice' })
    }
  })

  it('refuses f.seoDefaults() inside a group, a list, a block or a non-global type', () => {
    const global = (fields: z.ZodObject, slots = {}) =>
      defineGlobal({ name: 'g', label: 'g', template: defineTemplate({ name: 'gt', fields, slots }) })
    const block = defineBlock({ name: 'seoBlock', label: 'B', schema: z.object({ d: f.seoDefaults() }) })
    const cases = [
      { ...site, globals: [global(z.object({ g: f.group({ d: f.seoDefaults() }, { label: 'G' }) }))] },
      { ...site, globals: [global(z.object({ l: f.list(f.group({ d: f.seoDefaults() }, { label: 'I' }), { label: 'L' }) }))] },
      { ...site, globals: [global(z.object({ l: f.list(f.seoDefaults(), { label: 'L' }) }))] },
      { ...site, globals: [global(z.object({}), { s: { block } })] },
      { ...site, singletons: [...site.singletons, withTemplate(z.object({ d: f.seoDefaults() }))] },
    ]
    for (const input of cases) {
      expect(refusal(input)).toEqual({ code: 'definition', messageId: 'definition.seoDefaultsPlace' })
    }
  })

  it('refuses an unknown ogType', () => {
    const template = defineTemplate({ name: 'blog', fields: z.object({}), ogType: 'blog' as never })
    expect(refusal({ ...site, singletons: [...site.singletons, page('blogPage', { template })] })).toEqual({
      code: 'definition',
      messageId: 'definition.ogType',
    })
  })
})

describe('integrations', () => {
  const ok = defineIntegration({ name: 'gtm', label: 'Tag Manager', head: () => null })
  const withIntegrations = (...integrations: ReturnType<typeof defineIntegration>[]) => ({ integrations })

  it('defaults', () => {
    expect(ok.kind).toBe('integration')
    expect(ok.preview).toBe(false)
    expect(ok.csp).toEqual({})
    const s = defineSite({ locales: ['en'], defaultLocale: 'en' })
    expect(s.integrations).toEqual([])
    expect(s.csp).toEqual({})
  })

  it('accepts a full integration', () => {
    const full = defineIntegration({
      name: 'tag-manager',
      label: 'Tag Manager',
      fields: z.object({ id: f.text({ label: 'ID' }), on: f.boolean({ label: 'On' }).optional() }),
      consent: 'marketing',
      csp: { 'script-src': ['https://www.googletagmanager.com', "'unsafe-inline'"], 'img-src': ['data:', 'https://*.example.com'] },
      head: () => null,
    })
    expect(() => buildRegistry(defineSite({ locales: ['en'], defaultLocale: 'en', integrations: [full], csp: { 'font-src': ['https://fonts.example'] } }))).not.toThrow()
  })

  it.each(['GTM', 'a b', ''])('rejects the name "%s"', (name) => {
    rejects(withIntegrations(defineIntegration({ name, label: 'X', head: () => null })), 'name')
  })

  it('rejects two with one name', () => {
    rejects(withIntegrations(ok, ok), 'gtm')
  })

  it('rejects a disallowed field kind', () => {
    for (const field of [f.richText({ label: 'R' }), f.image({ label: 'I' }), z.object({ a: f.text({ label: 'A' }) })]) {
      rejects(withIntegrations(defineIntegration({ name: 'gtm', label: 'X', fields: z.object({ field }), head: () => null })), 'gtm')
    }
  })

  it('rejects an integration with no render function', () => {
    rejects(withIntegrations(defineIntegration({ name: 'gtm', label: 'X' })), 'gtm')
  })

  it('rejects an unknown consent category', () => {
    rejects(withIntegrations(defineIntegration({ name: 'gtm', label: 'X', consent: 'ads' as never, head: () => null })), 'ads')
  })

  it('rejects an unknown directive', () => {
    const csp = { 'default-src': ['https://a.example'] } as never
    rejects(withIntegrations(defineIntegration({ name: 'gtm', label: 'X', csp, head: () => null })), 'default-src')
    rejects({ csp }, 'default-src')
  })

  it.each(['https://a.example; script-src *', 'https://a.example, https://b.example', 'https://a.example/path', 'https://A.example', 'https://a.example/', 'unsafe-inline', '*', ''])(
    'rejects the source %s',
    (source) => {
      rejects(withIntegrations(defineIntegration({ name: 'gtm', label: 'X', csp: { 'script-src': [source] }, head: () => null })), 'script-src')
      rejects({ csp: { 'img-src': [source] } }, 'img-src')
    },
  )

  it('rejects a source list given as a string', () => {
    const csp = { 'script-src': 'https://a.example' } as never
    for (const input of [withIntegrations(defineIntegration({ name: 'gtm', label: 'X', csp, head: () => null })), { csp }]) {
      try {
        buildRegistry(defineSite({ locales: ['en'], defaultLocale: 'en', ...input }))
        expect.unreachable()
      } catch (e) {
        expect((e as InlayError).messageId).toBe('definition.cspSource')
        expect((e as InlayError).message).toContain('script-src')
      }
    }
  })

  it('names the integration or the site in a source problem', () => {
    rejects(withIntegrations(defineIntegration({ name: 'gtm', label: 'X', csp: { 'script-src': ['*'] }, head: () => null })), 'The integration "gtm"')
    rejects({ csp: { 'script-src': ['*'] } }, 'The site')
  })

  it('rejects a field keyed enabled', () => {
    const fields = z.object({ enabled: f.boolean({ label: 'Enabled' }) })
    try {
      buildRegistry(defineSite({ locales: ['en'], defaultLocale: 'en', integrations: [defineIntegration({ name: 'gtm', label: 'X', fields, head: () => null })] }))
      expect.unreachable()
    } catch (e) {
      expect((e as InlayError).code).toBe('definition')
      expect((e as InlayError).messageId).toBe('definition.integrationFieldReserved')
      expect((e as InlayError).message).toContain('gtm')
    }
  })
})

describe('trailingSlash option', () => {
  it("defaults to 'never' and passes 'always' through", () => {
    expect(defineSite({ locales: ['en'], defaultLocale: 'en' }).trailingSlash).toBe('never')
    expect(defineSite({ locales: ['en'], defaultLocale: 'en', trailingSlash: 'always' }).trailingSlash).toBe('always')
  })
})
