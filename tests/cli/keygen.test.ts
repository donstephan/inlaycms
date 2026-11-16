import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../../src/adapters/cli/main.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inlay-keygen-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

async function run(...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli(argv, { cwd: dir, out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('inlaycms keygen', () => {
  it('writes a key pair and prints the public key', async () => {
    const r = await run('keygen', '--out', dir, '--name', 'agency')
    expect(r.code).toBe(0)
    expect(r.out).toContain('ed25519:')
    expect(r.out).toContain('INLAY_TRUSTED_KEYS')
    expect((await stat(join(dir, 'agency.key'))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(dir, 'agency.key'), 'utf8')).toContain('PRIVATE KEY')
    expect((await readFile(join(dir, 'agency.pub'), 'utf8')).trim()).toMatch(/^ed25519:/)
  })

  it('defaults to the current directory and the name inlay', async () => {
    expect((await run('keygen')).code).toBe(0)
    expect((await stat(join(dir, 'inlay.key'))).isFile()).toBe(true)
  })

  it('refuses to overwrite', async () => {
    await run('keygen')
    const before = await readFile(join(dir, 'inlay.key'), 'utf8')
    const r = await run('keygen')
    expect(r.code).toBe(2)
    expect(r.err).toContain('inlay.key')
    expect(await readFile(join(dir, 'inlay.key'), 'utf8')).toBe(before)
  })

  it('refuses to overwrite a public key', async () => {
    await writeFile(join(dir, 'inlay.pub'), 'ed25519:kept\n')
    const r = await run('keygen')
    expect(r.code).toBe(2)
    expect(r.err).toContain('inlay.pub')
    expect(existsSync(join(dir, 'inlay.key'))).toBe(false)
    expect(await readFile(join(dir, 'inlay.pub'), 'utf8')).toBe('ed25519:kept\n')
  })
})
