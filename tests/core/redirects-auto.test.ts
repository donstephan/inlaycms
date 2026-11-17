import { parseCsv } from '../../src/core/redirects/csv.js'
import { InlayError } from '../../src/core/errors.js'
import type { Core } from '../../src/core/core.js'
import type { Ctx } from '../../src/core/types.js'
import { png } from '../fixtures/media.js'
import { routedSite } from '../fixtures/routes.js'
import { makeCore } from '../helpers/core.js'

const fields = { title: 'Hello world', date: '2026-02-01', body: 'Hi' }

async function world(opts: { media?: boolean } = {}) {
  const w = await makeCore({ site: routedSite(), ...opts })
  await w.core.applyShippedContent()
  const post = await w.core.createEntry('posts', { fields, slug: 'x' }, w.owner)
  await w.core.publish([post.id], w.owner)
  return { ...w, post }
}

async function edit(core: Core, ctx: Ctx, id: string, change: { slug?: string; path?: string }, publish = true) {
  const doc = (await core.getDocument(id))!
  await core.saveDraft(id, { baseRevisionId: doc.headRev, data: { ...doc.data, ...change } }, ctx)
  if (publish) await core.publish([id], ctx)
}

const to301 = (location: string) => ({ kind: 'redirect', location, status: 301 })

async function importError(p: Promise<unknown>): Promise<InlayError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(InlayError)
  expect(err).toMatchObject({ code: 'validation', messageId: 'error.redirectImportFailed' })
  return err as InlayError
}

describe('automatic redirects', () => {
  it('follows slug churn in one hop and back again (Review Focus 5)', async () => {
    const { core, owner, post } = await world()
    await edit(core, owner, post.id, { slug: 'y' })
    expect(await core.resolvePath('/blog/x')).toEqual(to301('/blog/y'))
    expect(await core.listRedirects()).toEqual([
      expect.objectContaining({ from: '/blog/x', to: { document: post.groupId }, source: 'auto', status: 301 }),
    ])

    await edit(core, owner, post.id, { slug: 'z' })
    expect(await core.resolvePath('/blog/x')).toEqual(to301('/blog/z'))
    expect(await core.resolvePath('/blog/y')).toEqual(to301('/blog/z'))

    await edit(core, owner, post.id, { slug: 'x' })
    const res = await core.resolvePath('/blog/x')
    expect(res.kind).toBe('page')
    expect((await core.listRedirects()).map((r) => r.from)).toEqual(['/blog/y', '/blog/z'])
    expect(await core.resolvePath('/blog/z')).toEqual(to301('/blog/x'))
  })

  it('creates a rule from a translation’s old prefixed path', async () => {
    const { core, owner, post } = await world()
    const es = await core.createTranslation(post.groupId, 'es', owner)
    await edit(core, owner, es.id, { slug: 'hola' })
    await edit(core, owner, es.id, { slug: 'adios' })
    expect((await core.listRedirects()).map((r) => [r.from, r.to])).toEqual([['/es/blog/hola', { document: post.groupId }]])
    expect(await core.resolvePath('/es/blog/hola')).toEqual(to301('/es/blog/adios'))
  })

  it('creates nothing for a saved but unpublished change', async () => {
    const { core, owner, post } = await world()
    await edit(core, owner, post.id, { slug: 'y' }, false)
    expect(await core.listRedirects()).toEqual([])
    expect((await core.resolvePath('/blog/x')).kind).toBe('page')
  })

  it('creates a rule from an old custom path', async () => {
    const { core, owner } = await world()
    const p = await core.createEntry('posts', { fields: { ...fields, title: 'Old' }, path: '/old-site/page.html' }, owner)
    await core.publish([p.id], owner)
    await edit(core, owner, p.id, { path: '/new-page' })
    expect((await core.listRedirects()).map((r) => [r.from, r.to])).toEqual([
      ['/old-site/page.html', { document: p.groupId }],
    ])
    expect(await core.resolvePath('/old-site/page.html')).toEqual(to301('/new-page'))
  })

  it("drops an automatic rule from a new entry's URL on its first publish", async () => {
    const { core, owner, post } = await world()
    await edit(core, owner, post.id, { slug: 'y' })
    expect((await core.listRedirects()).map((r) => r.from)).toEqual(['/blog/x'])
    const k = await core.createEntry('posts', { fields: { ...fields, title: 'K' }, slug: 'x' }, owner)
    await core.publish([k.id], owner)
    expect(await core.listRedirects()).toEqual([])
    expect(await core.resolvePath('/blog/x')).toMatchObject({ kind: 'page', document: { groupId: k.groupId } })
  })

  it('re-points manual rules that targeted the old path', async () => {
    const { core, owner, post } = await world()
    await core.createRedirect({ from: '/promo', to: '/blog/x' }, owner)
    await edit(core, owner, post.id, { slug: 'y' })
    expect(await core.resolvePath('/promo')).toEqual(to301('/blog/y'))
    expect((await core.listRedirects()).find((r) => r.from === '/promo')).toMatchObject({
      to: { document: post.groupId },
      source: 'manual',
    })
  })

  it('I2: re-points to the document only rules that fire in its locale, and keeps the locale of others', async () => {
    const { core, owner, post } = await world()
    const es = await core.createTranslation(post.groupId, 'es', owner)
    await edit(core, owner, es.id, { slug: 'hola' })
    await core.createRedirect({ from: '/promo', to: '/es/blog/hola' }, owner)
    await core.createRedirect({ from: '/es/promo', to: '/es/blog/hola' }, owner)
    await core.createRedirect({ from: '/es/promo2', to: '/blog/x' }, owner)
    await core.createRedirect({ from: '/promo2', to: '/blog/x' }, owner)

    await edit(core, owner, es.id, { slug: 'adios' })
    await edit(core, owner, post.id, { slug: 'y' })
    const to = async (from: string) => (await core.listRedirects()).find((r) => r.from === from)?.to
    expect(await to('/promo')).toEqual({ path: '/es/blog/adios' })
    expect(await to('/es/promo')).toEqual({ document: post.groupId })
    expect(await to('/es/promo2')).toEqual({ path: '/blog/y' })
    expect(await to('/promo2')).toEqual({ document: post.groupId })

    expect(await core.resolvePath('/promo')).toEqual(to301('/es/blog/adios'))
    expect(await core.resolvePath('/es/promo')).toEqual(to301('/es/blog/adios'))
    expect(await core.resolvePath('/es/promo2')).toEqual(to301('/blog/y'))
    expect(await core.resolvePath('/promo2')).toEqual(to301('/blog/y'))
    expect(await core.resolvePath('/es/promo2')).toEqual(to301('/blog/y'))

    await edit(core, owner, post.id, { slug: 'z' })
    expect(await to('/es/promo2')).toEqual({ path: '/blog/z' })
    expect(await core.resolvePath('/es/promo2')).toEqual(to301('/blog/z'))
  })
})

