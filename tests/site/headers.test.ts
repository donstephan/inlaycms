import type { FastifyInstance } from 'fastify'
import { afterEach } from 'vitest'
import { defineSite } from '../../src/core/registry/define.js'
import { webSite } from '../fixtures/web.js'
import { makeApp, type MakeAppOptions } from '../helpers/app.js'

const open: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((a) => a.close()))
})

async function setup(opts: MakeAppOptions = {}) {
  const made = await makeApp(opts)
  open.push(made.app)
  return made.app
}

describe('security headers', () => {
  it('sends the defaults with a page, and HSTS on an https site', async () => {
    const res = await (await setup()).inject('/')
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'self'")
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000')
  })

  it('sends no HSTS on an http site', async () => {
    const res = await (await setup({ baseUrl: 'http://localhost:3000' })).inject('/')
    expect(res.headers['strict-transport-security']).toBeUndefined()
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('sends them with a 404 and the unlock route too', async () => {
    const app = await setup()
    const missing = await app.inject('/nope')
    expect(missing.statusCode).toBe(404)
    expect(missing.headers['content-security-policy']).toBe("frame-ancestors 'self'")
    const unlock = await app.inject({ method: 'POST', url: '/_inlay/unlock', payload: '' })
    expect(unlock.headers['content-security-policy']).toBe("frame-ancestors 'self'")
  })

  it("keeps the admin's own stricter headers, and adds HSTS", async () => {
    const res = await (await setup()).inject('/admin/login')
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(res.headers['referrer-policy']).toBe('same-origin')
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000')
  })

  it("lays the site's headers over the defaults, and false leaves one out", async () => {
    const site = defineSite({
      ...webSite,
      headers: {
        'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
        'strict-transport-security': false,
        'permissions-policy': 'camera=()',
      },
    })
    const res = await (await setup({ site })).inject('/')
    expect(res.headers['content-security-policy']).toBe("default-src 'self'; frame-ancestors 'none'")
    expect(res.headers['strict-transport-security']).toBeUndefined()
    expect(res.headers['permissions-policy']).toBe('camera=()')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })
})
