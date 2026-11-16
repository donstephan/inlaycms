import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Core } from '../../src/core/core.js'
import type { SiteDefinition } from '../../src/core/registry/define.js'
import type { Ctx, DocumentSummary } from '../../src/core/types.js'
import { makeApp } from '../helpers/app.js'
import { parseHtml, signIn, type AdminClient } from '../helpers/admin.js'
import { f } from '../../src/core/fields/builtins.js'
import { defineTemplate } from '../../src/core/registry/define.js'
import { postSummarySite, ratedSite, withType } from '../fixtures/evolve.js'
import { BasicPage, site } from '../fixtures/site.js'

/** `site` with a required Subtitle on the About page. */
const aboutSubtitledSite = withType(site, 'about', {
  template: defineTemplate({ ...BasicPage, name: 'subtitledPage', fields: BasicPage.fields.extend({ subtitle: f.text({ label: 'Subtitle' }) }) }),
})

const textOf = (html: string) => parseHtml(html).body.textContent.replace(/\s+/g, ' ')
const editorUrl = (id: string) => `/admin/documents/${encodeURIComponent(id)}`

describe('gaps in the admin', () => {
  let file: string
  let first: { app: FastifyInstance; core: Core; owner: Ctx; editor: Ctx }
  let maria: DocumentSummary
  const apps: FastifyInstance[] = []

  beforeEach(async () => {
    file = join(await mkdtemp(join(tmpdir(), 'inlay-gaps-')), 'site.db')
    first = await makeApp({ site, db: file, withOwner: true })
    apps.push(first.app)
    await first.app.ready()
    maria = (await first.core.listEntries('testimonials'))[0]!
    await first.core.publish([maria.id], first.owner)
  })
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  /** The site after a release that changed it, over the same database. */
  async function next(changed: SiteDefinition): Promise<{ core: Core; olivia: AdminClient; eddie: AdminClient }> {
    await first.app.close()
    const made = await makeApp({ site: changed, db: file })
    apps.push(made.app)
    await made.app.ready()
    return { core: made.core, olivia: await signIn(made.app, 'owner@example.com'), eddie: await signIn(made.app, 'editor@example.com') }
  }

  it('summarises gaps on the dashboard, linking to the list', async () => {
    const { olivia } = await next(ratedSite)
    const doc = parseHtml((await olivia.get('/admin')).body)
    const card = doc.querySelector('section[aria-labelledby="gaps-heading"]')
    expect(card).not.toBeNull()
    const link = card!.querySelector('a[href="/admin/collections/testimonials"]')
    expect(link?.textContent).toBe('Testimonials: 1 published item needs attention')
  })

  it('links the dashboard to the list in the language all of a collection\'s gaps are in', async () => {
    const es = await first.core.createTranslation(maria.groupId, 'es', first.editor)
    await first.core.publish([es.id], first.owner)
    const both = await next(ratedSite)
    const before = parseHtml((await both.olivia.get('/admin')).body).querySelector('section[aria-labelledby="gaps-heading"] a')
    expect(before?.getAttribute('href')).toBe('/admin/collections/testimonials')

    const english = (await both.core.getDocument(maria.id))!
    await both.core.saveDraft(maria.id, { baseRevisionId: english.headRev, data: { ...english.data, fields: { ...english.data.fields, rating: 5 } } }, first.editor)
    await both.core.publish([maria.id], first.owner)
    const after = parseHtml((await both.olivia.get('/admin')).body).querySelector('section[aria-labelledby="gaps-heading"] a')
    expect(after?.getAttribute('href')).toBe('/admin/collections/testimonials?locale=es')
    const list = parseHtml((await both.olivia.get(after!.getAttribute('href')!)).body)
    expect(list.querySelector(`a[href="${editorUrl(es.id)}"]`)?.closest('tr')?.textContent).toContain('Needs attention')
  })

  it('leaves the dashboard card out when there are no gaps', async () => {
    const { olivia } = await next(site)
    const doc = parseHtml((await olivia.get('/admin')).body)
    expect(doc.querySelector('section[aria-labelledby="gaps-heading"]')).toBeNull()
  })

  it('marks the gapped row in the collection list', async () => {
    const extra = await first.core.createEntry('testimonials', { fields: { quote: 'Q', author: 'Zed' } }, first.editor)
    const { olivia } = await next(ratedSite)
    const doc = parseHtml((await olivia.get('/admin/collections/testimonials')).body)
    const rowOf = (id: string) => doc.querySelector(`a[href="${editorUrl(id)}"]`)!.closest('tr')!
    expect(rowOf(maria.id).textContent).toContain('Needs attention')
    // A draft that was never published has no gap, even though it misses the same field.
    expect(rowOf(extra.id).textContent).not.toContain('Needs attention')
  })

  it('marks a gapped page and links the dashboard to the pages list', async () => {
    const about = (await first.core.findSingleton('about'))!
    await first.core.publish([about.id], first.owner)
    const { olivia } = await next(aboutSubtitledSite)
    const doc = parseHtml((await olivia.get('/admin/pages')).body)
    const rowOf = (label: string) => [...doc.querySelectorAll('tbody tr')].find((r) => r.textContent.includes(label))!
    expect(rowOf('About').textContent).toContain('Needs attention')
    expect(rowOf('Home').textContent).not.toContain('Needs attention')
    const card = parseHtml((await olivia.get('/admin')).body).querySelector('section[aria-labelledby="gaps-heading"]')!
    expect(card.querySelector('a[href="/admin/pages"]')?.textContent).toBe('About: 1 published item needs attention')
  })

  it('counts each gapped type once on the dashboard', async () => {
    await first.core.createEntry('posts', { slug: 'a', fields: { title: 'A', date: '2026-01-01', body: 'x' } }, first.editor).then((a) =>
      first.core.publish([a.id], first.owner),
    )
    const { olivia } = await next(postSummarySite)
    const links = [...parseHtml((await olivia.get('/admin')).body).querySelectorAll('section[aria-labelledby="gaps-heading"] a')]
    expect(links.map((a) => [a.getAttribute('href'), a.textContent])).toEqual([['/admin/collections/posts', 'Posts: 1 published item needs attention']])
  })

  it('names the empty fields above the editor form', async () => {
    const { olivia } = await next(ratedSite)
    const doc = parseHtml((await olivia.get(editorUrl(maria.id))).body)
    const alerts = [...doc.querySelectorAll('#editor-form .alert-warning')].map((a) => a.textContent.replace(/\s+/g, ' ').trim())
    expect(alerts).toContain('This is live with 1 required field left empty: Rating. Fill it in and publish again.')
  })

  it('no duplicate field warnings', async () => {
    const { olivia } = await next(ratedSite)
    const doc = parseHtml((await olivia.get(editorUrl(maria.id))).body)
    const hints = [...doc.querySelectorAll('[id$="-hint"]')].filter((el) => el.textContent.includes('Needed before publishing'))
    expect(hints.map((el) => el.id)).toEqual(['f-fields-rating-hint'])
    expect(doc.body.textContent.match(/Rating is required/g)).toHaveLength(1)
  })

  it('a draft-only change never produces a gap', async () => {
    const about = (await first.core.findSingleton('about'))!
    await first.core.publish([about.id], first.owner)
    await first.core.patchDraft(about.id, { baseRevisionId: about.headRev, ops: [{ path: ['fields', 'body'], value: '' }] }, first.editor)
    const { olivia, core } = await next(site)
    expect(await core.listGaps()).toEqual([])
    expect(textOf((await olivia.get('/admin/pages')).body)).not.toContain('Needs attention')
    const doc = parseHtml((await olivia.get(editorUrl(about.id))).body)
    expect(doc.body.textContent).not.toContain('This is live with')
  })

  it('shows an editor the same markers', async () => {
    const { eddie } = await next(ratedSite)
    expect(parseHtml((await eddie.get('/admin')).body).querySelector('section[aria-labelledby="gaps-heading"]')).not.toBeNull()
    expect(textOf((await eddie.get('/admin/collections/testimonials')).body)).toContain('Needs attention')
    expect(textOf((await eddie.get(editorUrl(maria.id))).body)).toContain('This is live with 1 required field left empty: Rating.')
  })
})
