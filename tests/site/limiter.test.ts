import { FailureLimiter } from '../../src/adapters/site/limiter.js'

describe('FailureLimiter', () => {
  it('blocks after max failures within the window', () => {
    const limiter = new FailureLimiter({ max: 5, windowMs: 60_000 })
    for (let t = 0; t < 5; t++) limiter.fail('a', t)
    expect(limiter.blocked('a', 5)).toBe(true)
    expect(limiter.blocked('b', 5)).toBe(false)
    expect(limiter.blocked('a', 60_001)).toBe(false)
  })

  it('refunds the newest failure', () => {
    const limiter = new FailureLimiter({ max: 2, windowMs: 60_000 })
    limiter.refund('a')
    limiter.fail('a', 1)
    limiter.fail('a', 2)
    expect(limiter.blocked('a', 3)).toBe(true)
    limiter.refund('a')
    expect(limiter.blocked('a', 3)).toBe(false)
    limiter.refund('a')
    limiter.refund('a')
    limiter.fail('a', 4)
    expect(limiter.blocked('a', 5)).toBe(false)
  })

  it('drops the oldest key past maxKeys', () => {
    const limiter = new FailureLimiter({ max: 2, windowMs: 60_000, maxKeys: 2 })
    for (const key of ['a', 'b', 'c']) {
      limiter.fail(key, 1)
      limiter.fail(key, 2)
    }
    expect(limiter.blocked('a', 3)).toBe(false)
    expect(limiter.blocked('b', 3)).toBe(true)
    expect(limiter.blocked('c', 3)).toBe(true)
  })
})
