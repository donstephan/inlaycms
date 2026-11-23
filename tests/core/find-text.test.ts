import { z } from 'zod'
import type { Core } from '../../src/core/core.js'
import { f } from '../../src/core/fields/builtins.js'
import { defineBlock, defineSingleton, defineSite, defineTemplate } from '../../src/core/registry/define.js'
import type { Ctx, DocumentData } from '../../src/core/types.js'
import { makeCore } from '../helpers/core.js'
import { Home, webSite } from '../fixtures/web.js'

const doc = (...blocks: unknown[]) => ({ type: 'doc', content: blocks })
const para = (...content: unknown[]) => ({ type: 'paragraph', content })
const text = (t: string, marks?: unknown[]) => ({ type: 'text', text: t, ...(marks && { marks }) })

describe('findText', () => {
  let core: Core
  let editor: Ctx

  beforeEach(async () => {
    ;({ core, editor } = await makeCore({ site: webSite }))
    await core.applyShippedContent()
  })

  const edit = async (type: string, change: (data: DocumentData) => void, locale?: string) => {
    const summary = (await core.findSingleton(type, locale))!
    const view = (await core.getDocument(summary.id))!
    const data = structuredClone(view.data)
    change(data)
    await core.saveDraft(summary.id, { baseRevisionId: view.headRev, data }, editor)
  }
  const quote = (value: string, author = 'Someone') =>
    core.createEntry('testimonials', { fields: { author, quote: value } }, editor)
  const body = (value: unknown) => (data: DocumentData) => {
    data.fields.body = value
  }

  it('finds pages, globals and entries in one call', async () => {
    await edit('about', body(doc(para(text('Meet Acme today')))))
    await edit('home', (d) => {
      d.slots.hero!.data.headline = 'Acme rules'
    })
    await edit('nav', (d) => {
      d.fields.links = [{ link: { url: '/x', text: 'Acme shop' } }]
    })
    await quote('Loved Acme')
    const result = await core.findText('acme')
    expect(result.total).toBe(4)
    expect(result.documents.map((d) => [d.document.type, d.matches[0]!.path])).toEqual([
      ['home', ['slots', 'hero', 'data', 'headline']],
      ['about', ['fields', 'body']],
      ['nav', ['fields', 'links', 0, 'link', 'text']],
      ['testimonials', ['fields', 'quote']],
    ])
  })

  it('searches every language unless a locale is given', async () => {
    await edit('about', body(doc(para(text('Acme')))))
    const about = (await core.findSingleton('about'))!
    const es = await core.createTranslation(about.groupId, 'es', editor)
    await core.saveDraft(es.id, { baseRevisionId: es.headRev, data: { ...es.data, fields: { ...es.data.fields, body: doc(para(text('Acme'))) } } }, editor)
    await quote('Acme')
    expect((await core.findText('acme')).documents.map((d) => d.document.locale)).toEqual(['en', 'es', 'en'])
    const onlyEs = await core.findText('acme', { locale: 'es' })
    expect(onlyEs.documents.map((d) => d.document.locale)).toEqual(['es'])
    expect((await core.findText('acme', { type: 'testimonials' })).documents.map((d) => d.document.type)).toEqual(['testimonials'])
  })

  it('groups by written form and numbers occurrences', async () => {
    await quote('Acme, ACME, Acme Corp')
    const { documents } = await core.findText('acme')
    const matches = documents[0]!.matches
    expect(matches).toHaveLength(2)
    expect(matches[0]).toMatchObject({ text: 'Acme', count: 2, occurrences: [{ n: 1 }, { n: 2 }] })
    expect(matches[1]).toMatchObject({ text: 'ACME', count: 1 })
  })

  it('caps occurrences at 20 but counts them all', async () => {
    await quote(Array.from({ length: 25 }, () => 'Acme').join(' '))
    const match = (await core.findText('acme')).documents[0]!.matches[0]!
    expect(match.count).toBe(25)
    expect(match.occurrences).toHaveLength(20)
  })

  it('flags spans across formatting and never matches across blocks', async () => {
    await edit('about', body(doc(para(text('Ac', [{ type: 'bold' }]), text('me')))))
    const hit = (await core.findText('acme')).documents[0]!.matches[0]!
    expect(hit.occurrences[0]!.spansFormatting).toBe(true)
    await edit('about', body(doc(para(text('Get')), para(text('started')))))
    expect((await core.findText('get started')).total).toBe(0)
  })

  it('never searches link targets', async () => {
    await edit('nav', (d) => {
      d.fields.links = [{ link: { url: '/acme', text: 'Shop' } }]
    })
    expect((await core.findText('acme')).total).toBe(0)
  })

  it('marks matches in switched-off slots', async () => {
    const Banner = defineBlock({
      name: 'banner',
      label: 'Banner',
      schema: z.object({ message: f.text({ label: 'Message' }) }),
      render: () => '',
    })
    const WithBanner = defineTemplate({
      name: 'home',
      label: 'Home page',
      fields: Home.fields,
      slots: { ...Home.slots, banner: { block: Banner, optional: true } },
      render: Home.render,
    })
    const site = defineSite({
      ...webSite,
      singletons: webSite.singletons.map((def) => (def.name === 'home' ? { ...def, template: WithBanner } : def)),
    })
    const made = await makeCore({ site })
    await made.core.applyShippedContent()
    const home = (await made.core.findSingleton('home'))!
    const created = (await made.core.getDocument(home.id))!
    const data = structuredClone(created.data)
    data.slots.hero = { enabled: true, data: { headline: 'Acme' } }
    data.slots.banner = { enabled: false, data: { message: 'Acme' } }
    await made.core.saveDraft(created.id, { baseRevisionId: created.headRev, data }, made.editor)
    const { documents } = await made.core.findText('acme')
    const [hero, banner] = documents[0]!.matches
    expect(hero!.path).toEqual(['slots', 'hero', 'data', 'headline'])
    expect('hidden' in hero!).toBe(false)
    expect(banner).toMatchObject({ path: ['slots', 'banner', 'data', 'message'], hidden: true })
  })

  it('lists matches in a switched-off slot in schema order', async () => {
    const Banner = defineBlock({
      name: 'banner',
      label: 'Banner',
      schema: z.object({ message: f.text({ label: 'Message' }), cta: f.link({ label: 'Button' }) }),
      render: () => '',
    })
    const WithBanner = defineTemplate({
      name: 'home',
      label: 'Home page',
      fields: Home.fields,
      slots: { banner: { block: Banner, optional: true }, ...Home.slots },
      render: Home.render,
    })
    const site = defineSite({
      ...webSite,
      singletons: webSite.singletons.map((def) => (def.name === 'home' ? { ...def, template: WithBanner } : def)),
    })
    const made = await makeCore({ site })
    await made.core.applyShippedContent()
    const home = (await made.core.findSingleton('home'))!
    const created = (await made.core.getDocument(home.id))!
    const data = structuredClone(created.data)
    data.slots.hero = { enabled: true, data: { headline: 'Acme' } }
    data.slots.banner = { enabled: false, data: { message: 'Acme', cta: { url: '/x', text: 'Acme' } } }
    await made.core.saveDraft(created.id, { baseRevisionId: created.headRev, data }, made.editor)
    const { documents } = await made.core.findText('acme')
    expect(documents[0]!.matches.map((m) => m.path)).toEqual([
      ['slots', 'banner', 'data', 'message'],
      ['slots', 'banner', 'data', 'cta', 'text'],
      ['slots', 'hero', 'data', 'headline'],
    ])
  })

  it('leaves deleted entries out', async () => {
    const gone = await quote('Acme')
    await core.deleteEntry(gone.groupId, editor)
    expect((await core.findText('acme')).total).toBe(0)
  })

  it('pages through matching documents', async () => {
    await quote('Acme one')
    await quote('Acme two')
    await quote('Acme three')
    const first = await core.findText('acme', { limit: 2 })
    expect([first.total, first.documents.length]).toEqual([3, 2])
    const second = await core.findText('acme', { limit: 2, offset: 2 })
    expect([second.total, second.documents.length]).toEqual([3, 1])
  })

  it('lists pages designed in code', async () => {
    const Bare = defineTemplate({ name: 'bare', label: 'Bare', fields: z.object({}), render: () => '' })
    const site = defineSite({
      locales: ['en'],
      defaultLocale: 'en',
      singletons: [defineSingleton({ name: 'bare', label: 'Bare page', template: Bare, path: '/' })],
    })
    const made = await makeCore({ site })
    expect((await made.core.findText('acme')).designedInCode).toEqual([{ type: 'bare', title: 'Bare page' }])
    expect((await core.findText('acme', { type: 'testimonials' })).designedInCode).toEqual([])
  })

  it('searches a draft that no longer fits the schema', async () => {
    await edit('about', (d) => {
      delete d.fields.title
      d.fields.body = doc(para(text('Acme')))
    })
    const { documents } = await core.findText('acme')
    expect(documents[0]!.matches[0]!.path).toEqual(['fields', 'body'])
  })
})
