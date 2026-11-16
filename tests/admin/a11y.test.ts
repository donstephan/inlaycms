import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import type { AuthService } from '../../src/core/auth/service.js'
import type { Core } from '../../src/core/core.js'
import { InlayError } from '../../src/core/errors.js'
import type { Ctx } from '../../src/core/types.js'
import { adminSite } from '../fixtures/admin.js'
import { jpeg, png } from '../fixtures/media.js'
import { generateKeyPair } from '../../src/core/release/keys.js'
import { packRelease } from '../../src/core/release/pack.js'
import { makeApp } from '../helpers/app.js'
import { parseHtml, signIn, submittedForm, type AdminClient } from '../helpers/admin.js'

const FORM = '#editor-form'
const SAVE = { name: '_action', value: 'save' }

const CONTROLS = 'input:not([type=hidden]):not([type=submit]), select, textarea'

/** Inside `aria-hidden="true"`, so out of the accessibility tree. */
const hidden = (el: Element) => el.closest('[aria-hidden="true"]') !== null

const nameOf = (el: Element) => (el.textContent ?? '').trim() !== '' || (el.getAttribute('aria-label') ?? '').trim() !== ''

/**
 * Every accessibility problem the sweep looks for, as readable strings. A `fragment` (what htmx swaps into a page, such
 * as a picker) skips the checks that only apply to a whole page.
 */
