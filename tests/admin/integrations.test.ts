import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { f } from '../../src/core/fields/builtins.js'
import type { Core } from '../../src/core/core.js'
import type { Ctx } from '../../src/core/types.js'
import { t } from '../../src/core/messages/index.js'
import { defineSite } from '../../src/core/registry/define.js'
import { defineIntegration } from '../../src/core/registry/integration.js'
import { parseHtml, signIn, submittedForm, type AdminClient } from '../helpers/admin.js'
import { makeApp } from '../helpers/app.js'
import { webSite } from '../fixtures/web.js'

const HINT = 'It looks like GTM-ABC123.'

const gtmWith = (pattern: RegExp) =>
  defineIntegration({
    name: 'gtm',
    label: 'Tag manager',
    description: 'Measures visits.',
    consent: 'marketing',
    csp: { 'script-src': ["'unsafe-inline'"] },
    fields: z.object({
      id: f.text({ label: 'Container ID', pattern, patternHint: HINT }),
      mode: f.select(['basic', 'full'], { label: 'Mode' }),
      debug: f.boolean({ label: 'Debug' }).optional(),
    }),
    head: () => '',
  })
const gtm = gtmWith(/^GTM-[A-Z0-9]+$/)
const chat = defineIntegration({ name: 'chat', label: 'Chat', preview: true, head: () => '' })
const site = defineSite({ ...webSite, integrations: [gtm, chat] })

const text = (html: string) => parseHtml(html).body.textContent ?? ''
const formOf = (html: string, name: string) => parseHtml(html).querySelector(`form[action="/admin/integrations/${name}"]`)

