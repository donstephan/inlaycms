import Fastify from 'fastify'
import { Writable } from 'node:stream'
import { redactUrl, requestLogger } from '../../src/host/logging.js'

describe('redactUrl', () => {
  it('replaces the values of credential parameters and keeps the rest', () => {
    expect(redactUrl('/_inlay/preview?token=abc.def&path=%2Fabout')).toBe('/_inlay/preview?token=[redacted]&path=%2Fabout')
    expect(redactUrl('/admin/upload?token=abc')).toBe('/admin/upload?token=[redacted]')
    expect(redactUrl('/api/auth/oauth2/authorize?client_id=x&sig=s3&code=c0')).toBe(
      '/api/auth/oauth2/authorize?client_id=x&sig=[redacted]&code=[redacted]',
    )
    expect(redactUrl('/blog?page=2&tokens=many')).toBe('/blog?page=2&tokens=many')
    expect(redactUrl('/token=abc')).toBe('/token=abc')
  })
})

describe('requestLogger', () => {
  it('keeps a link\'s token out of the request log', async () => {
    const lines: string[] = []
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString())
        done()
      },
    })
    const app = Fastify({ logger: { ...requestLogger, stream } })
    app.get('/_inlay/preview', async () => 'ok')
    await app.inject({ method: 'GET', url: '/_inlay/preview?token=secret-value&path=/' })
    await app.close()
    const log = lines.join('')
    expect(log).toContain('/_inlay/preview?token=[redacted]&path=/')
    expect(log).not.toContain('secret-value')
  })
})