function problemsOf(res: LightMyRequestResponse, opts: { fragment?: boolean } = {}): string[] {
  const problems: string[] = []
  const doc = parseHtml(res.body)
  const describe = (el: Element) => el.outerHTML.slice(0, 160)

  if (opts.fragment !== true) {
    if ((doc.documentElement.getAttribute('lang') ?? '') === '') problems.push('html has no lang')
    const h1s = doc.querySelectorAll('h1').length
    if (h1s !== 1) problems.push(`${h1s} h1 elements`)
    if (!doc.querySelector('a[href="#main"]')) problems.push('no skip link')
    if (!doc.querySelector('main#main')) problems.push('no main#main')
  }

  const labeled = new Set([...doc.querySelectorAll('label[for]')].map((l) => l.getAttribute('for')))
  for (const el of doc.querySelectorAll(CONTROLS)) {
    if (hidden(el)) continue
    const id = el.getAttribute('id')
    if (id !== null && labeled.has(id)) continue
    if ((el.getAttribute('aria-label') ?? '').trim() !== '' || el.hasAttribute('aria-labelledby')) continue
    const type = (el.getAttribute('type') ?? '').toLowerCase()
    if ((type === 'radio' || type === 'checkbox') && el.closest('fieldset')?.querySelector(':scope > legend')) continue
    problems.push(`unlabeled control ${describe(el)}`)
  }

  const ids = new Map<string, number>()
  for (const el of doc.querySelectorAll('[id]')) {
    const id = el.getAttribute('id')!
    ids.set(id, (ids.get(id) ?? 0) + 1)
  }
  for (const [id, count] of ids) if (count > 1) problems.push(`id "${id}" used ${count} times`)

  for (const img of doc.querySelectorAll('img')) if (!img.hasAttribute('alt')) problems.push(`img without alt ${describe(img)}`)

  for (const el of doc.querySelectorAll('button, a[href]')) {
    if (hidden(el)) continue
    const img = el.querySelector('img[alt]')
    if (!nameOf(el) && (img?.getAttribute('alt') ?? '').trim() === '') problems.push(`no accessible name ${describe(el)}`)
  }

  // A name on an element without a role is ignored by screen readers.
  for (const el of doc.querySelectorAll('div[aria-label]:not([role]), span[aria-label]:not([role])')) {
    problems.push(`aria-label without a role ${describe(el)}`)
  }

  for (const el of doc.querySelectorAll('label[for]')) {
    if ((el.textContent ?? '').trim() === '') problems.push(`empty label ${describe(el)}`)
  }

  for (const el of doc.querySelectorAll('[tabindex]')) {
    if (Number(el.getAttribute('tabindex')) > 0) problems.push(`positive tabindex ${describe(el)}`)
  }

  for (const el of doc.querySelectorAll('*')) {
    for (const attr of el.getAttributeNames()) {
      if (/^on/i.test(attr)) problems.push(`inline handler ${attr} on ${describe(el)}`)
    }
  }
  for (const script of doc.querySelectorAll('script')) {
    if (!script.hasAttribute('src')) problems.push(`inline script ${describe(script)}`)
  }

  for (const el of doc.querySelectorAll('[aria-describedby]')) {
    for (const id of (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((s) => s !== '')) {
      if (!ids.has(id)) problems.push(`aria-describedby "${id}" missing on ${describe(el)}`)
    }
  }
  for (const el of doc.querySelectorAll('[aria-labelledby]')) {
    for (const id of (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter((s) => s !== '')) {
      if (!ids.has(id)) problems.push(`aria-labelledby "${id}" missing on ${describe(el)}`)
    }
  }

  if (!String(res.headers['content-security-policy'] ?? '').includes("script-src 'self'")) problems.push('no CSP header')
  return problems
}

function expectAccessible(url: string, res: LightMyRequestResponse, status = 200, opts: { fragment?: boolean } = {}) {
  expect([url, res.statusCode], res.body.slice(0, 800)).toEqual([url, status])
  expect({ url, problems: problemsOf(res, opts) }).toEqual({ url, problems: [] })
}

const HX = { 'hx-request': 'true' }

describe('admin accessibility sweep', () => {
  let app: FastifyInstance
  let core: Core
  let owner: Ctx
  let service: AuthService
  let olivia: AdminClient

  beforeEach(async () => {
    ;({ app, core, owner, service } = await makeApp({ withOwner: true, site: adminSite }))
    await app.ready()
    olivia = await signIn(app, 'owner@example.com')
  })
  afterEach(() => app.close())

  it('passes on every screen', async () => {
    const post = await core.createEntry(
      'posts',
      {
        slug: 'hello-world',
        fields: {
          title: 'Hello world',
          date: '2026-01-02',
          body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Some words.' }] }] },
        },
      },
      owner,
    )
    const { media } = await core.addMedia({ data: await jpeg(40, 30), filename: 'hero.jpg' }, owner)
    await core.setMediaAlt(media.id, 'A hero', owner)
    await core.createRedirect({ from: '/old', to: '/blog', note: 'Moved' }, owner)
    const extra = await service.createUser({
      email: 'ada@example.com',
      name: 'Ada Author',
      password: 'a long enough password',
      role: 'editor',
    })
    await core.backup(owner)

    const kitchen = (await core.findSingleton('kitchen', 'en'))!
    await core.patchDraft(
      kitchen.id,
      { baseRevisionId: kitchen.headRev, ops: [{ path: ['fields', 'hero'], value: { media: media.id, alt: 'Hero' } }] },
      owner,
    )
    const revisions = await core.listRevisions(kitchen.id)
    const revision = revisions[revisions.length - 1]!
    const backups = await core.listBackups(owner)

    const urls = [
      '/admin',
      '/admin/pages',
      '/admin/globals',
      '/admin/collections/posts',
      '/admin/collections/posts?locale=es',
      '/admin/collections/posts?deleted=1',
      '/admin/collections/posts/new',
      `/admin/collections/posts/delete?ids=${post.id}`,
      `/admin/documents/${kitchen.id}`,
      `/admin/documents/${post.id}`,
      `/admin/documents/${kitchen.id}/history`,
      `/admin/documents/${kitchen.id}/history/${revision.id}`,
      '/admin/media',
      '/admin/media?sheet=upload',
      `/admin/media/${media.id}`,
      `/admin/media/${media.id}/delete`,
      '/admin/redirects',
      '/admin/redirects?sheet=import',
      '/admin/users',
      `/admin/users/${extra.id}`,
      `/admin/users/${extra.id}/remove`,
      '/admin/account',
      '/admin/backups',
      '/admin/security',
      `/admin/publish?ids=${kitchen.id}`,
      '/admin/search?q=hello',
    ]
    expect(backups.length).toBeGreaterThan(0)
    for (const url of urls) expectAccessible(url, await olivia.get(url))
    expectAccessible('/admin/nope', await olivia.get('/admin/nope'), 404)
    expectAccessible(
      'add redirect with problems',
      await olivia.post('/admin/redirects', { from: '', to_mode: 'path', to_path: '/blog', status: '301' }),
      400,
    )
    expectAccessible(
      'upload with problems',
      await olivia.upload('/admin/media', [{ filename: 'run.exe', data: Buffer.from('MZ\x90\x00\x03'), type: 'application/octet-stream' }]),
      400,
    )
    expectAccessible('import redirects with problems', await olivia.post('/admin/redirects/import', { csv: '/b\n' }), 400)
    expectAccessible(
      'add user with problems',
      await olivia.post('/admin/users', { name: 'N', email: 'owner@example.com', password: 'nina-password', confirm: 'nina-password', role: 'editor' }),
      400,
    )
    expectAccessible('create key with problems', await olivia.post('/admin/account/keys', { name: '  ' }), 400)

    for (const url of [
      '/admin/pick/media?kind=image',
      '/admin/pick/media?kind=file',
      '/admin/pick/entries?collection=posts&locale=en',
      '/admin/pick/documents?locale=en',
      '/admin/search?q=hello',
      '/admin/search?q=',
    ]) {
      expectAccessible(url, await olivia.get(url, HX), 200, { fragment: true })
    }

    const signedOut = await app.inject({ method: 'GET', url: '/admin/login' })
    expectAccessible('/admin/login', signedOut)
  })

  it('passes on the import report', async () => {
    const mine = await olivia.get('/admin/backups/export')
    const ready = await olivia.upload('/admin/backups/import', [
      { name: 'archive', filename: 'export.tar.gz', data: mine.rawPayload, type: 'application/gzip' },
    ])
    expect(parseHtml(ready.body).querySelector('form[action^="/admin/backups/import/"]')).not.toBeNull()
    expectAccessible('/admin/backups/import', ready)
  })

  it('passes on an editor form showing problems', async () => {
    const kitchen = (await core.findSingleton('kitchen', 'en'))!
    const url = `/admin/documents/${kitchen.id}`
    const form = submittedForm((await olivia.get(url)).body, { form: FORM, submitter: SAVE })
    form.set('fields.count', '12abc')
    form.set('fields.title', '')
    const res = await olivia.post(url, form)
    expectAccessible(`POST ${url}`, res, 400)
    const doc = parseHtml(res.body)
    expect(doc.querySelectorAll('[aria-invalid="true"]').length).toBeGreaterThan(0)
  })

  it('passes on the setup page of a fresh site', async () => {
    const fresh = await makeApp({ site: adminSite })
    try {
      await fresh.app.ready()
      expectAccessible('/admin/setup', await fresh.app.inject({ method: 'GET', url: '/admin/setup' }))
    } finally {
      await fresh.app.close()
    }
  })
})

describe('adding an entry from another language’s list', () => {
  it('opens the form in the default language, so saving creates the entry', async () => {
    const { app } = await makeApp({ withOwner: true, site: adminSite })
    try {
      await app.ready()
      const eddie = await signIn(app, 'editor@example.com')
      const list = parseHtml((await eddie.get('/admin/collections/posts?locale=es')).body)
      const add = list.querySelector('a[href^="/admin/collections/posts/new"]')
      expect(add).not.toBeNull()
      const href = add!.getAttribute('href')!
      expect(href).not.toContain('locale=es')

      const page = await eddie.get(href)
      const form = submittedForm(page.body, { form: FORM, submitter: SAVE })
      expect(form.get('locale')).toBe('en')
      form.set('fields.title', 'Made from the Spanish list')
      form.set('fields.date', '2026-03-01')
      const res = await eddie.post('/admin/collections/posts', form)
      expect(res.statusCode, res.body.slice(0, 1500)).toBe(303)

      const stale = await eddie.get('/admin/collections/posts/new?locale=es')
      expect(submittedForm(stale.body, { form: FORM, submitter: SAVE }).get('locale')).toBe('en')
    } finally {
      await app.close()
    }
  })
})

describe('the Releases screen', () => {
  it('passes with and without the host', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inlay-a11y-releases-'))
    try {
      const keys = generateKeyPair()
      const siteDir = join(dir, 'site')
      await cp(resolve(import.meta.dirname, '../fixtures/release'), siteDir, { recursive: true })
      await mkdir(join(siteDir, 'assets'))
      await writeFile(join(siteDir, 'assets/pic.png'), await png(20, 10))
      const file = join(dir, 'site.tgz')
      await packRelease({ configFile: join(siteDir, 'inlay.config.ts'), privateKey: keys.privateKey, out: file, name: 'spring' })
      const data = await readFile(file)
      const releasesDir = join(dir, 'releases')
      const db = join(dir, 'inlay.db')
      const summary = { shipped: { created: 0, replaced: 0, skipped: 0 }, migrations: [], backup: null, noop: false, warnings: 0 }

      for (const host of [false, true]) {
        // The second app opens the first one's database, owner and release included.
        const { app } = await makeApp({
          withOwner: !host,
          db,
          releasesDir,
          trustedKeys: [keys.publicKey],
          ...(host && {
            adminHost: {
              requestActivation: async () => summary,
              contentDiff: async () => ({ content: null, warnings: [] }),
              pushFile: async () => {
                throw new InlayError('release', 'error.releaseInvalid')
              },
            },
          }),
        })
        try {
          await app.ready()
          const olivia = await signIn(app, 'owner@example.com')
          if (!host) {
            const uploaded = await olivia.upload('/admin/releases/upload', [{ name: 'release', filename: 'site.tgz', data, type: 'application/gzip' }])
            expect(uploaded.statusCode).toBe(303)
          }
          const list = await olivia.get('/admin/releases')
          expectAccessible('/admin/releases', list)
          const href = parseHtml(list.body).querySelector('#releases tbody a')!.getAttribute('href')!
          expectAccessible(href, await olivia.get(href))
          expectAccessible(
            'upload with problems',
            await olivia.upload('/admin/releases/upload', [{ name: 'release', filename: 'bad.tgz', data: Buffer.from('nope'), type: 'application/gzip' }]),
            400,
          )
        } finally {
          await app.close()
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
