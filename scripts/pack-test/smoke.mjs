import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 3100
const BASE = `http://127.0.0.1:${PORT}`
const EXPORT = '/tmp/e.tar.gz'
// The host's data folder: the database, media, backups and releases, as inlaycms serve keeps them.
const DATA = mkdtempSync(join(tmpdir(), 'inlay-host-'))
const DB = join(DATA, 'inlay.db')
const env = {
  ...process.env,
  INLAY_DATA_DIR: DATA,
  INLAY_PORT: String(PORT),
  INLAY_HOST: '127.0.0.1',
  INLAY_BASE_URL: `http://localhost:${PORT}`,
  INLAY_SECRET: 'pack-test-secret-0123456789abcdef-xyz',
  INLAY_TRUSTED_KEYS: readFileSync('keys/dev.pub', 'utf8').trim(),
  INLAY_RATE_LIMIT: 'off',
  // The example's release asks for this secret; empty is fine.
  SLACK_WEBHOOK: '',
}

let server = null
let serverLog = ''

function pass(name) {
  console.log(`PASS ${name}`)
}

function fail(name, detail) {
  console.log(`FAIL ${name}: ${detail}`)
  if (serverLog) console.log(`--- server output ---\n${serverLog.slice(-3000)}`)
  if (server) server.kill('SIGKILL')
  process.exit(1)
}