describe('redirects: the cached rule index', () => {
  /** Resolves an unmatched path, so the rule index is built and cached before the change. */
  const warm = async (core: Core) => expect((await core.resolvePath('/warm-up')).kind).toBe('not_found')

  it('sees every redirect write at once', async () => {
    const { core, owner, post } = await world()
    await warm(core)
    const rule = await core.createRedirect({ from: '/old', to: '/about' }, owner)
    expect(await core.resolvePath('/old')).toEqual(to301('/about'))
    await core.createRedirect({ from: '/p/:x', to: '/blog/:x' }, owner)
    expect(await core.resolvePath('/p/q')).toEqual(to301('/blog/q'))

    await core.deleteRedirect(rule.id, owner)
    expect(await core.resolvePath('/old')).toEqual({ kind: 'not_found', locale: 'en' })

    await core.importRedirects('/old,/blog/x\n/p/:x,/\n', owner)
    expect(await core.resolvePath('/old')).toEqual(to301('/blog/x'))
    expect(await core.resolvePath('/p/q')).toEqual(to301('/'))

    await edit(core, owner, post.id, { slug: 'y' })
    expect(await core.resolvePath('/blog/x')).toEqual(to301('/blog/y'))
    expect(await core.resolvePath('/old')).toEqual(to301('/blog/y'))
  })

  it('is unchanged by a rejected write and sees writes made straight to the database', async () => {
    const { core, db, owner } = await world()
    await core.createRedirect({ from: '/a', to: '/b' }, owner)
    await warm(core)
    await expect(core.createRedirect({ from: '/b', to: '/a' }, owner)).rejects.toBeInstanceOf(InlayError)
    expect(await core.resolvePath('/a')).toEqual(to301('/b'))
    expect(await core.resolvePath('/b')).toEqual({ kind: 'not_found', locale: 'en' })

    await db.updateTable('redirects').set({ to_path: '/c' }).where('from_path', '=', '/a').execute()
    expect(await core.resolvePath('/a')).toEqual(to301('/c'))
  })
})

