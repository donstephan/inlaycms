import type { Kysely } from 'kysely'
import type { Core } from '../../src/core/core.js'
import type { Database } from '../../src/core/db/schema.js'
import type { Activity, Ctx, DocumentSummary } from '../../src/core/types.js'
import { webSite } from '../fixtures/web.js'
import { makeCore } from '../helpers/core.js'

describe('recentActivity', () => {
  let core: Core
  let db: Kysely<Database>
  let owner: Ctx
  let editor: Ctx
  let assistant: Ctx
  let home: DocumentSummary
  let about: DocumentSummary

  beforeEach(async () => {
    ;({ core, db, owner, editor } = await makeCore({ site: webSite }))
    assistant = { ...editor, source: 'mcp' }
    await core.applyShippedContent()
    home = (await core.findSingleton('home'))!
    about = (await core.findSingleton('about'))!
  })

  const rename = async (doc: DocumentSummary, title: string, ctx: Ctx) => {
    const current = (await core.getDocument(doc.id))!
    return core.patchDraft(doc.id, { baseRevisionId: current.headRev, ops: [{ path: ['fields', 'title'], value: title }] }, ctx)
  }
  const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Text' }] }] }
  const edits = (list: Activity[]) => list.filter((a): a is Extract<Activity, { kind: 'edit' }> => a.kind === 'edit')

  it('collapses a run of edits by one author and channel into one item', async () => {
    await rename(home, 'One', assistant)
    await rename(home, 'Two', assistant)
    await rename(home, 'Three', assistant)
    const [first] = await core.recentActivity()
    expect(first).toMatchObject({ kind: 'edit', count: 3, source: 'mcp', authorName: 'Eddie Editor' })
    expect((first as Extract<Activity, { kind: 'edit' }>).document.id).toBe(home.id)
  })

  it('splits the run at an edit by someone else', async () => {
    await rename(home, 'One', assistant)
    await rename(home, 'Two', owner)
    await rename(home, 'Three', assistant)
    const mine = edits(await core.recentActivity()).filter((a) => a.document.id === home.id && a.source !== 'release')
    expect(mine.map((a) => [a.authorName, a.count])).toEqual([
      ['Eddie Editor', 1],
      ['Olivia Owner', 1],
      ['Eddie Editor', 1],
    ])
  })

  it('shows publishing as one item with every document', async () => {
    await rename(home, 'Home 2', editor)
    await rename(about, 'About 2', editor)
    await core.publish([home.id, about.id], owner)
    const published = (await core.recentActivity()).filter((a) => a.kind === 'publish' && a.authorName === 'Olivia Owner')
    expect(published).toHaveLength(1)
    const item = published[0] as Extract<Activity, { kind: 'publish' | 'unpublish' }>
    expect(item.authorName).toBe('Olivia Owner')
    expect(item.documents.map((d) => d.id).sort()).toEqual([home.id, about.id].sort())
  })

  it('splits publishing from unpublishing', async () => {
    const post = await core.createEntry('posts', { fields: { title: 'Soon', date: '2026-02-01', body } }, editor)
    await rename(home, 'Home 2', editor)
    await core.publish([home.id, post.id], owner)
    await core.unpublish([post.id], owner)
    const [latest, previous] = await core.recentActivity()
    expect(latest).toMatchObject({ kind: 'unpublish' })
    expect(previous).toMatchObject({ kind: 'publish' })
  })

  it('includes shipped content and leaves out system changes', async () => {
    expect(edits(await core.recentActivity({ limit: 100 })).some((a) => a.source === 'release')).toBe(true)
    await rename(home, 'Edited', assistant)
    await db.updateTable('revisions').set({ source: 'system' }).where('id', '=', (await core.getDocument(home.id))!.headRev).execute()
    const list = edits(await core.recentActivity({ limit: 100 }))
    expect(list.some((a) => a.source === 'system')).toBe(false)
    expect(list.some((a) => a.source === 'mcp')).toBe(false)
  })

  it('forgets deleted entries', async () => {
    const post = await core.createEntry('posts', { fields: { title: 'Gone', date: '2026-02-01' } }, editor)
    expect(edits(await core.recentActivity()).some((a) => a.document.id === post.id)).toBe(true)
    await core.deleteEntry(post.groupId, owner)
    expect(edits(await core.recentActivity({ limit: 100 })).some((a) => a.document.id === post.id)).toBe(false)
  })

  it('clamps the limit to 1 through 100', async () => {
    for (let i = 0; i < 120; i += 1) await core.createEntry('testimonials', { fields: { author: `A${i}`, quote: 'q' } }, editor)
    expect(await core.recentActivity({ limit: 0 })).toHaveLength(1)
    expect((await core.recentActivity({ limit: 500 })).length).toBe(100)
    expect(await core.recentActivity()).toHaveLength(20)
  })
})