function cli(args, extraEnv = {}, input = undefined) {
  const r = spawnSync('npx', ['inlaycms', ...args], {
    // No tsx: the CLI loads the site's TypeScript and JSX itself.
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    input,
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' }
}

async function get(path, init = {}) {
  const send = () => fetch(`${BASE}${path}`, { redirect: 'manual', ...init })
  try {
    return await send()
  } catch (e) {
    // After a release swap, a kept-alive connection to the old worker can close under the next request on it.
    // Browsers and proxies send a GET again on a fresh connection; so does this, once.
    if ((init.method ?? 'GET') !== 'GET' || e?.cause?.code !== 'UND_ERR_SOCKET') throw e
    return send()
  }
}

// After a release swap the old worker drains: each kept-alive connection opened before the swap may answer once more
// from the old release, then closes. Bursts of requests use them up until every answer comes from the new release.
async function afterSwap(isNew) {
  const deadline = Date.now() + 15_000
  for (;;) {
    const bodies = await Promise.all(Array.from({ length: 20 }, async () => (await fetch(`${BASE}/`)).text()))
    if (bodies.every(isNew)) return
    if (Date.now() > deadline) throw new Error('the old release still answers 15 seconds after the swap')
  }
}

async function startServer() {
  serverLog = ''
  // The installed bin itself rather than npx, so SIGTERM reaches inlaycms serve. Plain node: the host runs built code.
  server = spawn('node_modules/.bin/inlaycms', ['serve'], { env })
  server.stdout.on('data', (d) => (serverLog += d))
  server.stderr.on('data', (d) => (serverLog += d))
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`the server exited with code ${server.exitCode}`)
    try {
      await get('/')
      return
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw new Error('the server did not answer within 60 s')
}

async function stopServer() {
  const s = server
  server = null
  if (!s || s.exitCode !== null) return
  const closed = new Promise((r) => s.once('exit', (code, signal) => r({ code, signal })))
  s.kill('SIGTERM')
  const timer = setTimeout(() => s.kill('SIGKILL'), 10_000)
  const { code, signal } = await closed
  clearTimeout(timer)
  if (code !== 0) throw new Error(`the server did not exit cleanly on SIGTERM (code ${code}, signal ${signal})`)
}

async function check(name, fn) {
  try {
    await fn()
  } catch (e) {
    // fetch hides why it failed (a refused or reset connection) in `cause`.
    const cause = e instanceof Error && e.cause ? ` (${e.cause instanceof Error ? `${e.cause.name}: ${e.cause.message}` : String(e.cause)})` : ''
    fail(name, `${e instanceof Error ? e.message : String(e)}${cause}`)
  }
  pass(name)
}

function expectStatus(res, status, what) {
  if (res.status !== status) throw new Error(`${what}: expected ${status}, got ${res.status}`)
}

function expectCli(r, what) {
  if (r.code !== 0) throw new Error(`${what} exited ${r.code}:\n${r.out}`)
}

rmSync(EXPORT, { force: true })

await check('typecheck', () => {
  const r = spawnSync('npx', ['tsc', '-p', '.'], { encoding: 'utf8' })
  // skipLibCheck stays off so the shipped .d.ts files are checked. better-auth's own types import
  // 'bun:sqlite', which a Node site can't resolve; that one third-party error is not Inlay's to fix.
  const known = /^node_modules\/@better-auth\/core\/.*TS2307: Cannot find module 'bun:sqlite'/
  const lines = `${r.stdout}${r.stderr}`.split('\n').filter((l) => /error TS\d+/.test(l))
  const errors = lines.filter((l) => !known.test(l))
  if (errors.length > 0 || (r.status !== 0 && lines.length === 0)) {
    throw new Error(`tsc exited ${r.status}:\n${errors.join('\n')}`)
  }
})

await check('cli check', () => expectCli(cli(['check', '--config', 'inlay.config.ts']), 'inlaycms check'))

await check('cli pack', () => {
  rmSync('release.tgz', { force: true })
  const args = ['pack', '--config', 'inlay.config.ts', '--key', 'keys/dev.key', '--out', 'release.tgz', '--no-typecheck']
  expectCli(cli(args), 'inlaycms pack')
  if (!existsSync('release.tgz')) throw new Error('release.tgz was not written')
})

await check('read the release with the installed package', () => {
  // Plain node, no tsx: site.js must load through the installed inlaycms/site.
  const script = [
    "import { mkdtempSync, readFileSync } from 'node:fs'",
    "import { tmpdir } from 'node:os'",
    "import { join } from 'node:path'",
    "import { readRelease } from 'inlaycms'",
    "const dir = mkdtempSync(join(tmpdir(), 'inlay-release-'))",
    "const trustedKeys = [readFileSync('keys/dev.pub', 'utf8').trim()]",
    "const loaded = await readRelease('release.tgz', { dir, trustedKeys })",
    'console.log(JSON.stringify(loaded.site.locales))',
  ].join('\n')
  const r = spawnSync('node', ['--input-type=module', '-e', script], { env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stdout}${r.stderr}`)
  if (r.stdout.trim() !== '["en","es"]') throw new Error(`unexpected locales: ${r.stdout}`)
})

await check('inlaycms/testing with the installed package', () => {
  // Plain node, no tsx: the installed package's exports must name dist/testing.js.
  const r = spawnSync('node', ['testing-smoke.ts'], { env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stdout}${r.stderr}`)
})

await check('cli activate offline', () => {
  const r = cli(['activate', 'release.tgz', '--data', DATA])
  expectCli(r, 'inlaycms activate')
  if (!r.stdout.includes('is now live')) throw new Error(`no "is now live" in the output:\n${r.out}`)
  const list = cli(['releases', '--data', DATA, '--json'])
  expectCli(list, 'inlaycms releases')
  const rows = JSON.parse(list.stdout)
  if (rows.length !== 1 || rows[0].state !== 'current') throw new Error(`unexpected releases: ${list.stdout}`)
})

await check('boot', startServer)

await check('admin setup', async () => {
  // Before there is an owner, the admin asks for one.
  const res = await get('/admin')
  expectStatus(res, 302, 'GET /admin')
  const location = res.headers.get('location') ?? ''
  if (!location.endsWith('/admin/setup')) throw new Error(`redirected to ${location}`)
  const setup = await get('/admin/setup')
  expectStatus(setup, 200, 'GET /admin/setup')
  if (!/href="[^"]*admin\.css\?v=[^"]*"/.test(await setup.text())) throw new Error('no admin.css?v= link in the setup page')
})

const OWNER = 'owner@example.com'
let pushKey = ''
await check('cli create-owner and create-token with the server running', () => {
  expectCli(cli(['create-owner', '--email', OWNER, '--name', 'Owner', '--data', DATA], {}, 'pack-test-password-123\n'), 'inlaycms create-owner')
  const r = cli(['create-token', '--email', OWNER, '--name', 'ci', '--push', '--data', DATA])
  expectCli(r, 'inlaycms create-token')
  pushKey = r.stdout.trim()
  if (!pushKey || /\s/.test(pushKey)) throw new Error(`the key should be alone on stdout, got: ${JSON.stringify(r.stdout)}`)
})

await check('home page', async () => {
  const res = await get('/')
  expectStatus(res, 200, 'GET /')
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('text/html')) throw new Error(`content-type was ${type}`)
  const body = await res.text()
  if (!body.includes('Pages are cached and served quickly.')) throw new Error("the example's home page wasn't served")
})

await check('public files', async () => {
  const res = await get('/public/site.css')
  expectStatus(res, 200, 'GET /public/site.css')
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('text/css')) throw new Error(`site.css content-type was ${type}`)
})

