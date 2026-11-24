import type { Core } from '../../src/core/core.js'
import { InlayError } from '../../src/core/errors.js'
import { t } from '../../src/core/messages/index.js'
import { defineSingleton, defineSite } from '../../src/core/registry/define.js'
import type { Ctx, DocumentSummary } from '../../src/core/types.js'
import { Hero, Home, webSite } from '../fixtures/web.js'
import { HASHES_HEADER, panePolicy } from '../../src/adapters/admin/screens/preview-pane.js'
import { makeApp } from '../helpers/app.js'
import { signIn, submittedForm, type AdminClient } from '../helpers/admin.js'

const HOSTILE = '"><script>alert(1)</script>'
const paneUrl = (id: string) => `/admin/documents/${id}/preview`
const blankUrl = (id: string) => `/admin/documents/${id}/preview/blank`

describe('admin preview pane', () => {
  let app: Awaited<ReturnType<typeof makeApp>>['app']
  let core: Core
  let eddie: AdminClient
  let home: DocumentSummary
  let editor: Ctx

  const bodyFor = async (doc: DocumentSummary, headline?: string) => {
    const page = await eddie.get(`/admin/documents/${doc.id}`)
    const form = submittedForm(page.body, { form: '#editor-form', submitter: { name: '_action', value: 'save' } })
    if (headline !== undefined) form.set('slots.hero.data.headline', headline)
    return form
  }

  beforeEach(async () => {
    ;({ app, core, editor } = await makeApp({ withOwner: true }))
    eddie = await signIn(app, 'editor@example.com')
    home = (await core.findSingleton('home', 'en'))!
  })
  afterEach(async () => {
    await app.close()
  })

  it('renders unsaved form data and saves nothing', async () => {
    const before = (await core.listRevisions(home.id)).length
    const res = await eddie.post(paneUrl(home.id), await bodyFor(home, 'Draft headline'))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Draft headline')
    expect(res.body).toContain('<!--inlay:slot hero-->')
    expect((await core.listRevisions(home.id)).length).toBe(before)
    expect((await core.getDocument(home.id))!.data.slots.hero!.data.headline).toBe('Welcome to Inlay')
  })

  it('reads the form as the pane posts it', async () => {
    // What fetch sends for the URLSearchParams body the pane script builds from the form.
    const sent = new Request('https://example.com/', { method: 'POST', body: await bodyFor(home, 'Typed & sent') })
    const res = await eddie.post(paneUrl(home.id), new URLSearchParams(await sent.text()), {
      'content-type': sent.headers.get('content-type')!,
    })
    expect(sent.headers.get('content-type')).toBe('application/x-www-form-urlencoded;charset=UTF-8')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Typed &amp; sent')
  })

  it('renders the saved draft on GET', async () => {
    const res = await eddie.get(paneUrl(home.id))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Welcome to Inlay')
  })

  it('sends site-page headers', async () => {
    const get = await eddie.get(paneUrl(home.id))
    const post = await eddie.post(paneUrl(home.id), await bodyFor(home))
    for (const res of [get, post]) {
      const csp = String(res.headers['content-security-policy'])
      expect(csp).toMatch(/(^|; )script-src 'self'(;|$)/)
      expect(csp).toContain("form-action 'self'")
      expect(csp).toContain("frame-ancestors 'self'")
      expect(res.headers['cache-control']).toContain('no-store')
      expect(res.headers['x-robots-tag']).toBe('noindex')
    }
  })

  it('answers 422 with a plain message when something required is empty', async () => {
    const res = await eddie.post(paneUrl(home.id), await bodyFor(home, ''))
    expect(res.statusCode).toBe(422)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.json<{ message: string }>().message).toMatch(/^Fill this in to update the preview:/)
  })

  it('answers 500 with a plain message when the template throws', async () => {
    const boom = {
      ...Hero,
      render: (p: { headline: string }) => {
        if (p.headline === 'boom') throw new InlayError('config', 'config.renderMissing', { name: 'hero' })
        return `<h1>${p.headline}</h1>`
      },
    }
    const template = { ...Home, slots: { ...Home.slots, hero: { block: boom } } }
    const site = defineSite({
      ...webSite,
      singletons: [
        defineSingleton({ ...webSite.singletons.find((s) => s.name === 'home')!, template }),
        ...webSite.singletons.filter((s) => s.name !== 'home'),
      ],
    })
    const made = await makeApp({ withOwner: true, site })
    try {
      const client = await signIn(made.app, 'editor@example.com')
      const doc = (await made.core.findSingleton('home', 'en'))!
      const page = await client.get(`/admin/documents/${doc.id}`)
      const form = submittedForm(page.body, { form: '#editor-form', submitter: { name: '_action', value: 'save' } })
      form.set('slots.hero.data.headline', 'boom')
      const res = await client.post(paneUrl(doc.id), form)
      expect(res.statusCode).toBe(500)
      expect(res.json<{ message: string }>().message).toBe(t('admin.preview.failed'))
    } finally {
      await made.app.close()
    }
  })

  it('escapes what was typed', async () => {
    const res = await eddie.post(paneUrl(home.id), await bodyFor(home, HOSTILE))
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('<script>alert(1)')
    expect(res.body).toContain('&lt;script&gt;alert(1)')
  })

  it('previews the Spanish version at its own path', async () => {
    const es = (await core.findSingleton('home', 'es'))!
    const live = (await core.liveDocuments([es.groupId], 'es', { state: 'preview' })).get(es.groupId)!
    const res = await eddie.get(paneUrl(es.id))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(`<base href="${live.path}"`)
    expect(res.body).toContain('Bienvenido a Inlay')
  })

  it('has no pane for globals, data entries and pages without an address', async () => {
    const nav = (await core.findSingleton('nav', 'en'))!
    const entry = await core.createEntry('testimonials', { fields: { author: 'Maria', quote: 'Great' } }, editor)
    const notFoundPage = (await core.findSingleton('notFound', 'en'))!
    for (const id of [nav.id, entry.id, notFoundPage.id, 'nope']) {
      for (const url of [paneUrl(id), blankUrl(id)]) {
        const res = await eddie.get(url)
        expect(res.statusCode, url).toBe(404)
        expect(res.headers['content-security-policy'], url).toContain("script-src 'self'")
        expect(res.headers['content-security-policy'], url).toContain("frame-ancestors 'none'")
      }
    }
  })

  it('names the page\'s inline-script hashes on POST, for the empty page it is written into', async () => {
    const post = await eddie.post(paneUrl(home.id), await bodyFor(home))
    expect(post.headers[HASHES_HEADER]).toBe('')
    expect((await eddie.get(paneUrl(home.id))).headers[HASHES_HEADER]).toBeUndefined()
  })

  it('lets the empty page allow only well-formed script hashes', async () => {
    const good = 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='
    const query = [good, "'unsafe-inline'", 'sha256-x; script-src *', 'https://evil.example'].map((h) => `h=${encodeURIComponent(h)}`).join('&')
    const res = await eddie.get(`${blankUrl(home.id)}?n=1&${query}`)
    expect(res.statusCode).toBe(200)
    const csp = String(res.headers['content-security-policy'])
    expect(csp).toContain(`script-src 'self' '${good}';`)
    expect(csp).not.toContain('unsafe-inline\' ')
    expect(csp).not.toContain('evil.example')
    expect(csp).not.toContain('script-src *')
  })

  it('serves an empty page with the pane headers for each update to start from', async () => {
    const res = await eddie.get(`${blankUrl(home.id)}?n=3`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(String(res.headers['content-security-policy'])).toMatch(/(^|; )script-src 'self'(;|$)/)
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'self'")
    expect(res.headers['cache-control']).toContain('no-store')
    expect(res.headers['x-robots-tag']).toBe('noindex')
    expect(res.body).toMatch(/^<!doctype html>/)
    expect(res.body).not.toContain('<script')
    expect(res.body).toMatch(/<body><\/body>/)
    const anon = await app.inject({ method: 'GET', url: blankUrl(home.id) })
    expect(anon.statusCode).toBe(302)
  })

  it('needs a session and a same-origin POST', async () => {
    const anon = await app.inject({ method: 'GET', url: paneUrl(home.id) })
    expect(anon.statusCode).toBe(302)
    expect(anon.headers.location).toContain('/admin/login')
    const res = await eddie.post(paneUrl(home.id), await bodyFor(home), { origin: 'https://evil.example' })
    expect(res.statusCode).toBe(403)
  })
})

describe('panePolicy', () => {
  const site = (headers: Record<string, string | false>) => ({ ...webSite, csp: {}, headers }) as unknown as Parameters<typeof panePolicy>[0]

  it('is the public policy with the page\'s hashes', () => {
    const csp = panePolicy(site({}), ["'sha256-abc='"])
    expect(csp).toContain("script-src 'self' 'sha256-abc=';")
    expect(csp).toContain("frame-ancestors 'self'")
  })

  it('keeps a site\'s own policy, framed by the admin only', () => {
    expect(panePolicy(site({ 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; img-src *" }), [])).toBe(
      "default-src 'none'; img-src *; frame-ancestors 'self'",
    )
  })

  it('is only the framing rule when the site removes the policy', () => {
    expect(panePolicy(site({ 'content-security-policy': false }), [])).toBe("frame-ancestors 'self'")
  })
})
