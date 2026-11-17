import { externalTarget, targetOf } from '../../src/core/redirects/rule.js'

describe('externalTarget', () => {
  it('returns a usable https URL', () => {
    expect(externalTarget('https://www.g2.com/products/realciso/reviews')).toBe('https://www.g2.com/products/realciso/reviews')
    expect(externalTarget('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c')
  })

  it('normalizes the scheme and host', () => {
    expect(externalTarget('HTTPS://Example.COM/x')).toBe('https://example.com/x')
  })

  it('refuses anything else', () => {
    for (const raw of [
      'http://example.com/',
      '//example.com/x',
      'javascript:alert(1)',
      'ftp://example.com/x',
      'https://user:pw@example.com/',
      'https://user@example.com/',
      'https://example.com/\nx',
      'https://example.com/\tx',
      'https:example.com',
      'https:/example.com',
      'https://',
      '',
    ]) {
      expect(externalTarget(raw), JSON.stringify(raw)).toBeNull()
    }
  })
})

describe('targetOf', () => {
  it('tells a path from a URL', () => {
    expect(targetOf('/about')).toEqual({ path: '/about' })
    expect(targetOf('https://x.com/')).toEqual({ url: 'https://x.com/' })
  })
})