describe('redirects: collapsing on write (review regressions)', () => {
  const list = async (core: Core) => (await core.listRedirects()).map((r) => [r.from, r.to])

  it('I2: never collapses through a pattern rule into a route or unpublished page', async () => {
    const { core, owner } = await world()
    await core.createRedirect({ from: '/promo', to: '/contact' }, owner)
    await core.createRedirect({ from: '/:x', to: '/' }, owner)
    await core.createRedirect({ from: '/q', to: '/blog/unpublished' }, owner)
    expect(await list(core)).toEqual([
      ['/:x', { path: '/' }],
      ['/promo', { path: '/contact' }],
      ['/q', { path: '/blog/unpublished' }],
    ])
  })

  it('I2: leaves other rules alone when their target is unpublished later', async () => {
    const { core, owner, post } = await world()
    await core.createRedirect({ from: '/z', to: '/blog/x' }, owner)
    await core.createRedirect({ from: '/:a/:b', to: '/' }, owner)
    await core.unpublish([post.id], owner)
    await core.createRedirect({ from: '/w', to: '/k' }, owner)
    expect((await core.listRedirects()).find((r) => r.from === '/z')?.to).toEqual({ path: '/blog/x' })
  })

  it('I2: keeps a draft page as the target of a rule', async () => {
    const { core, owner } = await world()
    await core.createEntry('posts', { fields: { ...fields, title: 'Draft' }, slug: 'd' }, owner)
    await core.createRedirect({ from: '/blog/d', to: '/elsewhere' }, owner)
    await core.createRedirect({ from: '/q', to: '/blog/d' }, owner)
    await core.createRedirect({ from: '/r', to: '/blog/d' }, owner)
    expect((await core.listRedirects()).find((r) => r.from === '/q')?.to).toEqual({ path: '/blog/d' })
    expect(await core.resolvePath('/q')).toEqual(to301('/blog/d'))
  })

  it('M1: does not collapse through an unprefixed rule that another locale overrides', async () => {
    const { core, owner } = await world()
    await core.createRedirect({ from: '/es/new', to: '/es/special' }, owner)
    await core.createRedirect({ from: '/new', to: '/x' }, owner)
    await core.createRedirect({ from: '/old', to: '/new' }, owner)
    expect((await core.listRedirects()).find((r) => r.from === '/old')?.to).toEqual({ path: '/new' })
    expect(await core.resolvePath('/old')).toEqual(to301('/new'))
    expect(await core.resolvePath('/es/old')).toEqual(to301('/es/new'))
    expect(await core.resolvePath('/es/new')).toEqual(to301('/es/special'))

    await core.createRedirect({ from: '/es/a', to: '/es/b' }, owner)
    expect(await core.importRedirects('/b,/c\n/a,/b\n', owner)).toEqual({ created: 2, updated: 0 })
    expect((await core.listRedirects()).find((r) => r.from === '/a')?.to).toEqual({ path: '/c' })
  })

  it('M1: finds a loop that only happens in another locale', async () => {
    const { core, owner } = await world()
    await core.createRedirect({ from: '/old', to: '/new' }, owner)
    const err = await core.createRedirect({ from: '/es/new', to: '/es/old' }, owner).catch((e: unknown) => e)
    expect(err).toMatchObject({ messageId: 'error.redirectInvalid', details: { issues: [{ code: 'redirect_loop' }] } })
  })
})

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, CRLF, BOM and blank lines', () => {
    const text = '﻿from,to\r\n"/a, b","say ""hi"""\r\n\r\n"multi\nline",x\n'
    expect(parseCsv(text)).toEqual({
      rows: [
        { line: 1, cells: ['from', 'to'] },
        { line: 2, cells: ['/a, b', 'say "hi"'] },
        { line: 4, cells: ['multi\nline', 'x'] },
      ],
      problems: [],
    })
  })

  it('reports an unterminated quote', () => {
    const { rows, problems } = parseCsv('/a,/b\n"/c,/d\n/e,/f\n')
    expect(rows).toEqual([{ line: 1, cells: ['/a', '/b'] }])
    expect(problems).toHaveLength(1)
    expect(problems[0]!.line).toBe(2)
    expect(problems[0]!.message).toMatch(/^Line 2: /)
  })
})

