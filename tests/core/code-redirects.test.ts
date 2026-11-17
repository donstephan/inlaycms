import type { Kysely } from 'kysely'
import type { Database } from '../../src/core/db/schema.js'
import { InlayError } from '../../src/core/errors.js'
import { defineSite, type SiteDefinition } from '../../src/core/registry/define.js'
import { defineRoute } from '../../src/core/registry/route.js'
import type { IssueCode } from '../../src/core/types.js'
import { redirectSite, rootSite } from '../fixtures/code-redirects.js'
import { webSite } from '../fixtures/web.js'
import { makeCore } from '../helpers/core.js'

const to301 = (location: string) => ({ kind: 'redirect', location, status: 301 })
const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Moved.' }] }] }

async function world(site: SiteDefinition = redirectSite) {
  const w = await makeCore({ site })
  await w.core.applyShippedContent()
  return w
}

/** Stores an admin rule without the write-time checks, as a rule saved under an earlier release would be. */
async function storeRule(db: Kysely<Database>, from: string, to: string) {
  await db
    .insertInto('redirects')
    .values({
      from_path: from,
      to_path: to,
      to_group_id: null,
      status: 301,
      source: 'manual',
      note: null,
      created_by_id: null,
      created_by_name: 'Test',
      created_at: '2026-01-01T00:00:00Z',
    })
    .execute()
}

describe('code redirects at request time', () => {
  it('fires on a one-segment path where five collections route at /:slug', async () => {
    const { core } = await world()
    expect(await core.resolvePath('/old-post')).toEqual(to301('/blog'))
    expect(await core.resolvePath('/es/old-post')).toEqual(to301('/es/blog'))
    expect(await core.resolvePath('/2019/hello')).toEqual(to301('/blog/hello'))
    expect(await core.resolvePath('/old-landing')).toEqual({ kind: 'redirect', location: '/', status: 302 })
  })

  it("a page published at the rule's from wins", async () => {
    const { core, owner } = await world()
    const entry = await core.createEntry('pages', { slug: 'old-post', fields: { title: 'Old post', body } }, owner)
    await core.publish([entry.id], owner)
    expect((await core.resolvePath('/old-post')).kind).toBe('page')
  })

  it('an admin rule with the same from wins, and deleting it brings the code rule back', async () => {
    const { core, owner } = await world()
    const rule = await core.createRedirect({ from: '/old-post', to: '/about' }, owner)
    expect(await core.resolvePath('/old-post')).toEqual(to301('/about'))
    await core.deleteRedirect(rule.id, owner)
    expect(await core.resolvePath('/old-post')).toEqual(to301('/blog'))
  })

  it('serves an external code rule', async () => {
    const { core } = await world()
    expect(await core.resolvePath('/g2')).toEqual({
      kind: 'redirect',
      location: 'https://www.g2.com/products/realciso/reviews',
      status: 301,
      external: true,
    })
  })

  it('skips a code rule that loops', async () => {
    const { core } = await world(
      rootSite([
        { from: '/a', to: '/b' },
        { from: '/b', to: '/a' },
      ]),
    )
    const res = await core.resolvePath('/a')
    expect(res).toMatchObject({ kind: 'not_found', locale: 'en' })
    expect(res.kind === 'not_found' ? res.loop : undefined).toEqual(expect.arrayContaining(['/a', '/b']))
  })

  it('treats a GET code route as answered when guarding against loops', async () => {
    const site = defineSite({
      ...webSite,
      routes: [defineRoute({ method: 'GET', path: '/echo', handler: () => ({ json: { ok: true } }) })],
      redirects: [{ from: '/a', to: '/echo' }],
    })
    const { core, db } = await world(site)
    await storeRule(db, '/echo', '/a')
    expect(await core.resolvePath('/a')).toEqual(to301('/echo'))
  })
})

async function issueOf(p: Promise<unknown>): Promise<IssueCode> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(InlayError)
    const code = (e as InlayError).details.issues?.[0]?.code
    expect(code).toBeDefined()
    return code!
  }
  throw new Error('expected a rejection')
}

describe('code redirects at write time', () => {
  it('refuses an admin rule that would loop with a code rule', async () => {
    const { core, owner } = await world(rootSite([{ from: '/y', to: '/x' }]))
    expect(await issueOf(core.createRedirect({ from: '/x', to: '/y' }, owner))).toBe('redirect_loop')
  })

  it('treats a GET code route as a stop when checking a write for loops', async () => {
    const site = defineSite({
      ...webSite,
      locales: ['en'],
      content: [],
      routes: [defineRoute({ method: 'GET', path: '/echo', handler: () => ({ json: { ok: true } }) })],
      redirects: [{ from: '/a', to: '/echo' }],
    })
    const { core, owner } = await world(site)
    const rule = await core.createRedirect({ from: '/echo', to: '/a' }, owner)
    expect(rule.to).toEqual({ path: '/a' })
    expect(await core.resolvePath('/a')).toEqual(to301('/echo'))
  })

  it('never collapses an admin rule through a code rule', async () => {
    const { core, owner } = await world()
    const rule = await core.createRedirect({ from: '/older', to: '/old-post' }, owner)
    expect(rule.to).toEqual({ path: '/old-post' })
    expect(await core.resolvePath('/older')).toEqual(to301('/old-post'))
  })
})

