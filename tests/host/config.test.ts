import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InlayError, generateKeyPair, readHostConfig } from '../../src/index.js'
import { ensureDataDir } from '../../src/host/config.js'

const SECRET = 'x'.repeat(32)
const base = { INLAY_DATA_DIR: '/data', INLAY_BASE_URL: 'https://example.com', INLAY_SECRET: SECRET }

function messageId(env: NodeJS.ProcessEnv, opts?: { needKeys?: boolean }): string | undefined {
  try {
    readHostConfig(env, opts)
  } catch (error) {
    return error instanceof InlayError ? error.messageId : 'other'
  }
  return undefined
}

describe('readHostConfig', () => {
  it('names each missing required variable', () => {
    expect(messageId({ ...base, INLAY_DATA_DIR: undefined })).toBe('config.host.dataDir')
    expect(messageId({ ...base, INLAY_BASE_URL: undefined })).toBe('config.host.baseUrl')
    expect(messageId({ ...base, INLAY_SECRET: undefined })).toBe('config.host.secret')
  })

  it('rejects a bad base URL and a short secret', () => {
    for (const bad of ['example.com', 'ftp://example.com', 'https://example.com/blog']) {
      expect(messageId({ ...base, INLAY_BASE_URL: bad })).toBe('config.host.baseUrl')
    }
    expect(messageId({ ...base, INLAY_SECRET: 'short' })).toBe('config.host.secret')
  })

  it('applies defaults', () => {
    const config = readHostConfig(base)
    expect(config).toMatchObject({
      dataDir: '/data',
      baseUrl: 'https://example.com',
      port: 3000,
      host: '0.0.0.0',
      rateLimit: true,
      backupKeep: 14,
      publicMaxAge: 3600,
      cdn: { maxAge: 15, staleIfError: 86400 },
      trustProxy: false,
      trustedKeys: [],
    })
    expect(config.uploads).toBeUndefined()
    expect(config.paths.media).toBe(join('/data', 'media'))
  })

  it('parses numbers and on/off flags', () => {
    const config = readHostConfig({
      ...base,
      INLAY_PORT: '8080',
      INLAY_HOST: '127.0.0.1',
      INLAY_RATE_LIMIT: 'off',
      INLAY_UPLOAD_MAX_BYTES: '1000',
      INLAY_BACKUP_KEEP: '3',
      INLAY_PUBLIC_MAX_AGE: '60',
      INLAY_CDN_MAX_AGE: '5',
      INLAY_CDN_STALE_IF_ERROR: '10',
    })
    expect(config).toMatchObject({
      port: 8080,
      host: '127.0.0.1',
      rateLimit: false,
      uploads: { maxBytes: 1000 },
      backupKeep: 3,
      publicMaxAge: 60,
      cdn: { maxAge: 5, staleIfError: 10 },
    })
    expect(messageId({ ...base, INLAY_PORT: 'abc' })).toBe('config.host.number')
    expect(messageId({ ...base, INLAY_PORT: '0' })).toBe('config.host.port')
    expect(messageId({ ...base, INLAY_RATE_LIMIT: 'maybe' })).toBe('config.host.flag')
  })

  it('trusts only the reverse proxies INLAY_TRUST_PROXY names', () => {
    const trustProxy = (value: string) => readHostConfig({ ...base, INLAY_TRUST_PROXY: value }).trustProxy
    expect(trustProxy('off')).toBe(false)
    expect(trustProxy(' ')).toBe(false)
    expect(trustProxy('127.0.0.1')).toEqual(['127.0.0.1'])
    expect(trustProxy(' 10.0.0.0/8, ::1 ,fd00::/8,uniquelocal')).toEqual(['10.0.0.0/8', '::1', 'fd00::/8', 'uniquelocal'])
    // "Everyone" would let any visitor fake their address and get around the login limits.
    for (const value of ['on', 'true', '1', '*', 'proxy.example.com', '10.0.0.0/33', '::1/129', '10.0.0.0/8/1', '10.0.0.0/', ',']) {
      expect(messageId({ ...base, INLAY_TRUST_PROXY: value }), value).toBe('config.host.trustProxy')
    }
  })

  it('merges inline and file keys and checks needKeys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inlay-keys-'))
    try {
      const a = generateKeyPair().publicKey
      const b = generateKeyPair().publicKey
      const file = join(dir, 'keys.txt')
      writeFileSync(file, `# trusted\n${b}\n${a}\n`)
      const config = readHostConfig({ ...base, INLAY_TRUSTED_KEYS: a, INLAY_TRUSTED_KEYS_FILE: file }, { needKeys: true })
      expect([...config.trustedKeys].sort()).toEqual([a, b].sort())
      expect(messageId({ ...base, INLAY_TRUSTED_KEYS_FILE: join(dir, 'nope') })).toBe('config.host.trustedKeysFile')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(messageId(base, { needKeys: true })).toBe('config.host.trustedKeys')
    expect(messageId(base)).toBeUndefined()
  })

  it('returns the secrets that are set, including empty ones', () => {
    const config = readHostConfig({ ...base, A: '' })
    expect(config.secrets(['A', 'B'])).toEqual({ A: '' })
  })
})

describe('ensureDataDir', () => {
  it('creates the data directory and its subdirectories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inlay-data-'))
    try {
      const config = readHostConfig({ ...base, INLAY_DATA_DIR: join(root, 'data') })
      await ensureDataDir(config)
      await ensureDataDir(config)
      for (const dir of ['media', 'backups', 'releases']) {
        expect(statSync(join(root, 'data', dir)).isDirectory()).toBe(true)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
