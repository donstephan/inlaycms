import type { Kysely } from 'kysely'
import type { Core } from '../../src/core/core.js'
import type { Database } from '../../src/core/db/schema.js'
import { t } from '../../src/core/messages/index.js'
import type { Ctx, DocumentData } from '../../src/core/types.js'
import { webSite } from '../fixtures/web.js'
import { makeCore } from '../helpers/core.js'
import { MCP_BASE_URL, mcpClient, type ElicitHandler, type McpTestClient } from '../helpers/mcp.js'

let core: Core
let db: Kysely<Database>
let owner: Ctx
let editor: Ctx
const rt = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

const open: McpTestClient[] = []

beforeEach(async () => {
  ;({ core, db, owner, editor } = await makeCore({ site: webSite }))
  await core.applyShippedContent()
})

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()))
})

async function client(opts: Partial<Parameters<typeof mcpClient>[0]> = {}) {
  const c = await mcpClient({ core, actor: editor.actor, ...opts })
  open.push(c)
  return c
}

const home = async () => (await core.findSingleton('home', 'en'))!

async function editHome(ctx: Ctx, headline: string) {
  const view = (await core.getDocument((await home()).id))!
  const data: DocumentData = structuredClone(view.data)
  data.slots.hero!.data.headline = headline
  await core.saveDraft(view.id, { baseRevisionId: view.headRev, data }, ctx)
}

const isLive = async (id: string) => {
  const doc = (await core.getDocument(id))!
  return doc.publishedRev === doc.headRev
}

describe('publish', () => {
  it('publishes once the user accepts, as an MCP change', async () => {
    await editHome(owner, 'Fresh headline')
    let asked = ''
    const mcp = await client({
      elicitation: (request) => {
        asked = request.params.message
        return { action: 'accept', content: { confirm: true } }
      },
    })
    const { id } = await home()
    const res = await mcp.call('publish', { ids: [id] })
    expect(res.isError, res.text).toBe(false)
    expect(res.json.published).toEqual([{ id, title: 'Home', locale: 'en', url: `${MCP_BASE_URL}/` }])
    expect(await isLive(id)).toBe(true)
    const events = await db.selectFrom('publish_events').selectAll().orderBy('id', 'desc').execute()
    expect(events[0]!.source).toBe('mcp')
    expect(asked.split('\n')[0]).toBe(t('mcp.confirm.publish', { count: 1 }))
    expect(asked).toContain('• Home (en)')
    expect(asked).toContain('Hero → Headline')
  })

  it('publishes nothing when the user declines, without an error', async () => {
    await editHome(owner, 'Fresh headline')
    for (const answer of ['decline', 'cancel'] as const) {
      const mcp = await client({ elicitation: answer })
      const { id } = await home()
      const res = await mcp.call('publish', { ids: [id] })
      expect(res.isError, res.text).toBe(false)
      expect(res.json).toEqual({ published: [], note: t('mcp.publishDeclined') })
      expect(await isLive(id)).toBe(false)
    }
  })

  it('gives a confirmation link to a client that cannot be asked', async () => {
    await editHome(owner, 'Fresh headline')
    const mcp = await client({ elicitation: 'none' })
    const { id } = await home()
    const res = await mcp.call('publish', { ids: [id] })
    expect(res.isError, res.text).toBe(false)
    expect(res.json.published).toEqual([])
    expect(res.json.confirmUrl).toBe(`${MCP_BASE_URL}/admin/publish?ids=${id}&action=publish`)
    expect(res.json.note).toBe(t('mcp.confirmByLink'))
    expect(await isLive(id)).toBe(false)
  })

  it('gives a 2025-era client the link even when it can elicit', async () => {
    await editHome(owner, 'Fresh headline')
    const mcp = await client({ era: 'legacy', elicitation: 'accept' })
    const { id } = await home()
    const res = await mcp.call('publish', { ids: [id] })
    expect(res.isError, res.text).toBe(false)
    expect(res.json.confirmUrl).toMatch(new RegExp(`ids=${id}&action=publish$`))
    expect(await isLive(id)).toBe(false)
  })

  it('publishes nothing when the content changed while the user was being asked', async () => {
    await editHome(owner, 'Fresh headline')
    const drift: ElicitHandler = async () => {
      await editHome(owner, 'Changed again')
      return { action: 'accept', content: { confirm: true } }
    }
    const mcp = await client({ elicitation: drift })
    const { id } = await home()
    const res = await mcp.call('publish', { ids: [id] })
    expect(res.isError).toBe(true)
    expect(res.text.split('\n')[0]).toBe(t('error.publishChanged', { title: 'Home' }))
    expect(res.json.error.code).toBe('conflict')
    expect(await isLive(id)).toBe(false)
  })

  it('lists the problems of an incomplete draft without asking', async () => {
    const post = await core.createEntry('posts', { slug: 'no-date', fields: { title: 'No date', body: rt('x') } }, editor)
    let asked = false
    const mcp = await client({
      elicitation: () => {
        asked = true
        return { action: 'accept', content: { confirm: true } }
      },
    })
    const res = await mcp.call('publish', { ids: [post.id] })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('No date → Date')
    expect(asked).toBe(false)
    expect(await isLive(post.id)).toBe(false)
  })

  it('publishes only once, however often the confirmed call is replayed', async () => {
    const post = await core.createEntry('posts', { slug: 'once', fields: { title: 'Once', date: '2026-02-01', body: rt('Hi') } }, editor)
    const mcp = await client({ elicitation: 'accept' })
    const res = await mcp.call('publish', { ids: [post.id] })
    expect(res.isError, res.text).toBe(false)
    expect(await isLive(post.id)).toBe(true)
    await core.unpublish([post.id], owner)
    expect((await core.getDocument(post.id))!.publishedRev).toBeNull()

    const confirmedCall = mcp.sent.find(({ init }) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      return body?.method === 'tools/call' && typeof body.params?.requestState === 'string' && body.params.inputResponses
    })
    expect(confirmedCall).toBeDefined()
    const replay = await mcp.fetch(confirmedCall!.url, confirmedCall!.init)
    const text = await replay.text()
    const data = text.split('\n').find((line) => line.startsWith('data: '))
    const message = JSON.parse(data === undefined ? text : data.slice('data: '.length))
    const result = JSON.parse(message.result.content[0].text)
    expect(result).toEqual({ published: [], note: t('mcp.publishDeclined') })
    expect((await core.getDocument(post.id))!.publishedRev).toBeNull()
  })

  it('needs one to 50 ids', async () => {
    const mcp = await client({ elicitation: 'accept' })
    expect((await mcp.call('publish', { ids: [] })).isError).toBe(true)
  })
})

