import type { FastifyInstance } from 'fastify'
import { makeApp } from '../helpers/app.js'
import { loadConsentAsset } from '../../src/adapters/site/consent.js'

const open: FastifyInstance[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((a) => a.close()))
})

describe('GET /_inlay/consent.js', () => {
  it('serves the script immutably under its versioned url', async () => {
    const { app } = await makeApp()
    open.push(app)
    const asset = await loadConsentAsset()
    expect(asset.url).toMatch(/^\/_inlay\/consent\.js\?v=[0-9a-f]{12}$/)
    const res = await app.inject({ method: 'GET', url: asset.url })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/javascript/)
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(res.body).toBe(asset.body)
  })

  it('answers without or with a wrong version, uncached', async () => {
    const { app } = await makeApp()
    open.push(app)
    for (const url of ['/_inlay/consent.js', '/_inlay/consent.js?v=nope']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      expect(res.headers['cache-control']).toBe('no-cache')
    }
  })

  it('answers while the site lock is on', async () => {
    const { app, core, owner } = await makeApp()
    open.push(app)
    await core.setSitePassword('letmein123', owner)
    await core.setSiteLock(true, owner)
    const res = await app.inject({ method: 'GET', url: '/_inlay/consent.js' })
    expect(res.statusCode).toBe(200)
  })
})
