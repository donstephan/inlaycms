import type { IssueCode } from '../../src/core/types.js'
import { InlayError } from '../../src/core/errors.js'
import type { SiteDefinition } from '../../src/core/registry/define.js'
import { fallbackSite, rootSite } from '../fixtures/code-redirects.js'
import { makeCore } from '../helpers/core.js'

const to301 = (location: string) => ({ kind: 'redirect', location, status: 301 })
const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] }

async function world(site: SiteDefinition = fallbackSite) {
  const w = await makeCore({ site })
  await w.core.applyShippedContent()
  return w
}

async function issueOf(p: Promise<unknown>): Promise<IssueCode> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(InlayError)
    const code = (e as InlayError).details.issues?.[0]?.code
    expect(code).toBeDefined()
    return code!
  }
  throw new Error('expected a rejection')
}

describe('the lowercase fallback', () => {
  it('sends a mixed-case path to the page', async () => {
    const { core } = await world()
    expect(await core.resolvePath('/About')).toEqual(to301('/about'))
    expect(await core.resolvePath('/es/Acerca')).toEqual(to301('/es/acerca'))
    expect(await core.resolvePath('/EN/About')).toEqual(to301('/about'))
  })

  it("goes straight to a rule's target in one 301", async () => {
    const { core } = await world()
    expect(await core.resolvePath('/Company/Team/')).toEqual(to301('/team'))
    expect(await core.resolvePath('/Company/Team')).toEqual(to301('/team'))
    expect(await core.resolvePath('/OLD')).toEqual({ kind: 'redirect', location: '/new', status: 302 })
  })

  it("sends a default-locale prefix or a trailing slash straight to a rule's target", async () => {
    const { core } = await world()
    for (const p of ['/en/old', '/en/old/', '/old/']) {
      expect(await core.resolvePath(p)).toEqual({ kind: 'redirect', location: '/new', status: 302 })
    }
    expect(await core.resolvePath('/en/company/team')).toEqual(to301('/team'))
    expect(await core.resolvePath('/en/about')).toEqual(to301('/about'))
    expect(await core.resolvePath('/en/contact')).toEqual(to301('/contact'))
  })

  it('reaches code routes', async () => {
    const { core } = await world()
    expect(await core.resolvePath('/Contact')).toEqual(to301('/contact'))
    expect(await core.resolvePath('/About-Us/')).toEqual(to301('/About-Us'))
  })

  it('matches a rule with capitals exactly first, and keeps paths case-sensitive', async () => {
    const { core } = await world()
    expect(await core.resolvePath('/Old-Page')).toEqual(to301('/blog'))
    expect(await core.resolvePath('/old-page')).toEqual({ kind: 'not_found', locale: 'en' })
  })

  it('leaves file-like and unmatched paths alone', async () => {
    const { core, owner } = await world()
    expect((await core.resolvePath('/Nope')).kind).toBe('not_found')
    await core.createRedirect({ from: '/foo.pdf', to: '/about' }, owner)
    expect((await core.resolvePath('/Foo.PDF')).kind).toBe('not_found')
  })

  it('never sends a visitor through the default-locale prefix to a 404', async () => {
    const { core } = await world()
    expect(await core.resolvePath('/EN/Nope')).toEqual({ kind: 'not_found', locale: 'en' })
    expect(await core.resolvePath('/EN/Nope/')).toEqual(to301('/EN/Nope'))
    expect(await core.resolvePath('/EN/Company/Team')).toEqual(to301('/team'))
    expect(await core.resolvePath('/EN/Contact')).toEqual(to301('/contact'))
  })

  it('lands on an external rule', async () => {
    const { core } = await world()
    expect(await core.resolvePath('/G2')).toMatchObject({ location: 'https://www.g2.com/x', status: 301, external: true })
  })

  it('resolves against preview state', async () => {
    const { core, owner } = await world()
    await core.createEntry('posts', { slug: 'hello-world', fields: { title: 'Hello', date: '2026-01-01', body } }, owner)
    expect((await core.resolvePath('/Blog/Hello-World')).kind).toBe('not_found')
    expect(await core.resolvePath('/Blog/Hello-World', { state: 'preview' })).toEqual(to301('/blog/hello-world'))
  })

  it('skips, refuses and reports a loop through the fallback', async () => {
    const looping = await world(rootSite([{ from: '/x', to: '/Y' }, { from: '/y', to: '/x' }]))
    for (const p of ['/x', '/Y', '/y']) expect((await looping.core.resolvePath(p)).kind).toBe('not_found')
    expect(await looping.core.codeRedirectLoops()).toEqual(['/x', '/y'])

    const { core, owner } = await world(rootSite([{ from: '/y', to: '/x' }]))
    expect(await issueOf(core.createRedirect({ from: '/x', to: '/Y' }, owner))).toBe('redirect_loop')

    const self = await world(rootSite([{ from: '/abc', to: '/ABC' }]))
    expect((await self.core.resolvePath('/abc')).kind).toBe('not_found')
    expect(await self.core.codeRedirectLoops()).toEqual(['/abc'])
  })
})
