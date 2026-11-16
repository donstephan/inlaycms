import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAdminAssets } from '../../src/adapters/admin/assets.js'
import { defineSite } from '../../src/core/registry/define.js'
import { webSite } from '../fixtures/web.js'
import { makeApp } from '../helpers/app.js'

describe('admin assets', () => {
  it('serves the css with an immutable cache for the current hash', async () => {
    const { app } = await makeApp()
    const url = (await loadAdminAssets()).url('admin.css')
    const res = await app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/css')
    expect(res.headers['cache-control']).toContain('immutable')
    expect(res.body).toMatch(/\[data-theme="?dark"?\]/)
    expect(res.body).toContain('.btn')
    await app.close()
  })

  it('does not cache a stale hash', async () => {
    const { app } = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/admin/assets/admin.css?v=wrong' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-cache')
    await app.close()
  })

  it('serves the javascript', async () => {
    const { app } = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/admin/assets/admin.js' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/javascript')
    await app.close()
  })

  it('serves only the known names', async () => {
    const { app } = await makeApp()
    for (const url of ['/admin/assets/package.json', '/admin/assets/..%2Fpackage.json', '/admin/assets/x.js', '/admin/assets/logo']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(404)
      expect(res.body).toBe('')
    }
    await app.close()
  })

  it('rejects an unknown admin theme', async () => {
    await expect(makeApp({ site: defineSite({ ...webSite, admin: { theme: 'nope' } }) })).rejects.toMatchObject({
      code: 'config',
      messageId: 'config.adminTheme',
    })
  })

  it('reports missing build output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inlay-assets-'))
    await expect(loadAdminAssets({ dir })).rejects.toMatchObject({ code: 'config', messageId: 'config.adminAssetsMissing' })
  })
})
