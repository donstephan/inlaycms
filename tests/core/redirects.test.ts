import { collapseTargets, type RuleTarget } from '../../src/core/redirects/collapse.js'
import { InlayError } from '../../src/core/errors.js'
import { t } from '../../src/core/messages/index.js'
import type { IssueCode } from '../../src/core/types.js'
import { routedSite } from '../fixtures/routes.js'
import { makeCore } from '../helpers/core.js'

const fields = { title: 'Hello world', date: '2026-02-01', body: 'Hi' }

async function world() {
  const w = await makeCore({ site: routedSite() })
  await w.core.applyShippedContent()
  const about = (await w.core.findSingleton('about'))!
  return { ...w, aboutGroup: about.groupId }
}

async function issueOf(p: Promise<unknown>): Promise<{ code: IssueCode; path: unknown }> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(InlayError)
    const err = e as InlayError
    expect(err.code).toBe('validation')
    expect(err.messageId).toBe('error.redirectInvalid')
    const issue = err.details.issues?.[0]
    expect(issue).toBeDefined()
    return { code: issue!.code, path: issue!.path }
  }
  throw new Error('expected a rejection')
}

const to301 = (location: string) => ({ kind: 'redirect', location, status: 301 })

describe('collapseTargets', () => {
  const exact = new Map<string, { to: RuleTarget }>([
    ['/a', { to: { path: '/b' } }],
    ['/b', { to: { path: '/c' } }],
    ['/c', { to: { document: 'g1' } }],
    ['/x', { to: { path: '/y' } }],
    ['/y', { to: { path: '/x' } }],
  ])
  const always = () => true
  const one = (from: string, to: RuleTarget, canFollow: (p: string) => boolean | Promise<boolean> = always) =>
    collapseTargets(exact, [{ from, to }], canFollow).then(([end]) => end)

  it('follows exact path targets through exact rules to their end', async () => {
    expect(
      await collapseTargets(
        exact,
        [
          { from: '/old', to: { path: '/a' } },
          { from: '/old/:x', to: { path: '/b' } },
          { from: '/p/:x', to: { path: '/q/:x' } },
          { from: '/n', to: { path: '/none' } },
          { from: '/d', to: { document: 'g2' } },
        ],
        always,
      ),
    ).toEqual([{ document: 'g1' }, { document: 'g1' }, { path: '/q/:x' }, { path: '/none' }, { document: 'g2' }])
  })

  it('takes a hop only where it may be followed, and asks once per path', async () => {
    const asked: string[] = []
    const notB = (p: string) => (asked.push(p), p !== '/b')
    expect(
      await collapseTargets(
        exact,
        [
          { from: '/old', to: { path: '/a' } },
          { from: '/older', to: { path: '/a' } },
        ],
        notB,
      ),
    ).toEqual([{ path: '/b' }, { path: '/b' }])
    expect(asked).toEqual(['/a', '/b'])
    expect(await one('/old', { path: '/a' }, async (p) => p !== '/a')).toEqual({ path: '/a' })
  })

  it('stops before coming back round, leaving the loop to be found', async () => {
    expect(await one('/c', { path: '/a' })).toEqual({ path: '/b' })
    expect(await one('/b', { path: '/a' })).toEqual({ path: '/a' })
    expect(await one('/old', { path: '/x' })).toEqual({ path: '/y' })
  })
})

