import { createTestSite } from 'inlaycms/testing'

const site = await createTestSite({ config: './inlay.config.ts' })
try {
  const paths = await site.paths()
  if (paths.length === 0) throw new Error('paths() is empty')
  for (const path of paths) {
    const res = await site.fetch(path)
    if (res.status !== 200) throw new Error(`GET ${path}: expected 200, got ${res.status}`)
  }
  const moved = await site.fetch('/about-us')
  if (moved.status !== 301) throw new Error(`GET /about-us: expected 301, got ${moved.status}`)
  const location = moved.headers.get('location')
  if (location !== '/about') throw new Error(`GET /about-us: Location was ${location}`)
  const missing = await site.fetch('/no-such-page')
  if (missing.status !== 404) throw new Error(`GET /no-such-page: expected 404, got ${missing.status}`)
  console.log(paths.length)
} finally {
  await site.close()
}
