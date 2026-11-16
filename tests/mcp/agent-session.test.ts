import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { loadConfig } from '../../src/config.js'
import { createSiteApp } from '../../src/host/app.js'
import { ensureDataDir, readHostConfig } from '../../src/host/config.js'
import { AUTH } from '../../src/adapters/site/plugin.js'
import { mcpClient, type McpTestClient } from '../helpers/mcp.js'

/**
 * A scripted "realistic assistant" session against the example site: tool arguments are shaped the way Claude
 * sends them (dotted paths, Markdown, `inlay:media/` images, ids copied from earlier results), and the MCP client
 * shares the example app's core, so the public pages show what the session published.
 */

type Json = Record<string, any>

/** The dotted path of the first property titled `title` in a `describe_type` schema, as an assistant would read it. */
function pathTitled(schema: Json, title: string, at: string[] = []): string | null {
  for (const [key, child] of Object.entries((schema.properties ?? {}) as Record<string, Json>)) {
    if (child.title === title) return [...at, key].join('.')
    const found = pathTitled(child, title, [...at, key])
    if (found !== null) return found
  }
  return null
}

describe('an assistant editing the example site', () => {
  let dir: string
  let app: FastifyInstance
  let mcp: McpTestClient

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inlay-agent-'))
    const { config, dir: siteDir } = await loadConfig(resolve(import.meta.dirname, '../../example/inlay.config.ts'))
    const host = readHostConfig({
      INLAY_DATA_DIR: dir,
      INLAY_BASE_URL: 'http://localhost:3000',
      INLAY_SECRET: 's'.repeat(32),
      SLACK_WEBHOOK: '',
    })
    await ensureDataDir(host)
    ;({ app } = await createSiteApp(host, { site: config.site, publicDir: join(siteDir, 'public') }, { content: 'apply' }))
    const actor = await app.inlay[AUTH].createUser({
      email: 'eddie@example.com',
      name: 'Eddie Editor',
      password: 'editor-password',
      role: 'editor',
    })
    mcp = await mcpClient({ core: app.inlay.core, actor, elicitation: 'accept' })
  })

  afterAll(async () => {
    await mcp.close()
    await app.close()
    await rm(dir, { recursive: true, force: true })
  })

  async function call(name: string, args: object = {}): Promise<Json> {
    const res = await mcp.call(name, args)
    expect(res.isError, `${name}: ${res.text}`).toBe(false)
    return res.json
  }

  it('edits, writes, translates and publishes, and the site shows it', async () => {
    // 1. Find out what the site is.
    const site = await call('describe_site')
    expect(site.guide).toContain('warm, plain')
    const home = site.singletons.find((s: Json) => s.type === 'home')
    expect(home.help).toBeTruthy()
    expect(site.collections.map((c: Json) => c.type)).toEqual(['posts', 'services', 'testimonials'])

    // 2. Read Home.
    const homeDoc = await call('get_document', { type: 'home' })
    expect(homeDoc.content.slots.hero.data.headline).toBe('Websites that stay simple')

    // 3. Change the headline, at the path the type's schema gives.
    const homeType = await call('describe_type', { type: 'home' })
    const headlinePath = pathTitled(homeType.schema, 'Headline')
    expect(headlinePath).toBe('slots.hero.data.headline')
    const updated = await call('update_document', {
      id: homeDoc.id,
      baseRevisionId: homeDoc.revisionId,
      changes: [{ path: headlinePath, value: 'Websites you can run yourself' }],
      message: 'New headline',
    })
    expect(updated.changed).toBe(true)
    expect(updated.previewUrl).toMatch(/\/_inlay\/preview\?token=/)

    // 4. Write a post from notes, with an image from the library.
    const { media } = await call('list_media', { kind: 'image' })
    const hero = media.find((m: Json) => m.filename === 'hero.jpg')
    expect(hero).toBeDefined()
    const body = [
      'We have moved into a bigger studio, and it has a garden.',
      '',
      '## What changes for you',
      '',
      '- Same phone number and email',
      '- Meetings can now happen outdoors',
      '- Free parking on Fridays',
      '',
      `![The new studio garden](inlay:media/${hero.id})`,
      '',
      'Read more [about us](/about).',
    ].join('\n')
    const post = await call('create_entry', {
      collection: 'posts',
      content: { slug: 'new-studio', fields: { title: 'Our new studio', date: '2026-10-29', body } },
    })
    expect(post.url).toBeNull()
    expect(post.previewUrl).toMatch(/&path=%2Fblog%2Fnew-studio$/)
    const postDoc = await call('get_document', { id: post.id })
    expect(postDoc.content.fields.body).toContain('## What changes for you')
    expect(postDoc.content.fields.body).toContain(`inlay:media/${hero.id}`)

    // 5. Find a testimonial by a name typed without its accent.
    const { entries } = await call('search_entries', { collection: 'testimonials', query: 'maria' })
    expect(entries.map((e: Json) => e.title)).toEqual(['María López'])

    // 6. Translate About into Spanish and rewrite its title.
    const about = site.singletons.find((s: Json) => s.type === 'about')
    expect(about.documents.es).toBeUndefined()
    const es = await call('create_translation', { id: about.documents.en.id, locale: 'es' })
    const translated = await call('update_document', {
      id: es.id,
      baseRevisionId: es.revisionId,
      changes: [
        { path: 'fields.title', value: 'Quiénes somos' },
        { path: 'fields.body', value: 'Creamos **sitios web** para quienes escriben.' },
      ],
    })
    expect(translated.changed).toBe(true)

    // 7. See what is waiting.
    const { changes } = await call('list_pending_changes')
    const ids = changes.map((c: Json) => c.id)
    expect(ids).toEqual(expect.arrayContaining([homeDoc.id, post.id, es.id]))
    expect(changes.find((c: Json) => c.id === post.id).isNew).toBe(true)

    // 8. Publish everything; the client accepts the confirmation.
    const published = await call('publish', { ids, message: 'Headline, studio post and Spanish About' })
    expect(published.published.map((p: Json) => p.id).sort()).toEqual([...ids].sort())
    expect((await call('list_pending_changes')).changes).toEqual([])

    // 9. The public site shows the new copy.
    const urls = Object.fromEntries(published.published.map((p: Json) => [p.id, new URL(p.url).pathname]))
    expect(urls[homeDoc.id]).toBe('/')
    expect(urls[es.id]).toBe('/es/acerca')
    const expected: Record<string, string[]> = {
      '/': ['Websites you can run yourself'],
      '/blog/new-studio': [
        'Our new studio',
        '<h2>What changes for you</h2>',
        'Free parking on Fridays</p></li>',
        'alt="The new studio garden"',
        'href="/about"',
      ],
      '/blog': ['Our new studio'],
      '/es/acerca': ['Quiénes somos'],
    }
    for (const [url, copy] of Object.entries(expected)) {
      const res = await app.inject({ method: 'GET', url })
      expect([url, res.statusCode]).toEqual([url, 200])
      for (const text of copy) expect(res.body, url).toContain(text)
    }
  })
})
