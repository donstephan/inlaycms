import type { Core } from '../../src/core/core.js'
import type { Ctx } from '../../src/core/types.js'
import { makeCore } from '../helpers/core.js'
import { mcpClient, type McpTestClient } from '../helpers/mcp.js'

let core: Core
let owner: Ctx
let editor: Ctx
let mcp: McpTestClient

beforeEach(async () => {
  ;({ core, owner, editor } = await makeCore())
  await core.applyShippedContent()
  mcp = await mcpClient({ core, actor: editor.actor })
})

afterEach(async () => {
  await mcp.close()
})

const home = async () => (await core.findSingleton('home'))!

async function setHeadline(headline: string, ctx: Ctx = editor) {
  const doc = await home()
  await core.patchDraft(
    doc.id,
    { baseRevisionId: doc.headRev, ops: [{ path: ['slots', 'hero', 'data', 'headline'], value: headline }] },
    ctx,
  )
}

describe('history tools', () => {
  it('lists revisions newest first with head and published marks', async () => {
    const first = await home()
    await setHeadline('One')
    await core.publish([first.id], owner)
    await setHeadline('Two')
    const doc = await home()
    const { isError, json } = await mcp.call('list_revisions', { id: doc.id })
    expect(isError).toBe(false)
    const ids = json.revisions.map((r: any) => r.id)
    expect(ids).toEqual([...ids].sort((a: number, b: number) => b - a))
    expect(json.revisions[0]).toMatchObject({ id: doc.headRev, isHead: true, isPublished: false })
    expect(json.revisions.filter((r: any) => r.isPublished)).toHaveLength(1)
    expect(json.revisions.find((r: any) => r.isPublished).id).toBe(doc.publishedRev)
    expect(json.revisions[0].source).toBeTypeOf('string')
    expect((await mcp.call('list_revisions', { id: doc.id, limit: 1 })).json.revisions).toHaveLength(1)
  })

  it('diffs two revisions as label lines', async () => {
    const start = await home()
    await setHeadline('One')
    await setHeadline('Two')
    const revisions = await core.listRevisions(start.id)
    const lines = (await mcp.call('diff_revisions', { from: start.headRev, to: Math.max(...revisions.map((r) => r.id)) })).json.changes
    expect(lines.join('\n')).toContain('Headline')
    expect(lines.join('\n')).toContain('Two')
    const fromNothing = await mcp.call('diff_revisions', { to: start.headRev })
    expect(fromNothing.isError).toBe(false)
    expect(Array.isArray(fromNothing.json.changes)).toBe(true)
  })

  it('restores an earlier revision as a new unpublished head', async () => {
    const start = await home()
    await setHeadline('One')
    await setHeadline('Two')
    const before = await home()
    const { isError, json } = await mcp.call('restore_revision', { id: start.id, revisionId: start.headRev })
    expect(isError).toBe(false)
    const after = await home()
    expect(json).toMatchObject({ id: start.id, revisionId: after.headRev, changed: true })
    expect(after.headRev).toBeGreaterThan(before.headRev)
    expect(after.publishedRev).toBe(before.publishedRev)
    expect(json.previewUrl).toContain('example.com')
    const view = await core.getDocument(start.id)
    expect(view?.headRev).toBe(after.headRev)
    const lines = (await mcp.call('diff_revisions', { from: before.headRev, to: after.headRev })).json.changes
    expect(lines.join('\n')).toContain('Welcome to Inlay')
  })

  it('refuses a revision that belongs to another document', async () => {
    const doc = await home()
    const other = (await core.listPendingChanges()).find((d) => d.id !== doc.id) ?? (await core.findSingleton('about'))
    expect(other).toBeTruthy()
    const { isError, json } = await mcp.call('restore_revision', { id: doc.id, revisionId: other!.headRev })
    expect(isError).toBe(true)
    expect(json.error.code).toBe('not_found')
  })
})
