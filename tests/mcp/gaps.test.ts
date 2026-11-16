import { createCore } from '../../src/core/core.js'
import { t } from '../../src/core/messages/index.js'
import type { SiteDefinition } from '../../src/core/registry/define.js'
import { noTestimonialsSite, ratedSite } from '../fixtures/evolve.js'
import { makeCore } from '../helpers/core.js'
import { mcpClient, type McpTestClient } from '../helpers/mcp.js'

const RELEASE = { id: 'r-1', name: 'Spring update' }

let mcp: McpTestClient | undefined

/** An MCP client on `site` over a database where Maria's testimonial is published under the shipped site. */
async function setup(site: SiteDefinition, release: { id: string; name: string } | null = RELEASE) {
  const { core, db, editor, owner } = await makeCore()
  await core.applyShippedContent()
  const maria = (await core.listEntries('testimonials'))[0]!
  await core.publish([maria.id], owner)
  mcp = await mcpClient({ core: createCore({ site, db }), actor: editor.actor, release })
  return { mcp, maria }
}

afterEach(async () => {
  await mcp?.close()
  mcp = undefined
})

describe('MCP gaps and releases', () => {
  it('describe_site names the release and sums up the gaps', async () => {
    const { mcp } = await setup(ratedSite)
    const { json, isError } = await mcp.call('describe_site')
    expect(isError).toBe(false)
    expect(json.release).toEqual({ name: 'Spring update' })
    expect(json.gaps).toEqual([{ type: 'testimonials', label: 'Testimonials', documents: 1, locales: { en: 1 } }])
  })

  it('describe_site has no release when the site runs from source', async () => {
    const { mcp } = await setup(ratedSite, null)
    expect((await mcp.call('describe_site')).json.release).toBeNull()
  })

  it('list_gaps lists the document with its missing field', async () => {
    const { mcp, maria } = await setup(ratedSite)
    const { json, isError } = await mcp.call('list_gaps')
    expect(isError).toBe(false)
    expect(json).toEqual({
      total: 1,
      gaps: [
        {
          id: maria.id,
          groupId: maria.groupId,
          type: 'testimonials',
          locale: 'en',
          title: maria.title,
          fields: [{ field: 'Rating', path: 'fields.rating', message: 'Rating is required.' }],
        },
      ],
    })
  })

  it('list_gaps pages with limit and offset, giving the total', async () => {
    const { mcp, maria } = await setup(ratedSite)
    expect((await mcp.call('list_gaps', { offset: 1 })).json).toEqual({ total: 1, gaps: [] })
    expect((await mcp.call('list_gaps', { limit: 1 })).json.gaps.map((g: { id: string }) => g.id)).toEqual([maria.id])
    expect((await mcp.call('list_gaps', { limit: 101 })).isError).toBe(true)
    expect((await mcp.call('list_gaps', { limit: 0 })).isError).toBe(true)
  })

  it('list_gaps filters by type', async () => {
    const { mcp, maria } = await setup(ratedSite)
    expect((await mcp.call('list_gaps', { type: 'posts' })).json).toEqual({ total: 0, gaps: [] })
    expect((await mcp.call('list_gaps', { type: 'testimonials' })).json.gaps.map((g: { id: string }) => g.id)).toEqual([maria.id])
  })

  it('list_gaps on a hidden type', async () => {
    const { mcp } = await setup(noTestimonialsSite)
    const hidden = await mcp.call('list_gaps', { type: 'testimonials' })
    expect(hidden.isError).toBe(true)
    expect(hidden.text).toContain(t('mcp.hiddenType', { type: 'testimonials' }))
    expect(hidden.text).not.toContain('Maria')
    expect(hidden.json.error.code).toBe('not_found')
    expect((await mcp.call('list_gaps')).json).toEqual({ total: 0, gaps: [] })
    expect((await mcp.call('describe_site')).json.gaps).toEqual([])
    const unknown = await mcp.call('list_gaps', { type: 'nope' })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain(t('error.typeNotFound', { name: 'nope' }))
  })

  it('describe_type says a hidden type is hidden, and an unknown one is not found', async () => {
    const { mcp } = await setup(noTestimonialsSite)
    const hidden = await mcp.call('describe_type', { type: 'testimonials' })
    expect(hidden.isError).toBe(true)
    expect(hidden.text).toContain(t('mcp.hiddenType', { type: 'testimonials' }))
    const unknown = await mcp.call('describe_type', { type: 'nope' })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain(t('error.typeNotFound', { name: 'nope' }))
    expect(unknown.text).not.toContain(t('mcp.hiddenType', { type: 'nope' }))
  })

  it('list_gaps is read-only, and releases cannot be pushed or activated', async () => {
    const { mcp } = await setup(ratedSite)
    const { tools } = await mcp.client.listTools()
    expect(tools.find((tool) => tool.name === 'list_gaps')?.annotations?.readOnlyHint).toBe(true)
    expect(tools.filter((tool) => /push|activate|release/.test(tool.name))).toEqual([])
  })
})