describe('listCodeRedirects', () => {
  it('lists code rules, marking the overridden and the hidden', async () => {
    const { core, owner } = await world()
    const flags = { overridden: false, hidden: false }
    expect(await core.listCodeRedirects()).toEqual([
      { from: '/old-post', to: { path: '/blog' }, status: 301, ...flags },
      { from: '/g2', to: { url: 'https://www.g2.com/products/realciso/reviews' }, status: 301, ...flags },
      { from: '/old-landing', to: { path: '/' }, status: 302, ...flags },
      { from: '/2019/:slug', to: { path: '/blog/:slug' }, status: 301, ...flags },
    ])

    await core.createRedirect({ from: '/old-landing', to: '/about' }, owner)
    const entry = await core.createEntry('pages', { slug: 'old-post', fields: { title: 'Old post', body } }, owner)
    await core.publish([entry.id], owner)
    const listed = new Map((await core.listCodeRedirects()).map((r) => [r.from, r]))
    expect(listed.get('/old-landing')).toMatchObject({ overridden: true, hidden: false })
    expect(listed.get('/old-post')).toMatchObject({ overridden: false, hidden: true })
    expect(listed.get('/g2')).toMatchObject(flags)
    expect(listed.get('/2019/:slug')).toMatchObject(flags)
  })

  it('does not mark a rule hidden while it still fires in some language', async () => {
    const { core, owner } = await world(rootSite([{ from: '/old-post', to: '/blog' }]))
    const fields = { title: 'Antiguo', body }
    const entry = await core.createEntry('pages', { slug: 'new-post', fields }, owner)
    const es = await core.createTranslation(entry.groupId, 'es', owner)
    await core.saveDraft(es.id, { baseRevisionId: es.headRev, data: { slug: 'old-post', fields, slots: {} } }, owner)
    await core.publish([es.id], owner)
    expect((await core.resolvePath('/es/old-post')).kind).toBe('page')
    expect(await core.resolvePath('/old-post')).toEqual(to301('/blog'))
    expect(await core.listCodeRedirects()).toMatchObject([{ from: '/old-post', hidden: false }])
  })
})

describe('codeRedirectLoops', () => {
  it('finds code rules that loop', async () => {
    const looping = await world(
      rootSite([
        { from: '/a', to: '/b' },
        { from: '/b', to: '/a' },
        { from: '/c', to: '/about' },
      ]),
    )
    expect(await looping.core.codeRedirectLoops()).toEqual(['/a', '/b'])
    expect(await (await world()).core.codeRedirectLoops()).toEqual([])
  })

  it("finds a loop that a stored rule makes with the release's code rules", async () => {
    const { core, db } = await world(rootSite([{ from: '/p', to: '/q' }]))
    await storeRule(db, '/q', '/p')
    expect(await core.codeRedirectLoops()).toEqual(['/p'])
  })

  it('a page on the way stops the loop', async () => {
    const { core } = await world(
      rootSite([
        { from: '/a', to: '/blog' },
        { from: '/blog', to: '/a' },
      ]),
    )
    expect(await core.codeRedirectLoops()).toEqual([])
  })
})

describe('deleting an admin rule', () => {
  const ids = async (core: Awaited<ReturnType<typeof world>>['core']) => new Map((await core.listRedirects()).map((r) => [r.from, r.id]))

  it('refuses a delete that lets an overridden code rule loop', async () => {
    const { core, db, owner } = await world(rootSite([{ from: '/a', to: '/c' }]))
    await storeRule(db, '/a', '/b')
    await storeRule(db, '/c', '/a')
    const err = await core.deleteRedirect((await ids(core)).get('/a')!, owner).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InlayError)
    expect(err).toMatchObject({ code: 'conflict', messageId: 'error.redirectDeleteLoop' })
    expect([...(await ids(core)).keys()]).toEqual(['/a', '/c'])
  })

  it('refuses a delete that lets the lowercase fallback loop', async () => {
    const { core, db, owner } = await world(rootSite())
    await storeRule(db, '/Foo', '/bar')
    await storeRule(db, '/foo', '/Foo')
    await expect(core.deleteRedirect((await ids(core)).get('/Foo')!, owner)).rejects.toMatchObject({ messageId: 'error.redirectDeleteLoop' })
    expect([...(await ids(core)).keys()]).toEqual(['/Foo', '/foo'])
  })

  it('deletes when nothing new loops, even beside a code rule that already loops', async () => {
    const { core, db, owner } = await world(rootSite([{ from: '/x', to: '/y' }, { from: '/y', to: '/x' }, { from: '/a', to: '/c' }]))
    await storeRule(db, '/a', '/b')
    await core.deleteRedirect((await ids(core)).get('/a')!, owner)
    expect(await core.listRedirects()).toEqual([])
    expect(await core.resolvePath('/a')).toEqual(to301('/c'))
  })
})
