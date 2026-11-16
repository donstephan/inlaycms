import type { FetchFile } from '../../src/adapters/mcp/server.js'
import { verifyUploadToken } from '../../src/core/auth/upload-token.js'
import type { Core } from '../../src/core/core.js'
import { InlayError } from '../../src/core/errors.js'
import type { Ctx } from '../../src/core/types.js'
import { webSite } from '../fixtures/web.js'
import { jpeg, png } from '../fixtures/media.js'
import { makeCore } from '../helpers/core.js'
import { MCP_BASE_URL, MCP_SECRET, mcpClient, type McpTestClient } from '../helpers/mcp.js'

let core: Core
let owner: Ctx
let editor: Ctx
let mcp: McpTestClient
let photo: Buffer
let fetched: { url: string; maxBytes: number }[]

const fetchFile: FetchFile = async (url, { maxBytes }) => {
  fetched.push({ url, maxBytes })
  return { data: photo, filename: 'beach.jpg' }
}

beforeEach(async () => {
  ;({ core, owner, editor } = await makeCore({ site: webSite, media: true }))
  await core.applyShippedContent()
  photo = await jpeg(40, 30)
  fetched = []
  mcp = await mcpClient({ core, actor: editor.actor, fetchFile, uploads: { maxBytes: 5000 } })
})

afterEach(async () => {
  await mcp.close()
})

describe('upload_media_from_url', () => {
  it('stores the file, then reuses it the second time', async () => {
    const first = await mcp.call('upload_media_from_url', { url: 'https://photos.example/beach.jpg', alt: 'A sandy beach' })
    expect(first.isError).toBe(false)
    expect(fetched).toEqual([{ url: 'https://photos.example/beach.jpg', maxBytes: 5000 }])
    expect(first.json.reused).toBe(false)
    const { id } = first.json.media
    expect(first.json.media).toMatchObject({
      filename: 'beach.jpg',
      mime: 'image/jpeg',
      width: 40,
      height: 30,
      defaultAlt: 'A sandy beach',
      url: `${MCP_BASE_URL}/media/${id}`,
    })
    expect((await core.getMedia(id))?.createdBy).toBe(editor.actor.name)

    const second = await mcp.call('upload_media_from_url', { url: 'https://photos.example/copy.jpg', filename: 'other.jpg' })
    expect(second.isError).toBe(false)
    expect(second.json.reused).toBe(true)
    expect(second.json.media.id).toBe(id)
  })

  it('keeps the alt text a reused file already has', async () => {
    const first = await mcp.call('upload_media_from_url', { url: 'https://photos.example/beach.jpg', alt: 'A sandy beach' })
    const second = await mcp.call('upload_media_from_url', { url: 'https://photos.example/copy.jpg', alt: 'Something else' })
    expect(second.json).toMatchObject({ reused: true, media: { id: first.json.media.id, defaultAlt: 'A sandy beach' } })
    expect((await core.getMedia(first.json.media.id))?.defaultAlt).toBe('A sandy beach')
  })

  it('sets the alt text of a reused file that has none', async () => {
    const first = await mcp.call('upload_media_from_url', { url: 'https://photos.example/beach.jpg' })
    const second = await mcp.call('upload_media_from_url', { url: 'https://photos.example/copy.jpg', alt: 'A sandy beach' })
    expect(second.json).toMatchObject({ reused: true, media: { id: first.json.media.id, defaultAlt: 'A sandy beach' } })
  })

  it('passes on what the fetch refuses, in plain words, and stores nothing', async () => {
    const failing = await mcpClient({
      core,
      actor: editor.actor,
      fetchFile: async () => {
        throw new InlayError('invalid_operation', 'error.fetchBlocked', { url: 'http://127.0.0.1/' })
      },
    })
    try {
      const { isError, json } = await failing.call('upload_media_from_url', { url: 'http://127.0.0.1/' })
      expect(isError).toBe(true)
      expect(json.error.code).toBe('invalid_operation')
      expect(await core.listMedia()).toEqual([])
    } finally {
      await failing.close()
    }
  })
})

describe('set_media_alt and list_media', () => {
  it('shows the new default alt in the list', async () => {
    const { media } = await core.addMedia({ data: photo, filename: 'beach.jpg' }, owner)
    await core.addMedia({ data: await png(10, 10), filename: 'logo.png' }, owner)

    const set = await mcp.call('set_media_alt', { id: media.id, alt: 'Waves on the sand' })
    expect(set.isError).toBe(false)
    expect(set.json.defaultAlt).toBe('Waves on the sand')

    const listed = await mcp.call('list_media', { search: 'beach' })
    expect(listed.isError).toBe(false)
    expect(listed.json.media).toEqual([
      {
        id: media.id,
        filename: 'beach.jpg',
        mime: 'image/jpeg',
        size: photo.length,
        width: 40,
        height: 30,
        defaultAlt: 'Waves on the sand',
        url: `${MCP_BASE_URL}/media/${media.id}`,
      },
    ])
    expect((await mcp.call('list_media', {})).json.media).toHaveLength(2)
    expect((await mcp.call('list_media', { limit: 1 })).json.media).toHaveLength(1)

    const cleared = await mcp.call('set_media_alt', { id: media.id, alt: null })
    expect(cleared.json.defaultAlt).toBeNull()
  })

  it('refuses a limit over 100', async () => {
    expect((await mcp.call('list_media', { limit: 101 })).isError).toBe(true)
  })
})

describe('delete_media', () => {
  it('deletes an unused file', async () => {
    const { media } = await core.addMedia({ data: photo, filename: 'beach.jpg' }, owner)
    const { isError, json } = await mcp.call('delete_media', { id: media.id })
    expect(isError).toBe(false)
    expect(json).toEqual({ deleted: { id: media.id, filename: 'beach.jpg' } })
    expect(await core.getMedia(media.id)).toBeNull()
  })

  it('refuses a file in use, naming the page', async () => {
    const { media } = await core.addMedia({ data: photo, filename: 'beach.jpg' }, owner)
    const home = (await core.findSingleton('home', 'en'))!
    await core.patchDraft(
      home.id,
      { baseRevisionId: home.headRev, ops: [{ path: ['slots', 'hero', 'data', 'image'], value: { media: media.id } }] },
      owner,
    )
    const { isError, text, json } = await mcp.call('delete_media', { id: media.id })
    expect(isError).toBe(true)
    expect(json.error.code).toBe('in_use')
    expect(text).toContain('"Home"')
    expect(json.error.usages[0]).toMatchObject({ id: home.id, title: 'Home' })
    expect(await core.getMedia(media.id)).not.toBeNull()
  })
})

describe('request_media_upload', () => {
  it('gives an upload link for the calling user', async () => {
    const { isError, json } = await mcp.call('request_media_upload', {})
    expect(isError).toBe(false)
    expect(json.uploadUrl).toContain(`${MCP_BASE_URL}/admin/upload?token=`)
    const token = new URL(json.uploadUrl).searchParams.get('token')!
    const verified = verifyUploadToken(MCP_SECRET, token, new Date())
    expect(verified?.userId).toBe(editor.actor.id)
    expect(json.expiresAt).toBe(verified?.expiresAt.toISOString())
    expect(typeof json.note).toBe('string')
  })
})