describe('redirects: matching', () => {
  it('redirects to a document in the request locale', async () => {
    const { core, owner, aboutGroup } = await world()
    await core.createRedirect({ from: '/old-about', to: { document: aboutGroup } }, owner)
    expect(await core.resolvePath('/old-about')).toEqual(to301('/about'))
    expect(await core.resolvePath('/es/old-about')).toEqual(to301('/es/acerca'))
    const [rule] = await core.listRedirects()
    expect(rule).toMatchObject({
      from: '/old-about',
      to: { document: aboutGroup },
      status: 301,
      source: 'manual',
      note: null,
      createdBy: 'Olivia Owner',
    })
  })

  it('matches patterns, with exact rules and pages first', async () => {
    const { core, owner } = await world()
    await core.createRedirect({ from: '/2019/:month/:slug', to: '/blog/:slug' }, owner)
    expect(await core.resolvePath('/2019/05/hello')).toEqual(to301('/blog/hello'))
    expect(await core.resolvePath('/es/2019/05/hello')).toEqual(to301('/es/blog/hello'))
    await core.createRedirect({ from: '/2019/05/special', to: '/about', status: 302 }, owner)
    expect(await core.resolvePath('/2019/05/special')).toEqual({ kind: 'redirect', location: '/about', status: 302 })
    await core.createRedirect({ from: '/:x', to: '/' }, owner)
    expect((await core.resolvePath('/about')).kind).toBe('page')
    expect(await core.resolvePath('/anything')).toEqual(to301('/'))
  })

  it('stores full-URL froms as paths and encodes locations', async () => {
    const { core, owner } = await world()
    await core.createRedirect({ from: 'https://old.example.com/page/', to: '/café' }, owner)
    const [rule] = await core.listRedirects()
    expect(rule).toMatchObject({ from: '/page', to: { path: '/café' } })
    expect(await core.resolvePath('/page')).toEqual(to301('/caf%C3%A9'))
  })

  it('skips a document target that is not live', async () => {
    const { core, owner } = await world()
    const post = await core.createEntry('posts', { fields }, owner)
    await core.createRedirect({ from: '/draft', to: { document: post.groupId } }, owner)
    expect(await core.resolvePath('/draft')).toEqual({ kind: 'not_found', locale: 'en' })
    expect(await core.resolvePath('/draft', { state: 'preview' })).toEqual(to301('/blog/hello-world'))
  })
})

describe('redirects: rejections', () => {
  it('rejects a from that is a published page', async () => {
    const { core, owner } = await world()
    expect(await issueOf(core.createRedirect({ from: '/about', to: '/' }, owner))).toEqual({
      code: 'path_taken',
      path: ['from'],
    })
    expect((await issueOf(core.createRedirect({ from: '/acerca', to: '/' }, owner))).code).toBe('path_taken')
  })

  it('rejects a from that already has a rule', async () => {
    const { core, owner } = await world()
    await core.createRedirect({ from: '/old', to: '/' }, owner)
    expect(await issueOf(core.createRedirect({ from: '/old/', to: '/about' }, owner))).toEqual({
      code: 'path_taken',
      path: ['from'],
    })
  })

  it('rejects reserved, unclean and query froms', async () => {
    const { core, owner } = await world()
    for (const from of ['/admin/x', '/p?id=1', 'old', '//evil.com', '/a/../b']) {
      expect(await issueOf(core.createRedirect({ from, to: '/' }, owner))).toEqual({ code: 'invalid', path: ['from'] })
    }
  })

  it('rejects a from with the default-locale prefix, which could never fire', async () => {
    const { core, owner } = await world()
    for (const from of ['/en/old-page', '/en', 'https://old.example.com/en/x']) {
      expect(await issueOf(core.createRedirect({ from, to: '/' }, owner))).toEqual({ code: 'invalid', path: ['from'] })
    }
    await expect(core.importRedirects('/en/old-page,/\n', owner)).rejects.toMatchObject({
      messageId: 'error.redirectImportFailed',
      details: { lines: [{ line: 1 }] },
    })
    await core.createRedirect({ from: '/es/old-page', to: '/' }, owner)
    await core.createRedirect({ from: '/english', to: '/' }, owner)
  })

  it('rejects bad targets and statuses', async () => {
    const { core, owner } = await world()
    expect(await issueOf(core.createRedirect({ from: '/2019/:month', to: '/blog/:slug' }, owner))).toEqual({
      code: 'invalid',
      path: ['to'],
    })
    expect(await issueOf(core.createRedirect({ from: '/x', to: 'mailto:x@x.com' }, owner))).toEqual({
      code: 'invalid',
      path: ['to'],
    })
    const status = 303 as unknown as 301
    expect(await issueOf(core.createRedirect({ from: '/x', to: '/', status }, owner))).toEqual({
      code: 'invalid',
      path: ['status'],
    })
  })

  it('checks document targets like link fields', async () => {
    const { core, owner } = await world()
    const nf = (await core.findSingleton('notFound'))!
    expect(await issueOf(core.createRedirect({ from: '/x', to: { document: nf.groupId } }, owner))).toEqual({
      code: 'not_routable',
      path: ['to'],
    })
    expect(await issueOf(core.createRedirect({ from: '/x', to: { document: 'nope' } }, owner))).toEqual({
      code: 'not_found',
      path: ['to'],
    })
  })
})

