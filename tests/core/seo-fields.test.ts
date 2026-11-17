import { z } from 'zod'
import { checkWithoutDatabase } from '../../src/core/check.js'
import { InlayError } from '../../src/core/errors.js'
import { f } from '../../src/core/fields/builtins.js'
import { defineContent } from '../../src/core/registry/content.js'
import { defineGlobal, defineSingleton, defineSite, defineTemplate } from '../../src/core/registry/define.js'
import { makeCore } from '../helpers/core.js'

const title = 'x'.repeat(96)
const description = 'y'.repeat(264)

const Page = defineTemplate({
  name: 'page',
  label: 'Page',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    seo: f.seo().optional(),
  }),
  render: (p) => `<main>${p.fields.title}</main>`,
})

const site = defineSite({
  locales: ['en'],
  defaultLocale: 'en',
  singletons: [defineSingleton({ name: 'home', label: 'Home', template: Page, path: '/' })],
  collections: [],
  globals: [],
  content: [defineContent('home', { edition: 1, content: { en: { fields: { title: 'Home', seo: { title, description } } } } })],
})

describe('SEO fields with long text', () => {
  it('ships, saves and passes check with a 96-character title and a 264-character description', async () => {
    expect((await checkWithoutDatabase({ site })).ok).toBe(true)
    const { core, owner } = await makeCore({ site })
    await core.applyShippedContent()
    const home = (await core.findSingleton('home'))!
    const published = (await core.getDocument(home.id, { state: 'published' }))!
    expect((published.data.fields.seo as { title: string }).title).toHaveLength(96)
    const doc = (await core.getDocument(home.id))!
    await core.saveDraft(home.id, { baseRevisionId: doc.headRev, data: { ...doc.data, fields: { ...doc.data.fields, seo: { title, description } } } }, owner)
  })

  it('refuses 301 and 501 characters', async () => {
    const { core, owner } = await makeCore({ site })
    await core.applyShippedContent()
    const home = (await core.findSingleton('home'))!
    const doc = (await core.getDocument(home.id))!
    for (const seo of [{ title: 'x'.repeat(301) }, { description: 'y'.repeat(501) }]) {
      await expect(
        core.saveDraft(home.id, { baseRevisionId: doc.headRev, data: { ...doc.data, fields: { ...doc.data.fields, seo } } }, owner),
      ).rejects.toMatchObject({ code: 'validation' })
    }
  })
})

describe('f.seoDefaults()', () => {
  it('refuses to save a title template without %s', async () => {
    const Settings = defineTemplate({ name: 'settings', label: 'Settings', fields: z.object({ defaults: f.seoDefaults().optional() }) })
    const withGlobal = defineSite({
      locales: ['en'],
      defaultLocale: 'en',
      globals: [defineGlobal({ name: 'settings', label: 'Settings', template: Settings })],
      content: [defineContent('settings', { edition: 1, content: { en: { fields: {} } } })],
    })
    const { core, owner } = await makeCore({ site: withGlobal })
    await core.applyShippedContent()
    const global = (await core.findSingleton('settings'))!
    const doc = (await core.getDocument(global.id))!
    const save = (titleTemplate: string) =>
      core.saveDraft(global.id, { baseRevisionId: doc.headRev, data: { ...doc.data, fields: { defaults: { titleTemplate } } } }, owner)
    await expect(save('RealCISO')).rejects.toMatchObject({ code: 'validation' })
    const error = (await save('RealCISO').catch((e: unknown) => e)) as InlayError
    expect(error.details.issues?.map((i) => i.message)).toEqual([
      expect.stringContaining('%s'),
    ])
  })
})
