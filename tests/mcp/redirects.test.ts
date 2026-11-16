import type { Core } from '../../src/core/core.js'
import type { Ctx } from '../../src/core/types.js'
import { webSite } from '../fixtures/web.js'
import { makeCore } from '../helpers/core.js'
import { mcpClient, type McpTestClient } from '../helpers/mcp.js'

let core: Core
let owner: Ctx
let mcp: McpTestClient

beforeEach(async () => {
  ;({ core, owner } = await makeCore({ site: webSite }))
  await core.applyShippedContent()
  mcp = await mcpClient({ core, actor: owner.actor })
})

afterEach(async () => {
  await mcp.close()
})

describe('redirect tools', () => {
  it('creates a redirect and lists it', async () => {
    const created = await mcp.call('create_redirect', { from: '/old-about', to: '/about', note: 'Renamed' })
    expect(created.isError, created.text).toBe(false)
    expect(created.json).toMatchObject({ from: '/old-about', to: '/about', status: 301, note: 'Renamed' })
    const { json } = await mcp.call('list_redirects')
    expect(json.redirects).toEqual([created.json])
  })

  it('refuses a from that is a live page', async () => {
    const { isError, text } = await mcp.call('create_redirect', { from: '/about', to: '/somewhere' })
    expect(isError).toBe(true)
    expect(text).toContain('/about')
  })

  it('names the groupId when given a document id as the target', async () => {
    const about = (await core.findSingleton('about'))!
    const { isError, json } = await mcp.call('create_redirect', { from: '/old', to: { document: about.id } })
    expect(isError).toBe(true)
    expect(json.error.issues).toMatchObject([
      { path: 'to', message: expect.stringContaining(about.groupId) },
    ])
    expect(await core.listRedirects()).toEqual([])
  })

  it('lists a document target with its title', async () => {
    const post = await core.createEntry(
      'posts',
      { fields: { title: 'Hello World' } },
      owner,
    )
    const created = await mcp.call('create_redirect', { from: '/old-post', to: { document: post.groupId }, status: 302 })
    expect(created.isError, created.text).toBe(false)
    const { json } = await mcp.call('list_redirects')
    expect(json.redirects[0]).toMatchObject({ from: '/old-post', to: { document: post.groupId, title: 'Hello World' }, status: 302 })
  })

  it('deletes a redirect', async () => {
    const { json } = await mcp.call('create_redirect', { from: '/old-about', to: '/about' })
    const deleted = await mcp.call('delete_redirect', { id: json.id })
    expect(deleted.json).toEqual({ deleted: json.id })
    expect((await mcp.call('list_redirects')).json.redirects).toEqual([])
  })
})