describe('importRedirects', () => {
  it('imports rows with or without a header', async () => {
    const { core, owner } = await world()
    const csv = 'from,to,status,note\n/old,/about,301,Old page\n"/a b",/blog/x,302,\n'
    expect(await core.importRedirects(csv, owner)).toEqual({ created: 2, updated: 0 })
    expect((await core.listRedirects()).map((r) => [r.from, r.to, r.status, r.source, r.note])).toEqual([
      ['/a b', { path: '/blog/x' }, 302, 'import', null],
      ['/old', { path: '/about' }, 301, 'import', 'Old page'],
    ])
    expect(await core.resolvePath('/a%20b')).toEqual({ kind: 'redirect', location: '/blog/x', status: 302 })

    expect(await core.importRedirects('/old,/\nhttps://old.example.com/p,/about\n', owner)).toEqual({
      created: 1,
      updated: 1,
    })
    const rules = await core.listRedirects()
    expect(rules.find((r) => r.from === '/old')?.to).toEqual({ path: '/' })
    expect(rules.find((r) => r.from === '/p')?.to).toEqual({ path: '/about' })
  })

  it('handles a BOM and CRLF line endings', async () => {
    const { core, editor } = await world()
    expect(await core.importRedirects('﻿From,To\r\n/one,/about\r\n/two,/\r\n', editor)).toEqual({
      created: 2,
      updated: 0,
    })
  })

  it('reports every problem with its line and writes nothing', async () => {
    const { core, owner } = await world()
    await core.createRedirect({ from: '/keep', to: '/' }, owner)
    const before = await core.listRedirects()
    const csv = [
      'from,to,status',
      '/fine,/about',
      '/bad-status,/about,303',
      '/offsite,http://x.com',
      '/fine,/',
      '/loop-a,/loop-b',
      '/loop-b,/loop-a',
    ].join('\n')
    const err = await importError(core.importRedirects(csv, owner))
    const lines = err.details.lines ?? []
    expect(lines.map((l) => l.line)).toEqual([3, 4, 5, 6, 7])
    for (const l of lines) expect(l.message).toMatch(new RegExp(`^Line ${l.line}: `))
    expect(err.params).toEqual({ count: 5 })
    expect(await core.listRedirects()).toEqual(before)
  })

  it('reports an unterminated quote', async () => {
    const { core, owner } = await world()
    const err = await importError(core.importRedirects('/a,/about\n"/b,/\n', owner))
    expect(err.details.lines?.map((l) => l.line)).toEqual([2])
    expect(await core.listRedirects()).toEqual([])
  })

  it('finds loops through existing rules', async () => {
    const { core, owner } = await world()
    await core.createRedirect({ from: '/a', to: '/b' }, owner)
    const err = await importError(core.importRedirects('/b,/a\n', owner))
    expect(err.details.lines?.map((l) => l.line)).toEqual([1])
  })
})

describe('onLiveChange', () => {
  it('fires once per live change, after the commit', async () => {
    const { core, owner, post } = await world({ media: true })
    let calls = 0
    let titles: string[] = []
    const stop = core.onLiveChange(() => {
      calls++
      void core.liveEntries('posts', 'en').then((es) => (titles = es.map((e) => e.title)))
    })

    const draft = await core.createEntry('posts', { fields: { ...fields, title: 'Second' } }, owner)
    expect(calls).toBe(0)
    await core.publish([draft.id], owner)
    expect(calls).toBe(1)
    await new Promise((r) => setTimeout(r, 10))
    expect(titles).toContain('Second')

    await core.publish([draft.id], owner)
    expect(calls).toBe(1)

    await edit(core, owner, post.id, { slug: 'y' }, false)
    expect(calls).toBe(1)

    await core.unpublish([draft.id], owner)
    expect(calls).toBe(2)
    await core.deleteEntry(draft.groupId, owner)
    expect(calls).toBe(3)
    const rule = await core.createRedirect({ from: '/old', to: '/' }, owner)
    expect(calls).toBe(4)
    await core.deleteRedirect(rule.id, owner)
    expect(calls).toBe(5)
    await core.importRedirects('/old,/about\n', owner)
    expect(calls).toBe(6)
    const { media } = await core.addMedia({ data: await png(10, 10), filename: 'a.png' }, owner)
    await core.setMediaAlt(media.id, 'A square', owner)
    expect(calls).toBe(7)

    stop()
    await core.createRedirect({ from: '/other', to: '/' }, owner)
    expect(calls).toBe(7)
  })

  it('sees the published post inside the listener and ignores listener errors', async () => {
    const { core, owner } = await world()
    const seen: string[][] = []
    core.onLiveChange(() => {
      throw new Error('boom')
    })
    core.onLiveChange(async () => {
      seen.push((await core.liveEntries('posts', 'en')).map((e) => e.title))
    })
    const draft = await core.createEntry('posts', { fields: { ...fields, title: 'Third' } }, owner)
    await core.publish([draft.id], owner)
    await new Promise((r) => setTimeout(r, 10))
    expect(seen).toEqual([expect.arrayContaining(['Third'])])
  })
})