describe('redirects: chains', () => {
  it('collapses chains and rejects loops', async () => {
    const { core, owner } = await world()
    await core.createRedirect({ from: '/a', to: '/b' }, owner)
    await core.createRedirect({ from: '/b', to: '/c' }, owner)
    expect((await core.listRedirects()).map((r) => [r.from, r.to])).toEqual([
      ['/a', { path: '/c' }],
      ['/b', { path: '/c' }],
    ])
    expect(await core.resolvePath('/a')).toEqual(to301('/c'))
    expect(await issueOf(core.createRedirect({ from: '/c', to: '/a' }, owner))).toEqual({
      code: 'redirect_loop',
      path: ['to'],
    })
    expect((await issueOf(core.createRedirect({ from: '/x', to: '/x' }, owner))).code).toBe('redirect_loop')
    expect(await core.listRedirects()).toHaveLength(2)
  })

  it('follows a new rule to its end', async () => {
    const { core, owner, aboutGroup } = await world()
    await core.createRedirect({ from: '/b', to: { document: aboutGroup } }, owner)
    await core.createRedirect({ from: '/a', to: '/b' }, owner)
    expect((await core.listRedirects()).find((r) => r.from === '/a')?.to).toEqual({ document: aboutGroup })
  })
})

describe('redirects: chains through patterns', () => {
  const toOf = async (core: Awaited<ReturnType<typeof world>>['core'], from: string) =>
    (await core.listRedirects()).find((r) => r.from === from)?.to

  it('rejects loops through pattern rules', async () => {
    const { core, owner } = await world()
    await core.createRedirect({ from: '/a/:x', to: '/b/:x' }, owner)
    expect(await issueOf(core.createRedirect({ from: '/b/:x', to: '/a/:x' }, owner))).toEqual({
      code: 'redirect_loop',
      path: ['to'],
    })
    expect((await issueOf(core.createRedirect({ from: '/b/1', to: '/a/1' }, owner))).code).toBe('redirect_loop')
    expect((await issueOf(core.createRedirect({ from: '/s/:x', to: '/s/:x' }, owner))).code).toBe('redirect_loop')
    await core.createRedirect({ from: '/c/1', to: '/d/1' }, owner)
    expect((await issueOf(core.createRedirect({ from: '/d/:x', to: '/c/:x' }, owner))).code).toBe('redirect_loop')
    expect((await core.listRedirects()).map((r) => r.from)).toEqual(['/a/:x', '/c/1'])
  })

  it('collapses only through exact rules, never pattern rules', async () => {
    const { core, owner, aboutGroup } = await world()
    await core.createRedirect({ from: '/a/:x', to: '/b/:x' }, owner)
    await core.createRedirect({ from: '/c', to: '/a/1' }, owner)
    expect(await toOf(core, '/c')).toEqual({ path: '/a/1' })
    expect(await core.resolvePath('/c')).toEqual(to301('/a/1'))
    expect(await core.resolvePath('/a/1')).toEqual(to301('/b/1'))

    await core.createRedirect({ from: '/d', to: '/e/1' }, owner)
    await core.createRedirect({ from: '/e/:x', to: { document: aboutGroup } }, owner)
    expect(await toOf(core, '/d')).toEqual({ path: '/e/1' })

    await core.createRedirect({ from: '/old/:x', to: '/d' }, owner)
    expect(await toOf(core, '/old/:x')).toEqual({ path: '/e/1' })
    expect(await toOf(core, '/a/:x')).toEqual({ path: '/b/:x' })
  })

  it('stops a chain at a published page', async () => {
    const { core, owner } = await world()
    await core.createRedirect({ from: '/:x', to: '/' }, owner)
    await core.createRedirect({ from: '/f', to: '/about' }, owner)
    expect(await toOf(core, '/f')).toEqual({ path: '/about' })
    expect(await core.resolvePath('/f')).toEqual(to301('/about'))
  })

  it('finds pattern loops on import', async () => {
    const { core, owner } = await world()
    await core.createRedirect({ from: '/a/:x', to: '/b/:x' }, owner)
    await expect(core.importRedirects('/x,/\n/b/:x,/a/:x\n', owner)).rejects.toMatchObject({
      messageId: 'error.redirectImportFailed',
      details: { lines: [{ line: 2 }] },
    })
    await core.createRedirect({ from: '/c/1', to: '/d/1' }, owner)
    await expect(core.importRedirects('/d/:x,/c/:x\n', owner)).rejects.toMatchObject({
      details: { lines: [{ line: 1 }] },
    })
    expect(await core.importRedirects('/e,/a/2\n', owner)).toEqual({ created: 1, updated: 0 })
    expect(await toOf(core, '/e')).toEqual({ path: '/a/2' })
  })
})

