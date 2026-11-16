import { readSiteLock, writeSiteLock } from '../../src/core/site-lock/site-lock.js'
import { makeCore } from '../helpers/core.js'

describe('site lock', () => {
  it('starts public with no password', async () => {
    const { core } = await makeCore()
    expect(await core.siteLock()).toEqual({ enabled: false, hasPassword: false })
  })

  it('sets a password and checks it exactly', async () => {
    const { core, owner } = await makeCore()
    expect(await core.setSitePassword('pässwort 1', owner)).toEqual({ enabled: false, hasPassword: true })
    expect(await core.checkSitePassword('pässwort 1')).toBe(true)
    expect(await core.checkSitePassword('pässwort 1 ')).toBe(false)
    expect(await core.checkSitePassword('PÄSSWORT 1')).toBe(false)
  })

  it('treats a malformed stored hash as no match', async () => {
    const { core, db } = await makeCore()
    for (const passwordHash of ['not-a-hash', 'zz:zz', ':']) {
      await writeSiteLock(db, { enabled: true, passwordHash })
      expect(await core.checkSitePassword('letmein123'), passwordHash).toBe(false)
    }
  })

  it('stores only a hash', async () => {
    const { core, owner, db } = await makeCore()
    await core.setSitePassword('letmein123', owner)
    const hash = (await readSiteLock(db)).passwordHash
    expect(typeof hash).toBe('string')
    expect(hash).not.toContain('letmein123')
  })

  it('refuses passwords outside 8 to 128 characters', async () => {
    const { core, owner } = await makeCore()
    await expect(core.setSitePassword('short12', owner)).rejects.toMatchObject({
      code: 'validation',
      details: { issues: [{ code: 'too_short' }] },
    })
    await expect(core.setSitePassword('x'.repeat(129), owner)).rejects.toMatchObject({
      code: 'validation',
      details: { issues: [{ code: 'too_long' }] },
    })
  })

  it('refuses to turn on without a password', async () => {
    const { core, owner } = await makeCore()
    await expect(core.setSiteLock(true, owner)).rejects.toMatchObject({
      code: 'invalid_operation',
      messageId: 'error.sitePasswordMissing',
    })
  })

  it('turns on and off and keeps the password', async () => {
    const { core, owner } = await makeCore()
    await core.setSitePassword('letmein123', owner)
    expect(await core.setSiteLock(true, owner)).toEqual({ enabled: true, hasPassword: true })
    expect(await core.setSiteLock(false, owner)).toEqual({ enabled: false, hasPassword: true })
    expect(await core.checkSitePassword('letmein123')).toBe(true)
  })

  it('is owner only', async () => {
    const { core, editor } = await makeCore()
    await expect(core.setSitePassword('letmein123', editor)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(core.setSiteLock(false, editor)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('tells live-change listeners', async () => {
    const { core, owner } = await makeCore()
    const listener = vi.fn()
    core.onLiveChange(listener)
    await core.setSitePassword('letmein123', owner)
    expect(listener).toHaveBeenCalledTimes(1)
    await core.setSiteLock(true, owner)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
