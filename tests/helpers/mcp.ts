import { Client, StreamableHTTPClientTransport, type ElicitRequest, type ElicitResult } from '@modelcontextprotocol/client'
import type { AuthInfo } from '../../src/adapters/mcp/route.js'
import { createNonceStore } from '../../src/adapters/mcp/request-state.js'
import { createInlayMcpHandler, type FetchFile, type McpDeps } from '../../src/adapters/mcp/server.js'
import type { Core } from '../../src/core/core.js'
import type { Actor } from '../../src/core/types.js'

export const MCP_BASE_URL = 'https://example.com'
export const MCP_SECRET = 's'.repeat(32)
export const MODERN = '2026-07-28'

export type ElicitHandler = (request: ElicitRequest) => ElicitResult | Promise<ElicitResult>

export interface McpClientOptions {
  core: Core
  actor: Actor
  /** `modern` (the default) pins the 2026-07-28 revision; `legacy` uses the 2025 handshake. */
  era?: 'modern' | 'legacy'
  /** How the client answers elicitation; `none` (the default) doesn't declare the capability. */
  elicitation?: 'accept' | 'decline' | 'cancel' | 'none' | ElicitHandler
  /** Defaults to one that throws. */
  fetchFile?: FetchFile
  now?: () => Date
  uploads?: { maxBytes: number }
  /** The release the site runs, as `describe_site` reports it. */
  release?: { id: string; name: string } | null
}

/** A tool result: `json` is the parsed JSON text block (or of the JSON after the error text), `undefined` if none. */
export interface ToolCall {
  isError: boolean
  text: string
  json: any
}

export interface McpTestClient {
  call(name: string, args?: object): Promise<ToolCall>
  client: Client
  deps: McpDeps
  /** The unexpected failures the tools reported through `deps.log`. */
  errors: unknown[]
  /** Every HTTP request the client sent, in order. */
  sent: { url: string; init: RequestInit | undefined }[]
  /** Sends a raw HTTP request to the handler, authenticated as `actor` (as the client's own requests are). */
  fetch(url: string, init?: RequestInit): Promise<Response>
  close(): Promise<void>
}

const noFetch: FetchFile = async () => {
  throw new Error('fetchFile was not given to mcpClient')
}

function answer(mode: 'accept' | 'decline' | 'cancel'): ElicitResult {
  return mode === 'accept' ? { action: 'accept', content: { confirm: true } } : { action: mode }
}

/** The JSON of a tool result's text: the whole text, or the last line that is JSON (errors put it last). */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const last = text.slice(text.lastIndexOf('\n') + 1)
    try {
      return JSON.parse(last)
    } catch {
      return undefined
    }
  }
}

/** An MCP client talking to `createInlayMcpHandler` in-process, authenticated as `actor`. */
export async function mcpClient(opts: McpClientOptions): Promise<McpTestClient> {
  const errors: unknown[] = []
  const deps: McpDeps = {
    core: opts.core,
    baseUrl: MCP_BASE_URL,
    secret: MCP_SECRET,
    now: opts.now ?? (() => new Date()),
    fetchFile: opts.fetchFile ?? noFetch,
    uploads: opts.uploads ?? { maxBytes: 10 * 1024 * 1024 },
    log: (err) => errors.push(err),
    confirmations: createNonceStore(),
    ...(opts.release !== undefined && { release: opts.release }),
  }
  const handler = createInlayMcpHandler(deps)
  const authInfo: AuthInfo = { token: 'test-token', clientId: 'test-client', scopes: [], extra: { actor: opts.actor } }
  const sent: McpTestClient['sent'] = []
  const fetch = (url: string, init?: RequestInit) => handler.fetch(new Request(url, init), { authInfo })
  const transport = new StreamableHTTPClientTransport(new URL(`${MCP_BASE_URL}/mcp`), {
    fetch: (url, init) => {
      sent.push({ url: String(url), init })
      return fetch(String(url), init)
    },
  })
  const elicitation = opts.elicitation ?? 'none'
  const client = new Client(
    { name: 'inlay-test', version: '1.0.0' },
    {
      ...(elicitation !== 'none' && { capabilities: { elicitation: { form: {} } } }),
      ...((opts.era ?? 'modern') === 'modern' && { versionNegotiation: { mode: { pin: MODERN } } }),
    },
  )
  if (elicitation !== 'none') {
    client.setRequestHandler('elicitation/create', async (request) =>
      typeof elicitation === 'function' ? elicitation(request) : answer(elicitation),
    )
  }
  await client.connect(transport)

  return {
    client,
    deps,
    errors,
    sent,
    fetch,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args as Record<string, unknown> })
      const block = result.content[0]
      const text = block?.type === 'text' ? block.text : ''
      return { isError: result.isError === true, text, json: parseJson(text) }
    },
    async close() {
      await client.close()
      await handler.close()
    },
  }
}