describe('redirects: external targets', () => {
  const G2 = 'https://www.g2.com/products/example/reviews'

  it('stores and serves an https target', async () => {
    const { core, owner } = await world()
    await core.createRedirect({ from: '/g2', to: G2 }, owner)
    expect((await core.listRedirects())[0]!.to).toEqual({ url: G2 })
    expect(await core.resolvePath('/g2')).toEqual({ kind: 'redirect', location: G2, status: 301, external: true })
  })

  it('refuses other schemes, protocol-relative and credentialed targets', async () => {
    const { core, owner } = await world()
    const field = t('label.redirect.to')
    for (const [to, messageId] of [
      ['http://example.com/', 'issue.redirectUrl'],
      ['javascript:alert(1)', 'issue.redirectUrl'],
      ['ftp://example.com/x', 'issue.redirectUrl'],
      ['https://user:pw@example.com/', 'issue.redirectUrl'],
      ['//example.com/x', 'issue.redirectTo'],
    ] as const) {
      const p = core.createRedirect({ from: '/x', to }, owner)
      expect(await issueOf(p)).toEqual({ code: 'invalid', path: ['to'] })
      const err = (await p.catch((e: unknown) => e)) as InlayError
      expect(err.details.issues?.[0]?.message, to).toBe(t(messageId, { field, path: to }))
    }
  })

  it('refuses :name segments in the URL of a pattern rule', async () => {
    const { core, owner } = await world()
    expect(
      await issueOf(core.createRedirect({ from: '/old/:slug', to: 'https://example.com/:slug' }, owner)),
    ).toEqual({ code: 'invalid', path: ['to'] })
  })

  it('never collapses into an external target', async () => {
    const first = await world()
    await first.core.createRedirect({ from: '/b', to: G2 }, first.owner)
    await first.core.createRedirect({ from: '/a', to: '/b' }, first.owner)
    expect((await first.core.listRedirects()).find((r) => r.from === '/a')!.to).toEqual({ path: '/b' })

    const second = await world()
    await second.core.createRedirect({ from: '/a', to: '/b' }, second.owner)
    await second.core.createRedirect({ from: '/b', to: G2 }, second.owner)
    expect((await second.core.listRedirects()).find((r) => r.from === '/a')!.to).toEqual({ path: '/b' })
  })

  it('imports URL targets from CSV', async () => {
    const { core, owner } = await world()
    expect(await core.importRedirects('from,to\n/g2,https://www.g2.com/x\n', owner)).toEqual({ created: 1, updated: 0 })
    expect((await core.listRedirects())[0]!.to).toEqual({ url: 'https://www.g2.com/x' })
  })
})