await check('contact form', async () => {
  const res = await get('/contact', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'email=ana%40example.com&message=Hello&locale=en',
  })
  expectStatus(res, 200, 'POST /contact')
  if (!(await res.text()).includes('Thank you')) throw new Error('no thank-you page')
})

await check('sitemap', async () => expectStatus(await get('/sitemap.xml'), 200, 'GET /sitemap.xml'))

await check('admin login', async () => {
  const res = await get('/admin')
  expectStatus(res, 302, 'GET /admin')
  const location = res.headers.get('location') ?? ''
  // Now that there is an owner, the setup step is gone: the admin asks to sign in.
  if (!/\/admin\/login(\?|$)/.test(location)) throw new Error(`redirected to ${location}`)
  const login = await get('/admin/login')
  expectStatus(login, 200, 'GET /admin/login')
  const link = (await login.text()).match(/href="([^"]*admin\.css\?v=[^"]*)"/)
  if (!link) throw new Error('no admin.css?v= link in the login page')
  const css = await get(link[1].replaceAll('&amp;', '&'))
  expectStatus(css, 200, 'GET admin.css')
  const type = css.headers.get('content-type') ?? ''
  if (!type.includes('text/css')) throw new Error(`admin.css content-type was ${type}`)
})

await check('mcp', async () => {
  const res = await get('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pack-test', version: '0' } },
    }),
  })
  expectStatus(res, 401, 'POST /mcp')
  const challenge = res.headers.get('www-authenticate') ?? ''
  if (!challenge.includes('resource_metadata')) throw new Error(`www-authenticate was "${challenge}"`)
  expectStatus(await get('/.well-known/oauth-protected-resource/mcp'), 200, 'protected resource metadata')
})

const HEADLINE_OLD = 'Websites that stay simple'
const HEADLINE_NEW = 'Websites that stay simple, pushed'
const SECOND = 'second.tgz'
const SECOND_MARK = 'pack-test second release'

function releaseRows(host) {
  const r = cli(['releases', host, '--token', pushKey, '--json'])
  expectCli(r, 'inlaycms releases')
  return JSON.parse(r.stdout)
}

let firstId = ''
await check('cli pack a second release', () => {
  firstId = releaseRows(BASE).find((r) => r.state === 'current')?.id ?? ''
  if (!firstId) throw new Error('no current release to roll back to')
  // A visible content change (edition bumped so it is applied) and a template change (which a rollback reverts).
  const content = readFileSync('content.ts', 'utf8')
  const site = readFileSync('site.tsx', 'utf8')
  const headline = `headline: '${HEADLINE_OLD}'`
  const h1 = '<h1>{p.headline}</h1>'
  if (!content.includes(headline) || !site.includes(h1)) throw new Error('the example changed: update the smoke test')
  try {
    writeFileSync('content.ts', content.replace(headline, `headline: '${HEADLINE_NEW}'`).replace('edition: 1', 'edition: 2'))
    writeFileSync('site.tsx', site.replace(h1, `${h1}<p class="pt-mark">${SECOND_MARK}</p>`))
    const args = ['pack', '--config', 'inlay.config.ts', '--key', 'keys/dev.key', '--out', SECOND, '--name', 'second', '--no-typecheck']
    expectCli(cli(args), 'inlaycms pack (second)')
  } finally {
    writeFileSync('content.ts', content)
    writeFileSync('site.tsx', site)
  }
})

