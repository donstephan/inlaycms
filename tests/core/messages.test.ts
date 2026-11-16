import { en } from '../../src/core/messages/en.js'
import { t } from '../../src/core/messages/index.js'
import { InlayError } from '../../src/core/errors.js'

describe('messages', () => {
  it('interpolates params', () => {
    expect(t('error.notFound', { name: 'Maria' })).toBe("We couldn't find Maria.")
  })

  it('picks the singular or plural word for a count', () => {
    expect(t('error.publishFailed', { count: 1 })).toMatch(/^1 item can't/)
    expect(t('error.publishFailed', { count: 3 })).toMatch(/^3 items can't/)
  })

  it('writes no "(s)" plurals', () => {
    for (const [id, text] of Object.entries(en)) expect(text, id).not.toMatch(/\w\(s\)/)
  })

  it('throws on a missing param', () => {
    expect(() => t('error.notFound')).toThrow(/name/)
  })
})

describe('InlayError', () => {
  it('renders its message from the catalog', () => {
    const e = new InlayError('not_found', 'error.notFound', { name: 'x' })
    expect(e.message).toBe("We couldn't find x.")
    expect(e.code).toBe('not_found')
    expect(e.messageId).toBe('error.notFound')
    expect(e).toBeInstanceOf(Error)
  })
})
