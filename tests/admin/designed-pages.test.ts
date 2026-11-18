import { z } from 'zod'
import { t } from '../../src/core/messages/index.js'
import { defineContent } from '../../src/core/registry/content.js'
import { defineSingleton, defineSite, defineTemplate } from '../../src/core/registry/define.js'
import { designedInCode } from '../../src/core/registry/designed.js'
import { makeApp } from '../helpers/app.js'
import { mcpClient } from '../helpers/mcp.js'
import { makeCore } from '../helpers/core.js'
import { parseHtml, signIn } from '../helpers/admin.js'
import { Page } from '../fixtures/web.js'

/** A landing page whose words are all in its template: no fields, no slots. */
const Landing = defineTemplate({
  name: 'landing',
  label: 'Landing',
  fields: z.object({}),
  render: () => '<h1>Built for you</h1>',
})

const site = defineSite({
  locales: ['en'],
  defaultLocale: 'en',
  singletons: [
    defineSingleton({ name: 'landing', label: 'Landing', template: Landing, path: '/' }),
    defineSingleton({ name: 'about', label: 'About', template: Page, path: '/about' }),
  ],
  content: [
    defineContent('landing', { edition: 1, content: { en: { fields: {} } } }),
    defineContent('about', { edition: 1, content: { en: { fields: { title: 'About us', body: 'Hi' } } } }),
  ],
})

const textOf = (html: string) => parseHtml(html).body.textContent.replace(/\s+/g, ' ')

describe('designedInCode', () => {
  it('is true only for a template with no fields and no slots', () => {
    expect(designedInCode(Landing)).toBe(true)
    expect(designedInCode(Page)).toBe(false)
    expect(designedInCode({ ...Landing, slots: { x: { block: { label: 'X' } } } } as unknown as typeof Landing)).toBe(false)
  })
})

describe('a page designed in code, in the admin', () => {
  it('shows a notice instead of an empty form, and a badge in the pages list', async () => {
    const made = await makeApp({ withOwner: true, site })
    await made.app.ready()
    try {
      await made.core.applyShippedContent()
      const client = await signIn(made.app, 'editor@example.com')
      const landing = (await made.core.findSingleton('landing'))!
      const about = (await made.core.findSingleton('about'))!

      const editor = textOf((await client.get(`/admin/documents/${landing.id}`)).body)
      expect(editor).toContain(t('admin.editor.designedInCode'))
      expect(textOf((await client.get(`/admin/documents/${about.id}`)).body)).not.toContain(t('admin.editor.designedInCode'))

      const rows = [...parseHtml((await client.get('/admin/pages')).body).querySelectorAll('tbody tr')]
      const badgeIn = (label: string) =>
        rows.find((row) => row.textContent.includes(label))!.textContent.includes(t('admin.list.designedInCode'))
      expect(badgeIn('Landing')).toBe(true)
      expect(badgeIn('About')).toBe(false)
    } finally {
      await made.app.close()
    }
  })
})

describe('a page designed in code, over MCP', () => {
  it('marks the type in describe_site and describe_type, and refuses update_document with a plain message', async () => {
    const { core, editor } = await makeCore({ site })
    await core.applyShippedContent()
    const mcp = await mcpClient({ core, actor: editor.actor })
    try {
      const described = await mcp.call('describe_site', {})
      const singletons = described.json.singletons as Array<{ type: string; designedInCode?: boolean }>
      expect(singletons.find((s) => s.type === 'landing')!.designedInCode).toBe(true)
      expect(singletons.find((s) => s.type === 'about')!.designedInCode).toBeUndefined()

      const type = await mcp.call('describe_type', { type: 'landing' })
      expect(type.json.designedInCode).toBe(true)
      expect(type.json.note).toBe(t('mcp.designedInCode'))
      expect((await mcp.call('describe_type', { type: 'about' })).json).not.toHaveProperty('designedInCode')

      const landing = (await core.findSingleton('landing'))!
      const update = await mcp.call('update_document', {
        id: landing.id,
        baseRevisionId: landing.headRev,
        changes: [{ path: 'fields.title', value: 'Hello' }],
      })
      expect(update.isError).toBe(true)
      expect(update.text).toContain(t('mcp.designedInCode'))
    } finally {
      await mcp.close()
    }
  })
})
