import { buildCsp } from '../../src/adapters/site/csp.js'

const DEFAULT =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; media-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"

describe('buildCsp', () => {
  it('the default policy, exactly', () => {
    expect(buildCsp({ site: {}, integrations: [] })).toBe(DEFAULT)
    expect(buildCsp({ site: {}, integrations: [], hashes: [] })).toBe(DEFAULT)
  })

  it('adds hashes, then declared sources, de-duplicated, site before integrations', () => {
    const csp = buildCsp({
      site: { 'img-src': ['https://i.example'], 'script-src': ['https://s.example'] },
      integrations: [
        { 'script-src': ['https://a.example', 'https://s.example'], 'img-src': ['https://i.example'] },
        { 'script-src': ['https://a.example'], 'connect-src': ['wss://c.example'] },
      ],
      hashes: ["'sha256-x'", "'sha256-y'", "'sha256-x'"],
    })
    expect(csp).toContain("script-src 'self' 'sha256-x' 'sha256-y' https://s.example https://a.example;")
    expect(csp).toContain("img-src 'self' data: https://i.example;")
    expect(csp).toContain("connect-src 'self' wss://c.example;")
    expect(csp).not.toContain('worker-src')
  })

  it("worker-src appears only when declared, as worker-src 'self' <sources>, before object-src", () => {
    const csp = buildCsp({ site: {}, integrations: [{ 'worker-src': ['blob:'] }] })
    expect(csp).toContain("media-src 'self'; worker-src 'self' blob:; object-src 'none';")
  })

  it("leaves hashes out when 'unsafe-inline' is declared for script-src", () => {
    const fromIntegration = buildCsp({
      site: {},
      integrations: [{ 'script-src': ["'unsafe-inline'", 'https://a.example'] }],
      hashes: ["'sha256-x'"],
    })
    expect(fromIntegration).toContain("script-src 'self' 'unsafe-inline' https://a.example;")
    const fromSite = buildCsp({ site: { 'script-src': ["'unsafe-inline'"] }, integrations: [], hashes: ["'sha256-x'"] })
    expect(fromSite).toContain("script-src 'self' 'unsafe-inline';")
    expect(fromSite).not.toContain('sha256')
  })

  it("does not repeat 'unsafe-inline' or data: that the default already has", () => {
    const csp = buildCsp({
      site: { 'style-src': ["'unsafe-inline'"], 'img-src': ['data:'] },
      integrations: [{ 'style-src': ["'unsafe-inline'", 'https://f.example'], 'img-src': ['data:'] }],
    })
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://f.example;")
    expect(csp).toContain("img-src 'self' data:;")
  })
})