describe('admin integrations', () => {
  let app: FastifyInstance
  let core: Core
  let ownerCtx: Ctx
  let olivia: AdminClient
  let eddie: AdminClient

  beforeEach(async () => {
    ;({ app, core, owner: ownerCtx } = await makeApp({ withOwner: true, site }))
    await app.ready()
    olivia = await signIn(app, 'owner@example.com')
    eddie = await signIn(app, 'editor@example.com')
  })
  afterEach(() => app.close())

  const values = { enabled: 'true', id: 'GTM-A1', mode: 'full', debug: 'true' }

  it('an editor gets 403 on GET and POST, and no nav entry', async () => {
    expect((await eddie.get('/admin/integrations')).statusCode).toBe(403)
    expect((await eddie.post('/admin/integrations/gtm', values)).statusCode).toBe(403)
    expect(parseHtml((await eddie.get('/admin')).body).querySelectorAll('nav a[href="/admin/integrations"]')).toHaveLength(0)
  })

  it('the owner sees one form per integration with its label, description, switch and fields', async () => {
    const res = await olivia.get('/admin/integrations')
    expect(res.statusCode).toBe(200)
    const form = formOf(res.body, 'gtm')!
    expect((form.getAttribute('method') ?? '').toLowerCase()).toBe('post')
    expect(form.textContent).toContain('Tag manager')
    expect(form.textContent).toContain('Measures visits.')
    const enabled = form.querySelector('input[type=checkbox][name=enabled]')!
    expect(enabled.hasAttribute('checked')).toBe(false)
    expect(form.querySelector('input[name=id]')).not.toBeNull()
    expect(form.querySelector('select[name=mode]')).not.toBeNull()
    expect(form.querySelector('input[type=checkbox][name=debug]')).not.toBeNull()
    const other = formOf(res.body, 'chat')!
    expect(other.querySelectorAll('input[type=checkbox], input[type=text], select')).toHaveLength(1)
    expect(other.querySelector('input[name=enabled]')).not.toBeNull()
  })

  it('shows the consent line, the every-visitor line, the preview line and the script-protection note', async () => {
    const res = await olivia.get('/admin/integrations')
    const gtmText = formOf(res.body, 'gtm')!.textContent!
    expect(gtmText).toContain('marketing')
    expect(gtmText).toContain(t('admin.integrations.unsafeInline'))
    const chatText = formOf(res.body, 'chat')!.textContent!
    expect(chatText).toContain(t('admin.integrations.always'))
    expect(chatText).toContain(t('admin.integrations.preview'))
  })

  it("shows no script-protection note for 'unsafe-inline' under another directive", async () => {
    const styled = defineIntegration({ name: 'styled', label: 'Styled', csp: { 'style-src': ["'unsafe-inline'"] }, head: () => '' })
    const other = await makeApp({ withOwner: true, site: defineSite({ ...webSite, integrations: [styled] }) })
    await other.app.ready()
    try {
      const owner = await signIn(other.app, 'owner@example.com')
      const res = await owner.get('/admin/integrations')
      expect(res.statusCode).toBe(200)
      expect(formOf(res.body, 'styled')!.textContent).not.toContain(t('admin.integrations.unsafeInline'))
    } finally {
      await other.app.close()
    }
  })

  it("says that what is entered is visible in the pages' source", async () => {
    expect(text((await olivia.get('/admin/integrations')).body)).toContain(t('admin.integrations.public'))
  })

  it('saving switched on with valid values redirects with a notice and stores them', async () => {
    const res = await olivia.post('/admin/integrations/gtm', values)
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/integrations?notice=integrationSaved')
    const active = await core.activeIntegrations()
    expect(active.find((a) => a.def.name === 'gtm')?.values).toEqual({ id: 'GTM-A1', mode: 'full', debug: true })
    expect(text((await olivia.get('/admin/integrations?notice=integrationSaved')).body)).toContain(t('admin.notice.integrationSaved'))
  })

  it('saving switched on with a bad value answers 400, keeps what was typed and shows the error by the field', async () => {
    const res = await olivia.post('/admin/integrations/gtm', { ...values, id: 'nope' })
    expect(res.statusCode).toBe(400)
    const form = formOf(res.body, 'gtm')!
    const input = form.querySelector('input[name=id]')!
    expect(input.getAttribute('value')).toBe('nope')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(form.textContent).toContain(HINT)
    expect(await core.activeIntegrations()).toEqual([])
  })

  it('saving switched off with an empty required field is accepted', async () => {
    const res = await olivia.post('/admin/integrations/gtm', { id: '', mode: 'basic' })
    expect(res.statusCode).toBe(303)
    const [state] = await core.integrations(ownerCtx)
    expect(state?.enabled).toBe(false)
  })

  it('an unknown name answers 404', async () => {
    expect((await olivia.post('/admin/integrations/nope', values)).statusCode).toBe(404)
  })

  it('values that stopped passing after a release are shown with the switch on, and saving again reports the field', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inlay-integrations-'))
    const db = join(dir, 'site.db')
    const first = await makeApp({ site, withOwner: true, db })
    await first.app.ready()
    const before = await signIn(first.app, 'owner@example.com')
    expect((await before.post('/admin/integrations/gtm', values)).statusCode).toBe(303)
    await first.app.close()
    const later = defineSite({ ...webSite, integrations: [gtmWith(/^ZZZ-[0-9]+$/), chat] })
    const made = await makeApp({ site: later, db })
    await made.app.ready()
    try {
      const client = await signIn(made.app, 'owner@example.com')
      const res = await client.get('/admin/integrations')
      const form = formOf(res.body, 'gtm')!
      expect(form.querySelector('input[name=enabled]')!.hasAttribute('checked')).toBe(true)
      expect(form.querySelector('input[name=id]')!.getAttribute('value')).toBe('GTM-A1')
      expect(await made.core.activeIntegrations()).toEqual([])
      expect(form.textContent).toContain(t('admin.integrations.notRunning'))
      expect(formOf(res.body, 'chat')!.textContent).not.toContain(t('admin.integrations.notRunning'))
      const again = await client.post('/admin/integrations/gtm', submittedForm(res.body, { form: 'form[action="/admin/integrations/gtm"]' }))
      expect(again.statusCode).toBe(400)
      expect(formOf(again.body, 'gtm')!.querySelector('input[name=id]')!.getAttribute('aria-invalid')).toBe('true')
    } finally {
      await made.app.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('the nav lists Integrations for an owner only when the site defines one', async () => {
    const hrefs = (html: string) => [...parseHtml(html).querySelectorAll('nav a[href]')].map((a) => a.getAttribute('href'))
    expect(hrefs((await olivia.get('/admin')).body)).toContain('/admin/integrations')
    const none = await makeApp({ site: defineSite(webSite), withOwner: true })
    await none.app.ready()
    try {
      const client = await signIn(none.app, 'owner@example.com')
      expect(hrefs((await client.get('/admin')).body)).not.toContain('/admin/integrations')
      expect((await client.get('/admin/integrations')).statusCode).toBe(404)
    } finally {
      await none.app.close()
    }
  })

  it('a cross-origin POST is refused', async () => {
    const res = await olivia.post('/admin/integrations/gtm', values, { origin: 'https://evil.example' })
    expect(res.statusCode).toBe(403)
    expect(await core.activeIntegrations()).toEqual([])
  })
})