describe('unpublish', () => {
  it('takes a published post off the site once the user accepts', async () => {
    const post = await core.createEntry('posts', { slug: 'hello', fields: { title: 'Hello', date: '2026-02-01', body: rt('Hi') } }, editor)
    await core.publish([post.id], editor)
    let asked = ''
    const mcp = await client({
      elicitation: (request) => {
        asked = request.params.message
        return { action: 'accept', content: { confirm: true } }
      },
    })
    const res = await mcp.call('unpublish', { ids: [post.id] })
    expect(res.isError, res.text).toBe(false)
    expect(res.json.unpublished).toEqual([{ id: post.id, title: 'Hello', locale: 'en' }])
    expect((await core.getDocument(post.id))!.publishedRev).toBeNull()
    expect(asked.split('\n')[0]).toBe(t('mcp.confirm.unpublish', { count: 1 }))
    expect(asked).toContain('• Hello (en)')
  })

  it('refuses to unpublish a page', async () => {
    const mcp = await client({ elicitation: 'accept' })
    const res = await mcp.call('unpublish', { ids: [(await home()).id] })
    expect(res.isError).toBe(true)
    expect(res.text.split('\n')[0]).toBe(t('error.unpublishNotAllowed'))
  })

  it('is marked destructive', async () => {
    const mcp = await client()
    const { tools } = await mcp.client.listTools()
    expect(tools.find((x) => x.name === 'unpublish')?.annotations?.destructiveHint).toBe(true)
    expect(tools.find((x) => x.name === 'publish')?.annotations?.readOnlyHint).toBe(false)
  })
})
