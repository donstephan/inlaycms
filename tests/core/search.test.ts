import type { Core } from '../../src/core/core.js'
import type { Ctx } from '../../src/core/types.js'
import { makeCore } from '../helpers/core.js'
import { webSite } from '../fixtures/web.js'
import { site } from '../fixtures/site.js'

describe('searchEntries', () => {
  let core: Core
  let editor: Ctx

  beforeEach(async () => {
    ;({ core, editor } = await makeCore({ site: webSite }))
  })

  const quote = (author: string, text = 'Great work') =>
    core.createEntry('testimonials', { fields: { author, quote: text } }, editor)
  const authors = async (q: string, o?: { locale?: string; limit?: number }) =>
    (await core.searchEntries('testimonials', q, o)).map((d) => d.title)

  it('ignores case and accents and requires every word', async () => {
    await quote('María López')
    expect(await authors('maria')).toEqual(['María López'])
    expect(await authors('MARÍA lopez')).toEqual(['María López'])
    expect(await authors('lopez maria')).toEqual(['María López'])
    expect(await authors('maria smith')).toEqual([])
  })

  it('finds words in a rich-text body and returns a snippet', async () => {
    const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Notes on zeppelins' }] }] }
    await core.createEntry('posts', { fields: { title: 'Hello', date: '2026-02-01', body } }, editor)
    const hits = await core.searchEntries('posts', 'zeppelins')
    expect(hits.map((h) => h.title)).toEqual(['Hello'])
    expect(hits[0]!.snippet).toContain('zeppelins')
  })

  it('ranks title matches first, then newest', async () => {
    await quote('Zed', 'about Carla')
    await quote('Carla')
    await quote('Yan', 'Carla again')
    expect(await authors('carla')).toEqual(['Carla', 'Yan', 'Zed'])
  })

  it('clamps the limit', async () => {
    for (let i = 0; i < 55; i++) await quote(`Person ${i}`)
    expect(await authors('person', { limit: 500 })).toHaveLength(50)
    expect(await authors('person', { limit: 0 })).toHaveLength(1)
    expect(await authors('person')).toHaveLength(10)
  })

  it('returns the newest entries for an empty query', async () => {
    await quote('First')
    await quote('Second')
    expect(await authors('')).toEqual(['Second', 'First'])
  })

  it('hides other locales and deleted entries', async () => {
    const a = await quote('Gone Person')
    await quote('Kept Person')
    await core.createTranslation(a.groupId, 'es', editor)
    await core.deleteEntry(a.groupId, editor)
    expect(await authors('person')).toEqual(['Kept Person'])
    expect(await authors('person', { locale: 'es' })).toEqual([])
  })
})

describe('findEntry', () => {
  it('matches by head slug', async () => {
    const { core, editor } = await makeCore()
    const post = await core.createEntry('posts', { slug: 'hello', fields: { title: 'Hello', date: '2026-02-01', body: 'x' } }, editor)
    expect((await core.findEntry('posts', 'hello'))?.id).toBe(post.id)
    const doc = (await core.getDocument(post.id))!
    await core.saveDraft(post.id, { baseRevisionId: doc.headRev, data: { ...doc.data, slug: 'hi' } }, editor)
    expect(await core.findEntry('posts', 'hello')).toBeNull()
    expect((await core.findEntry('posts', 'hi'))?.id).toBe(post.id)
  })
})
