import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { FastifyInstance } from 'fastify'
import { makeApp } from '../helpers/app.js'
import { MODERN } from '../helpers/mcp.js'

const open: Array<{ close(): Promise<unknown> }> = []

afterEach(async () => {
  for (const item of open.splice(0).reverse()) await item.close()
})

async function app() {
  const made = await makeApp({ withOwner: true })
  open.push(made.app)
  return made
}

/** A client whose requests go through the Fastify app, with an API key. */
async function connect(a: FastifyInstance, key: string, era: 'modern' | 'legacy'): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('https://example.com/mcp'), {
    fetch: async (url, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      const res = await a.inject({
        method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'DELETE',
        url: new URL(url).pathname,
        headers: { ...headers, 'x-api-key': key },
        ...(typeof init?.body === 'string' && { payload: init.body }),
      })
      const out = new Headers()
      for (const [name, value] of Object.entries(res.headers)) {
        if (value !== undefined) out.set(name, Array.isArray(value) ? value.join(', ') : String(value))
      }
      const empty = res.statusCode === 202 || res.statusCode === 204 || res.rawPayload.length === 0
      return new Response(empty ? null : new Uint8Array(res.rawPayload), { status: res.statusCode, headers: out })
    },
  })
  const client = new Client(
    { name: 'inlay-http-test', version: '1.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: MODERN } } } : {},
  )
  await client.connect(transport)
  open.push(client)
  return client
}

describe('/mcp over HTTP', () => {
  for (const era of ['modern', 'legacy'] as const) {
    it(`serves ${era} clients`, async () => {
      const { app: a, editorKey } = await app()
      const client = await connect(a, editorKey, era)
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name)).toContain('describe_site')
      const result = await client.callTool({ name: 'describe_site', arguments: {} })
      expect(result.isError).not.toBe(true)
      const block = result.content[0]
      const json = JSON.parse(block?.type === 'text' ? block.text : '')
      expect(json.singletons.find((s: { type: string }) => s.type === 'home').urls.en).toBe('https://example.com/')
    })
  }

  it('refuses a push token: it is for the push API only', async () => {
    const { app: a, pushKey, ownerKey } = await app()
    const post = (key: string) =>
      a.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'x-api-key': key, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      })
    expect((await post(pushKey)).statusCode).toBe(401)
    expect((await post(ownerKey)).statusCode).not.toBe(401)
  })

  it('answers a legacy GET with 405', async () => {
    const { app: a, editorKey } = await app()
    const res = await a.inject({ method: 'GET', url: '/mcp', headers: { 'x-api-key': editorKey, accept: 'text/event-stream' } })
    expect(res.statusCode).toBe(405)
  })
})
