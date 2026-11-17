import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createTestSite, type TestSite } from 'inlaycms/testing'
import { InlayError } from '../../src/core/errors.js'
import { t } from '../../src/core/messages/index.js'

const fixtures = resolve(import.meta.dirname, '../fixtures')
const good = join(fixtures, 'test-site/inlay.config.ts')
const bad = join(fixtures, 'test-site-bad/inlay.config.ts')

/** Points TMPDIR at a fresh empty folder while `fn` runs. */
async function withScratchTmp(fn: (scratch: string) => Promise<void>): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'inlay-testing-scratch-'))
  const savedTmp = process.env.TMPDIR
  try {
    process.env.TMPDIR = scratch
    await fn(scratch)
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = savedTmp
    await rm(scratch, { recursive: true, force: true })
  }
}

async function rejection(p: Promise<unknown>): Promise<InlayError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(InlayError)
    return e as InlayError
  }
  throw new Error('expected a rejection')
}

it('throws the check report for bad shipped content and leaves no folder behind', () =>
  withScratchTmp(async (scratch) => {
    const e = await rejection(createTestSite({ config: bad }))
    expect(e.code).toBe('check_failed')
    expect(e.details.problems!.map((p) => p.code)).toEqual(['shipped_content'])
    expect(e.message).toContain(t('report.problem', { message: e.details.problems![0]!.message }))
    expect(await readdir(scratch)).toEqual([])
  }))

it('refuses a site that pack would refuse, and leaves no folder behind', () =>
  withScratchTmp(async (scratch) => {
    const e = await rejection(createTestSite({ config: join(fixtures, 'test-site-server/inlay.config.ts') }))
    expect(e.code).toBe('check_failed')
    expect(e.details.problems!.map((p) => p.code)).toEqual(['release_import'])
    expect(e.message).toContain('node:os')
    expect(await readdir(scratch)).toEqual([])
  }))

it('leaves no folder behind when the config is missing', () =>
  withScratchTmp(async (scratch) => {
    const e = await rejection(createTestSite({ config: join(scratch, 'nope/inlay.config.ts') }))
    expect(e.messageId).toBe('error.configMissing')
    expect(await readdir(scratch)).toEqual([])
  }))

it('close() removes its folder and can be called twice', () =>
  withScratchTmp(async (scratch) => {
    const site = await createTestSite({ config: good })
    expect(await readdir(scratch)).toEqual([expect.stringMatching(/^inlay-test-site-/)])
    await site.close()
    await site.close()
    expect(await readdir(scratch)).toEqual([])
  }))

it('close() waits for a request in flight', () =>
  withScratchTmp(async (scratch) => {
    const slow = async () => {
      await new Promise((r) => setTimeout(r, 200))
      return new Response('ok')
    }
    const site = await createTestSite({ config: good, secrets: { HOOK: 'https://hooks.test/x' }, fetch: slow })
    const pending = site.fetch('/hook', { method: 'POST', body: new URLSearchParams({ text: 'hi' }) })
    await new Promise((r) => setTimeout(r, 50))
    await site.close()
    expect((await pending).status).toBe(200)
    expect(await readdir(scratch)).toEqual([])
  }))

it('refuses to fetch once closed', async () => {
  const site = await createTestSite({ config: good })
  await site.close()
  expect((await rejection(site.fetch('/'))).messageId).toBe('error.testSiteClosed')
  expect((await rejection(site.paths())).messageId).toBe('error.testSiteClosed')
})

it('never touches the database the config names', async () => {
  const site = await createTestSite({ config: good })
  await site.close()
  expect(existsSync(join(fixtures, 'test-site/data'))).toBe(false)
})

it("runs two sites in one process without them seeing each other's settings", async () => {
  const [a, b] = await Promise.all([
    createTestSite({ config: good, secrets: { HOOK: 'https://a.test/' }, fetch: async () => new Response('a') }),
    createTestSite({ config: good, secrets: { HOOK: 'https://b.test/' }, fetch: async () => new Response('b') }),
  ])
  try {
    const hookOf = async (s: TestSite) =>
      (await (await s.fetch('/hook', { method: 'POST', body: new URLSearchParams({ text: 'x' }) })).json()).hook
    expect(await hookOf(a)).toBe('https://a.test/')
    expect(await hookOf(b)).toBe('https://b.test/')
    await a.close()
    expect((await b.fetch('/')).status).toBe(200)
  } finally {
    await a.close()
    await b.close()
  }
})

it('gives routes the stand-in fetch and only the declared secrets', async () => {
  const global = vi.spyOn(globalThis, 'fetch')
  const standIn = vi.fn<typeof fetch>(async () => new Response('ok'))
  const site = await createTestSite({
    config: good,
    secrets: { HOOK: 'https://hooks.test/x', OTHER: 'hidden' },
    fetch: standIn,
  })
  try {
    const res = await site.fetch('/hook', { method: 'POST', body: new URLSearchParams({ text: 'hi' }) })
    expect(await res.json()).toEqual({ hook: 'https://hooks.test/x', other: null })
    expect(String(standIn.mock.calls[0]![0])).toBe('https://hooks.test/x')
    expect(global).not.toHaveBeenCalled()
  } finally {
    await site.close()
    global.mockRestore()
  }
})

it('leaves a declared secret missing when it is not given, whatever the environment says', async () => {
  process.env.HOOK = 'https://from-env.test/'
  const site = await createTestSite({ config: good })
  try {
    const res = await site.fetch('/hook', { method: 'POST', body: new URLSearchParams({ text: 'hi' }) })
    expect(await res.json()).toEqual({ hook: null, other: null })
  } finally {
    delete process.env.HOOK
    await site.close()
  }
})

it('uses the given clock', async () => {
  const site = await createTestSite({ config: good, now: () => new Date('2030-01-02T03:04:05Z') })
  try {
    expect(await (await site.fetch('/sitemap.xml')).text()).toContain('<lastmod>2030-01-02</lastmod>')
  } finally {
    await site.close()
  }
})

it('answers 304 and HEAD with no body', async () => {
  const site = await createTestSite({ config: good })
  try {
    const etag = (await site.fetch('/')).headers.get('etag')!
    const again = await site.fetch('/', { headers: { 'if-none-match': etag } })
    expect(again.status).toBe(304)
    expect(await again.text()).toBe('')
    const head = await site.fetch('/', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  } finally {
    await site.close()
  }
})

it('refuses a target that is not a path, and a body it cannot send', async () => {
  const site = await createTestSite({ config: good })
  try {
    for (const target of ['about', 'http://localhost/about', '//elsewhere.test/x']) {
      const e = await rejection(site.fetch(target))
      expect([target, e.messageId]).toEqual([target, 'error.testSitePath'])
    }
    const e = await rejection(site.fetch('/hook', { method: 'POST', body: new Blob(['x']) }))
    expect(e.messageId).toBe('error.testSiteBody')
  } finally {
    await site.close()
  }
})