describe('redirects: review regressions', () => {
  const list = async (core: Awaited<ReturnType<typeof world>>['core']) =>
    (await core.listRedirects()).map((r) => [r.from, r.to])

  it('I1: rejects a to with the default-locale prefix, which would loop back', async () => {
    const { core, owner } = await world()
    for (const [from, to] of [
      ['/old', '/en/old'],
      ['/old', '/en'],
      ['/old/:x', '/en/old/:x'],
      ['/q', '/EN/q'],
      ['/old', '/En'],
    ] as const) {
      expect(await issueOf(core.createRedirect({ from, to }, owner))).toEqual({ code: 'invalid', path: ['to'] })
    }
    const err = await core.importRedirects('/fine,/about\n/old,/en/old\n', owner).catch((e: unknown) => e)
    expect(err).toMatchObject({ messageId: 'error.redirectImportFailed', details: { lines: [{ line: 2 }] } })
    expect((err as InlayError).details.lines?.[0]?.message).toMatch(/^Line 2: .*"\/en"/)
    await core.createRedirect({ from: '/old', to: '/english' }, owner)
    await core.createRedirect({ from: '/old2', to: '/es/old' }, owner)
    expect(await list(core)).toEqual([
      ['/old', { path: '/english' }],
      ['/old2', { path: '/es/old' }],
    ])
  })

  it('I3: a page at the from of a stored rule ends a chain and is no loop', async () => {
    const { core, owner } = await world()
    await core.createRedirect({ from: '/b', to: '/c' }, owner)
    const p = await core.createEntry('posts', { fields, path: '/b' }, owner)
    await core.publish([p.id], owner)
    await core.createRedirect({ from: '/a', to: '/b' }, owner)
    await core.createRedirect({ from: '/c', to: '/b' }, owner)
    expect(await list(core)).toEqual([
      ['/a', { path: '/b' }],
      ['/b', { path: '/c' }],
      ['/c', { path: '/b' }],
    ])
    expect(await core.resolvePath('/a')).toEqual(to301('/b'))
    expect((await core.resolvePath('/b')).kind).toBe('page')
  })

  it('I3: a pattern URL that redirects to a custom path ends a chain', async () => {
    const { core, owner } = await world()
    const p = await core.createEntry('posts', { fields, slug: 'x', path: '/custom' }, owner)
    await core.publish([p.id], owner)
    expect(await core.resolvePath('/blog/x')).toEqual(to301('/custom'))
    await core.createRedirect({ from: '/blog/x', to: '/elsewhere' }, owner)
    await core.createRedirect({ from: '/elsewhere', to: '/blog/x' }, owner)
    expect(await list(core)).toEqual([
      ['/blog/x', { path: '/elsewhere' }],
      ['/elsewhere', { path: '/blog/x' }],
    ])
  })

  it('M2: gives each param its own sample value', async () => {
    const { core, owner } = await world()
    await core.createRedirect({ from: '/r/:a/:b', to: '/r/:a/:a' }, owner)
    expect(await core.resolvePath('/r/1/2')).toEqual(to301('/r/1/1'))
    expect(await core.resolvePath('/r/1/1')).toEqual({ kind: 'not_found', locale: 'en' })
    expect((await issueOf(core.createRedirect({ from: '/s/:a/:b', to: '/s/:b/:a' }, owner))).code).toBe('redirect_loop')
  })

  it('M2: allows a chain of up to 32 hops and blames only the new rule beyond that', async () => {
    const { core, owner } = await world()
    for (let i = 32; i >= 1; i--) await core.createRedirect({ from: `/h${i}/:x`, to: `/h${i + 1}/:x` }, owner)
    expect(await core.resolvePath('/h1/a')).toEqual(to301('/h2/a'))
    expect(await issueOf(core.createRedirect({ from: '/h0/:x', to: '/h1/:x' }, owner))).toEqual({
      code: 'redirect_loop',
      path: ['to'],
    })
    const rows = Array.from({ length: 34 }, (_, i) => `/k${i + 1}/:x,/k${i + 2}/:x`).join('\n')
    const err = (await core.importRedirects(rows, owner).catch((e: unknown) => e)) as InlayError
    expect(err.details.lines?.map((l) => l.line)).toEqual([1, 2])
  })

  it('M2: matches equal-param patterns by id on import, with an updated rule in its place', async () => {
    const { core, owner } = await world()
    await core.createRedirect({ from: '/m/:x', to: '/a/:x' }, owner)
    await core.createRedirect({ from: '/:y/k', to: '/' }, owner)
    await core.createRedirect({ from: '/z/k', to: '/m/k' }, owner)
    expect(await core.resolvePath('/m/k')).toEqual(to301('/a/k'))
    const err = (await core.importRedirects('/m/:x,/z/:x\n', owner).catch((e: unknown) => e)) as InlayError
    expect(err).toMatchObject({ messageId: 'error.redirectImportFailed', details: { lines: [{ line: 1 }] } })
    expect(await core.resolvePath('/m/k')).toEqual(to301('/a/k'))
  })

  it('I4: matches through the rule index in runtime order and writes only the rules it settles', async () => {
    const { core, owner } = await world()
    let csv = ''
    for (let i = 0; i < 1000; i++) csv += `/old/${i},/new/${i}\n/p${i}/:x,/q${i}/:x\n`
    expect(await core.importRedirects(csv, owner)).toEqual({ created: 2000, updated: 0 })
    await core.createRedirect({ from: '/:a/x', to: '/one' }, owner)
    await core.createRedirect({ from: '/m/:b', to: '/two' }, owner)
    expect(await core.resolvePath('/m/x')).toEqual(to301('/one'))
    expect(await core.resolvePath('/m/y')).toEqual(to301('/two'))
    expect(await core.resolvePath('/p7/x')).toEqual(to301('/q7/x'))
    expect(await core.resolvePath('/es/p7/x')).toEqual(to301('/es/q7/x'))
    await core.createRedirect({ from: '/:a/:b/:c', to: '/three' }, owner)
    expect(await core.resolvePath('/es/p7/x')).toEqual(to301('/three'))

    const before = await core.listRedirects()
    await core.createRedirect({ from: '/new/5', to: '/newest' }, owner)
    const after = await core.listRedirects()
    const changed = after.filter((r) => {
      const b = before.find((x) => x.id === r.id)
      return !b || JSON.stringify(b.to) !== JSON.stringify(r.to)
    })
    expect(changed.map((r) => [r.from, r.to])).toEqual([
      ['/new/5', { path: '/newest' }],
      ['/old/5', { path: '/newest' }],
    ])
  })
})

