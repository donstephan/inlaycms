import { z } from 'zod'
import type { Core } from '../../src/core/core.js'
import { t } from '../../src/core/messages/index.js'
import { defineSingleton, defineSite, defineTemplate } from '../../src/core/registry/define.js'
import { markdownToRichText } from '../../src/core/richtext/markdown.js'
import type { Ctx } from '../../src/core/types.js'
import { webSite } from '../fixtures/web.js'
import { makeCore } from '../helpers/core.js'
import { mcpClient, type McpTestClient } from '../helpers/mcp.js'

let core: Core
let owner: Ctx
let editor: Ctx
let mcp: McpTestClient

beforeEach(async () => {
  ;({ core, owner, editor } = await makeCore({ site: webSite }))
  await core.applyShippedContent()
  mcp = await mcpClient({ core, actor: editor.actor })
})

afterEach(async () => {
  await mcp.close()
})

async function put(type: string, path: string[], value: unknown) {
  const doc = (await core.findSingleton(type))!
  await core.patchDraft(doc.id, { baseRevisionId: doc.headRev, ops: [{ path, value }] }, owner)
}

describe('find_text', () => {
  it('finds text across the site with paths, revision ids and occurrences', async () => {
    await put('home', ['slots', 'hero', 'data', 'headline'], 'Welcome to Acme')
    await put('about', ['fields', 'body'], (markdownToRichText('We are Acme, a small team.') as { doc: unknown }).doc)
    const { isError, json } = await mcp.call('find_text', { text: 'acme' })
    expect(isError).toBe(false)
    expect(json.total).toBe(2)
    expect(json.designedInCode).toBeUndefined()
    const home = (await core.findSingleton('home'))!
    const doc = json.documents.find((d: any) => d.type === 'home')
    expect(doc).toMatchObject({ id: home.id, kind: 'singleton', revisionId: home.headRev, hasUnpublishedChanges: true })
    expect(doc.matches[0]).toEqual({
      path: 'slots.hero.data.headline',
      text: 'Acme',
      count: 1,
      occurrences: [{ n: 1, snippet: expect.stringContaining('Acme') }],
    })
    expect(json.documents.some((d: any) => d.type === 'about')).toBe(true)
  })

  it('finds button labels', async () => {
    await put('home', ['slots', 'hero', 'data', 'cta'], { url: '/x', text: 'Try Acme' })
    const { json } = await mcp.call('find_text', { text: 'Acme' })
    expect(json.documents[0].matches.map((m: any) => m.path)).toEqual(['slots.hero.data.cta.text'])
  })

  it('refuses blank text, an unknown type and an unknown language', async () => {
    const blank = await mcp.call('find_text', { text: '  ' })
    expect(blank.isError).toBe(true)
    expect(blank.text).toContain(t('mcp.findText.blank'))
    const accent = await mcp.call('find_text', { text: '\u0301' })
    expect(accent.isError).toBe(true)
    expect(accent.text).toContain(t('mcp.findText.blank'))
    const type = await mcp.call('find_text', { text: 'a', type: 'nope' })
    expect(type.isError).toBe(true)
    expect(type.text).toContain(t('error.typeNotFound', { name: 'nope' }))
    const locale = await mcp.call('find_text', { text: 'a', locale: 'xx' })
    expect(locale.isError).toBe(true)
    expect(locale.text).toContain(t('mcp.unknownLocale', { locale: 'xx', locales: 'en, es' }))
  })

  it('lists pages designed in code with a note', async () => {
    const Bare = defineTemplate({ name: 'bare', label: 'Bare', fields: z.object({}), render: () => '' })
    const bare = defineSite({
      locales: ['en'],
      defaultLocale: 'en',
      singletons: [defineSingleton({ name: 'bare', label: 'Bare page', template: Bare, path: '/' })],
    })
    const made = await makeCore({ site: bare })
    const other = await mcpClient({ core: made.core, actor: made.editor.actor })
    try {
      const { json } = await other.call('find_text', { text: 'acme' })
      expect(json.designedInCode).toEqual([{ type: 'bare', title: 'Bare page' }])
      expect(json.note).toBe(t('mcp.findText.designedInCode'))
    } finally {
      await other.close()
    }
  })
})