await check('cli push --activate', async () => {
  const r = cli(['push', BASE, '--file', SECOND, '--activate', '--token', pushKey])
  expectCli(r, 'inlaycms push')
  if (!/home/.test(r.out)) throw new Error(`the printed diff doesn't mention the home page:\n${r.out}`)
  await afterSwap((body) => body.includes(SECOND_MARK))
  const body = await (await get('/')).text()
  if (!body.includes(HEADLINE_NEW)) throw new Error('/ does not show the new headline')
  if (!body.includes(SECOND_MARK)) throw new Error('/ does not show the second release template')
  expectStatus(await get('/public/site.css'), 200, 'GET /public/site.css after the push')
  const contact = await get('/contact', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'email=ana%40example.com&message=Hello&locale=en',
  })
  expectStatus(contact, 200, 'POST /contact after the push')
  if (!(await contact.text()).includes('Thank you')) throw new Error('no thank-you page after the push')
  const states = releaseRows(BASE).map((x) => x.state).sort()
  if (states.join() !== 'current,previous') throw new Error(`unexpected release states: ${states}`)
})

await check('cli push --dry-run changes nothing', () => {
  const r = cli(['push', BASE, '--file', SECOND, '--dry-run', '--token', pushKey])
  expectCli(r, 'inlaycms push --dry-run')
  if (!/Nothing changes/.test(r.out)) throw new Error(`expected "Nothing changes":\n${r.out}`)
  const rows = releaseRows(BASE)
  if (rows.length !== 2) throw new Error(`a dry run left ${rows.length} releases`)
})

await check('cli activate rolls back', async () => {
  expectCli(cli(['activate', BASE, firstId, '--token', pushKey]), 'inlaycms activate <host> <id>')
  await afterSwap((body) => !body.includes(SECOND_MARK))
  const body = await (await get('/')).text()
  if (body.includes(SECOND_MARK)) throw new Error('/ still shows the second release template')
  // Content edited under a newer release survives a rollback (the stored edition is higher), so the headline stays.
  if (!body.includes(HEADLINE_NEW)) throw new Error('the headline should survive the rollback')
  const current = releaseRows(BASE).find((x) => x.state === 'current')
  if (current?.id !== firstId) throw new Error(`the live release is ${current?.id}, not ${firstId}`)
  expectStatus(await get('/public/site.css'), 200, 'GET /public/site.css after the rollback')
})

rmSync(SECOND, { force: true })

// The host forms: the data folder and the live release's site, no config file or database path.
await check('cli export and dry run', () => {
  expectCli(cli(['export', '--data', DATA, '--out', EXPORT]), 'inlaycms export')
  expectCli(cli(['import', EXPORT, '--data', DATA, '--dry-run']), 'inlaycms import --dry-run')
  expectCli(cli(['import', EXPORT, '--dry-run']), 'inlaycms import --dry-run with the config file')
})

let backupPath = ''
await check('cli backup', () => {
  const r = cli(['backup', '--data', DATA])
  expectCli(r, 'inlaycms backup')
  const m = r.stdout.match(/Backup written to (.+)/)
  if (!m) throw new Error(`no backup path in the output:\n${r.out}`)
  backupPath = m[1].trim()
})

await check('stop', stopServer)

await check('cli restore-backup and import', () => {
  expectCli(cli(['restore-backup', backupPath, '--data', DATA]), 'inlaycms restore-backup')
  expectCli(cli(['import', EXPORT, '--data', DATA]), 'inlaycms import')
  expectCli(cli(['backup', '--db', DB]), 'inlaycms backup with --db')
})

await check('boot again', startServer)
await check('home page after restore', async () => expectStatus(await get('/'), 200, 'GET /'))
await check('stop again', stopServer)

rmSync(DATA, { recursive: true, force: true })