describe('redirects: locale-prefixed targets (review I3)', () => {
  it('never adds a second locale prefix to a target that names a locale', async () => {
    const { core, owner } = await world()
    await core.createRedirect({ from: '/promo', to: '/es/acerca' }, owner)
    expect(await core.resolvePath('/promo')).toEqual(to301('/es/acerca'))
    expect(await core.resolvePath('/es/promo')).toEqual(to301('/es/acerca'))
    await core.createRedirect({ from: '/old/:x', to: '/es/new/:x' }, owner)
    expect(await core.resolvePath('/es/old/a')).toEqual(to301('/es/new/a'))
    expect(await core.resolvePath('/es/old/a/b')).toEqual({ kind: 'not_found', locale: 'es' })
  })

  it('collapses through a prefixed target only where every locale lands in the same place', async () => {
    const { core, owner } = await world()
    await core.createRedirect({ from: '/es/es/t', to: '/x1' }, owner)
    await core.createRedirect({ from: '/es/t', to: '/u' }, owner)
    await core.createRedirect({ from: '/f', to: '/es/t' }, owner)
    await core.createRedirect({ from: '/es/v', to: '/es/w' }, owner)
    await core.createRedirect({ from: '/g', to: '/es/v' }, owner)
    expect((await core.listRedirects()).map((r) => [r.from, r.to])).toEqual([
      ['/es/es/t', { path: '/x1' }],
      ['/es/t', { path: '/u' }],
      ['/es/v', { path: '/es/w' }],
      ['/f', { path: '/es/t' }],
      ['/g', { path: '/es/w' }],
    ])
    expect(await core.resolvePath('/f')).toEqual(to301('/es/t'))
    expect(await core.resolvePath('/es/f')).toEqual(to301('/es/t'))
    expect(await core.resolvePath('/es/t')).toEqual(to301('/u'))
    expect(await core.resolvePath('/es/g')).toEqual(to301('/es/w'))
  })

  it('collapses into a document only in the locale the chain resolved it in', async () => {
    const { core, owner, aboutGroup } = await world()
    await core.createRedirect({ from: '/b', to: { document: aboutGroup } }, owner)
    await core.createRedirect({ from: '/es/a', to: '/b' }, owner)
    await core.createRedirect({ from: '/a', to: '/b' }, owner)
    const to = async (from: string) => (await core.listRedirects()).find((r) => r.from === from)?.to
    expect(await to('/es/a')).toEqual({ path: '/b' })
    expect(await to('/a')).toEqual({ document: aboutGroup })
    expect(await core.resolvePath('/es/a')).toEqual(to301('/b'))
    expect(await core.resolvePath('/b')).toEqual(to301('/about'))
  })
})

