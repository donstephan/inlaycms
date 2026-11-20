import { atLeastVersion, packedVersion, releaseFit } from '../../src/core/release/window.js'
import { inlayVersion } from '../../src/core/version.js'

const w = (version: string, oldest = '0.5.0', nextOldest: string | null = null) => ({ version, oldest, nextOldest })

describe('releaseFit', () => {
  it('runs a release packed with the oldest version or later, up to the host minor', () => {
    expect(releaseFit('0.5.0', w('0.5.0'))).toBe('ok')
    expect(releaseFit('0.5.0', w('0.6.2'))).toBe('ok')
    expect(releaseFit('0.5.3', w('0.5.0'))).toBe('ok') // a newer patch than the host
    expect(releaseFit('0.4.9', w('0.6.0'))).toBe('tooOld')
    expect(releaseFit('0.6.0', w('0.5.9'))).toBe('tooNew')
    expect(releaseFit('1.0.0', w('0.9.0', '0.5.0'))).toBe('tooNew')
  })
  it('compares across majors only by the window', () => {
    expect(releaseFit('0.9.0', w('1.2.0', '0.9.0'))).toBe('ok')
    expect(releaseFit('0.9.0', w('1.2.0', '1.0.0'))).toBe('tooOld')
    expect(releaseFit('1.3.0', w('1.2.5', '1.0.0'))).toBe('tooNew')
    expect(releaseFit('2.0.0', w('1.9.0', '1.0.0'))).toBe('tooNew')
  })
  it('warns about releases the next window drops', () => {
    expect(releaseFit('0.5.2', w('0.6.0', '0.5.0', '0.6.0'))).toBe('warn')
    expect(releaseFit('0.6.0', w('0.6.0', '0.5.0', '0.6.0'))).toBe('ok')
    expect(releaseFit('0.4.0', w('0.6.0', '0.5.0', '0.6.0'))).toBe('tooOld')
  })
  it('prerelease and unparseable', () => {
    expect(releaseFit('0.6.0-rc.1', w('0.6.0'))).toBe('ok')
    expect(releaseFit('0.5.0', w('0.6.0-rc.1'))).toBe('ok')
    expect(releaseFit('nonsense', w('0.6.0'))).toBe('tooOld')
    expect(releaseFit('', w('0.6.0'))).toBe('tooOld')
  })
  it('defaults to the running window', () => {
    expect(releaseFit(inlayVersion())).toBe('ok')
  })
})

describe('packedVersion', () => {
  it('drops the caret', () => {
    expect(packedVersion('^0.5.0')).toBe('0.5.0')
    expect(packedVersion('0.5.0')).toBe('0.5.0')
  })
})

describe('atLeastVersion', () => {
  it('atLeastVersion compares packed versions', () => {
    for (const v of ['0.7.0', '0.7.0-beta.1', '1.0.0']) expect(atLeastVersion(v, '0.7.0')).toBe(true)
    for (const v of ['0.6.9', 'junk']) expect(atLeastVersion(v, '0.7.0')).toBe(false)
  })
})
