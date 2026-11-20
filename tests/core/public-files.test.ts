import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { publicClashes, publicClashError, publicClashMessage } from '../../src/core/release/public-files.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inlay-public-'))
  for (const f of ['robots.txt', 'sitemap.xml', 'media/x.pdf', 'admin/x.css', 'feed.xml', 'privacy-policy.pdf', 'legal/terms.pdf', 'CNAME']) {
    await mkdir(dirname(join(dir, f)), { recursive: true })
    await writeFile(join(dir, f), 'x')
  }
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const stub = (extra: Record<string, unknown> = {}) =>
  ({
    getRoutePaths: new Set<string>(),
    redirects: [],
    locales: ['en'],
    defaultLocale: 'en',
    site: { singletons: [] },
    ...extra,
  }) as never

describe('publicClashes', () => {
  it('reports root addresses that clash', async () => {
    expect(await publicClashes(dir, stub({ getRoutePaths: new Set(['/feed.xml']) }))).toEqual([
      { file: 'admin/x.css', path: '/admin/x.css', kind: 'reserved' },
      { file: 'feed.xml', path: '/feed.xml', kind: 'route' },
      { file: 'media/x.pdf', path: '/media/x.pdf', kind: 'reserved' },
      { file: 'robots.txt', path: '/robots.txt', kind: 'reserved' },
      { file: 'sitemap.xml', path: '/sitemap.xml', kind: 'reserved' },
    ])
  })

  it('reports a code redirect and a singleton page at the same path', async () => {
    const registry = stub({
      redirects: [{ from: '/privacy-policy.pdf', to: '/', status: 301 }],
      site: { singletons: [{ name: 'terms', path: { en: '/legal/terms.pdf' } }] },
    })
    const found = (await publicClashes(dir, registry)).filter((c) => c.kind === 'redirect' || c.kind === 'page')
    expect(found).toEqual([
      { file: 'legal/terms.pdf', path: '/legal/terms.pdf', kind: 'page' },
      { file: 'privacy-policy.pdf', path: '/privacy-policy.pdf', kind: 'redirect' },
    ])
    expect(publicClashMessage(found[0]!)).toContain('address of a page')
    expect(publicClashMessage(found[1]!)).toContain('already has a redirect')
  })

  it('makes a release error from a clash', () => {
    const e = publicClashError({ file: 'a.pdf', path: '/a.pdf', kind: 'page' })
    expect(e.code).toBe('release')
    expect(e.message).toContain('public/a.pdf')
  })

  it('words a clash for the developer', () => {
    const m = publicClashMessage({ file: 'robots.txt', path: '/robots.txt', kind: 'reserved' })
    expect(m).toContain('public/robots.txt')
    expect(m).toContain('/robots.txt')
  })
})