describe('redirects: runtime loop guard', () => {
  type World = Awaited<ReturnType<typeof world>>

  /** Creates rules in order, skipping any the write-time check rejects as a loop. */
  async function create(w: World, rules: Array<[string, string]>) {
    for (const [from, to] of rules) {
      try {
        await w.core.createRedirect({ from, to }, w.owner)
      } catch (e) {
        expect((e as InlayError).details.issues?.[0]?.code).toBe('redirect_loop')
      }
    }
  }

  /** Follows redirects like a browser and fails if it is ever sent back to a path it has been to. */
  async function visit(core: World['core'], path: string, opts: { state?: 'preview' } = {}) {
    const seen = [path]
    for (;;) {
      const res = await core.resolvePath(path, opts)
      if (res.kind !== 'redirect') return res
      path = decodeURIComponent(res.location)
      expect(seen).not.toContain(path)
      seen.push(path)
    }
  }

  const p1: Array<{ rules: Array<[string, string]>; paths: string[] }> = [
    {
      rules: [
        ['/r/:y', '/p/:y'],
        ['/zzz', '/r/zzz'],
        ['/p/:x', '/:x'],
      ],
      paths: ['/p/zzz', '/zzz', '/r/zzz', '/es/p/zzz', '/es/zzz'],
    },
    {
      rules: [
        ['/a/:y', '/p/a/:y'],
        ['/p/:x/:z', '/:x/:z'],
      ],
      paths: ['/p/a/q', '/a/q', '/es/p/a/q', '/es/a/q'],
    },
    {
      rules: [
        ['/es/foo', '/x/es/foo'],
        ['/x/:l/:s', '/:l/:s'],
      ],
      paths: ['/x/es/foo', '/es/foo', '/x/en/foo', '/foo'],
    },
    {
      rules: [
        ['/foo', '/q/foo'],
        ['/q/:x', '/es/:x'],
      ],
      paths: ['/q/foo', '/es/q/foo', '/foo', '/es/foo'],
    },
  ]

  it.each(p1.flatMap((c, i) => [
    [`${i + 1}`, c.rules, c.paths],
    [`${i + 1} reversed`, [...c.rules].reverse(), c.paths],
  ]))('never sends a visitor round a pattern loop (p1 case %s)', async (_, rules, paths) => {
    const w = await world()
    await create(w, rules)
    for (const path of paths) await visit(w.core, path)
  })

  it('answers not_found with the rules of a loop the write-time check misses', async () => {
    const w = await world()
    await create(w, p1[0]!.rules)
    expect(await w.core.listRedirects()).toHaveLength(3)
    expect(await w.core.resolvePath('/p/zzz')).toEqual({ kind: 'not_found', locale: 'en', loop: ['/p/:x', '/zzz', '/r/:y'] })
    expect(await w.core.resolvePath('/es/p/zzz')).toMatchObject({ kind: 'not_found', locale: 'es' })

    await w.core.createRedirect({ from: '/:a/zzz', to: '/about' }, w.owner)
    expect(await w.core.resolvePath('/p/zzz')).toEqual(to301('/about'))
  })

  it('skips a loop through a document target that is not live (p3), and after unpublish', async () => {
    const w = await makeCore({ site: routedSite({ translationFallback: false }) })
    const { core, owner } = w
    await core.applyShippedContent()
    const p = await core.createEntry('posts', { fields, slug: 'hello' }, owner)
    await core.publish([p.id], owner)
    await core.createEntry('posts', { fields: { ...fields, title: 'Draft' }, slug: 'old' }, owner)
    await core.createRedirect({ from: '/blog/old', to: { document: p.groupId } }, owner)
    await core.createRedirect({ from: '/:a/:x', to: '/c/:a/:x' }, owner)
    await core.createRedirect({ from: '/c/:a/:y', to: '/blog/old' }, owner)
    expect(await core.resolvePath('/blog/old')).toEqual(to301('/blog/hello'))
    expect(await core.resolvePath('/es/blog/old')).toMatchObject({ kind: 'not_found', locale: 'es', loop: expect.arrayContaining(['/:a/:x', '/c/:a/:y']) })
    for (const path of ['/es/blog/old', '/es/c/blog/old', '/es/x/y']) await visit(core, path)

    await core.unpublish([p.id], owner)
    expect(await core.resolvePath('/blog/old')).toMatchObject({ kind: 'not_found', loop: expect.arrayContaining(['/:a/:x']) })
    for (const path of ['/blog/old', '/c/blog/old', '/x/y']) await visit(core, path)
  })

  it('refuses a delete that would expose a loop, and skips one exposed anyway (p4)', async () => {
    const w = await world()
    const e = await w.core.createRedirect({ from: '/a/b', to: '/somewhere' }, w.owner)
    await create(w, [
      ['/a/:x', '/z/b'],
      ['/z/:y', '/a/:y'],
    ])
    expect(await visit(w.core, '/a/q')).toEqual({ kind: 'not_found', locale: 'en' })
    await expect(w.core.deleteRedirect(e.id, w.owner)).rejects.toMatchObject({ code: 'conflict', messageId: 'error.redirectDeleteLoop' })
    expect((await w.core.listRedirects()).map((r) => r.from)).toContain('/a/b')
    await w.db.deleteFrom('redirects').where('id', '=', e.id).execute()
    expect(await w.core.resolvePath('/a/q')).toMatchObject({ kind: 'not_found', loop: ['/a/:x', '/z/:y'] })
    for (const path of ['/a/q', '/a/b', '/z/b', '/z/q']) await visit(w.core, path)
  })

  it('still redirects along a chain longer than the hop limit', async () => {
    const w = await world()
    for (let i = 0; i < 40; i++) await w.core.createRedirect({ from: `/h${i}/:x`, to: `/h${i + 1}/:x` }, w.owner)
    await w.core.createRedirect({ from: '/h40/:x', to: '/about' }, w.owner)
    expect(await w.core.resolvePath('/h0/a')).toEqual(to301('/h1/a'))
    expect((await visit(w.core, '/h0/a')).kind).toBe('page')
  })
})

describe('redirects: permissions and deletion', () => {
  it('lets editors create rules and deletes them', async () => {
    const { core, editor } = await world()
    const rule = await core.createRedirect({ from: '/old', to: '/', note: 'Old home' }, editor)
    expect(rule).toMatchObject({ createdBy: 'Eddie Editor', note: 'Old home' })
    await core.deleteRedirect(rule.id, editor)
    expect(await core.listRedirects()).toEqual([])
    expect(await core.resolvePath('/old')).toEqual({ kind: 'not_found', locale: 'en' })
    await expect(core.deleteRedirect(rule.id, editor)).rejects.toMatchObject({ code: 'not_found' })
  })
})
