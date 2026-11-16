import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { posix } from 'node:path'
import { InlayError } from '../../core/errors.js'
import { t, type MessageId } from '../../core/messages/index.js'

const MAX_REDIRECTS = 3
const DEFAULT_TIMEOUT_MS = 15_000
const REDIRECTS = new Set([301, 302, 303, 307, 308])

const blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], // unspecified, "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of [
  ['2001::', 32], // Teredo, which tunnels to an IPv4 address
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6')
}

/** The eight 16-bit groups of a valid IPv6 address (no zone). */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase()
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number) as [number, number, number, number]
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head = '', tail] = text.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = tail === undefined || tail === '' ? [] : tail.split(':')
  const fill = tail === undefined ? [] : new Array<string>(8 - left.length - right.length).fill('0')
  return [...left, ...fill, ...right].map((group) => parseInt(group, 16))
}

const ipv4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`

/** The IPv4 address an IPv6 address stands for or tunnels to (mapped, compatible, NAT64, 6to4), if any. */
function embeddedIpv4(groups: number[]): string | null {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups
  const zeroTo80 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0
  if (zeroTo80 && (g5 === 0xffff || g5 === 0)) return ipv4Of(g6, g7)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return ipv4Of(g6, g7)
  if (g0 === 0x2002) return ipv4Of(g1, g2)
  return null
}

/**
 * Whether `address` (an IP address, not a host name) is one the server may fetch from: anything but loopback,
 * private, link-local, CGNAT, unspecified, multicast or reserved addresses, including IPv6 forms that carry one.
 */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/%.*$/, '')
  const kind = isIP(bare)
  if (kind === 4) return !blocked.check(bare, 'ipv4')
  if (kind !== 6) return false
  const groups = ipv6Groups(bare)
  const v4 = embeddedIpv4(groups)
  if (v4 !== null) return isPublicAddress(v4)
  // Only global unicast (2000::/3) is public.
  if (((groups[0] ?? 0) & 0xe000) !== 0x2000) return false
  return !blocked.check(bare, 'ipv6')
}

const fail = (id: MessageId, url: string) => new InlayError('invalid_operation', id, { url })

/** A `lookup` that resolves every address of the host and fails unless all of them pass `isAllowed`. */
function checkedLookup(isAllowed: (address: string) => boolean, url: string): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { all: true, family: 0 }, (err, found: LookupAddress[]) => {
      if (err) return callback(err, '', 0)
      if (found.length === 0 || !found.every((a) => isAllowed(a.address))) {
        return callback(fail('error.fetchBlocked', url), '', 0)
      }
      const family = options.family === 4 || options.family === 6 ? options.family : 0
      const usable = family === 0 ? found : found.filter((a) => a.family === family)
      if (usable.length === 0) return callback(fail('error.fetchFailed', url), '', 0)
      if (options.all) return callback(null, usable)
      const [first] = usable as [LookupAddress]
      callback(null, first.address, first.family)
    })
  }
}

/** `raw` as an http(s) URL whose literal IP host (if it has one) passes `isAllowed`. */
function checkUrl(raw: string, isAllowed: (address: string) => boolean, url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw fail('error.fetchScheme', url)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw fail('error.fetchScheme', url)
  // Node connects to a literal address without calling `lookup`, so it is checked here.
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1')
  if (isIP(host) !== 0 && !isAllowed(host)) throw fail('error.fetchBlocked', url)
  return parsed
}

function get(target: URL, lookup: LookupFunction, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const client = target.protocol === 'https:' ? https : http
    const req = client.request(
      target,
      {
        method: 'GET',
        agent: false,
        lookup,
        signal,
        headers: { accept: '*/*', 'accept-encoding': 'identity', 'user-agent': 'Inlay' },
      },
      resolve,
    )
    req.on('error', reject)
    req.end()
  })
}

async function readBody(res: IncomingMessage, maxBytes: number, url: string, signal: AbortSignal): Promise<Uint8Array> {
  const declared = Number(res.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.destroy()
    throw fail('error.fetchTooLarge', url)
  }
  const stop = () => res.destroy(new Error('aborted'))
  signal.addEventListener('abort', stop, { once: true })
  try {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of res as AsyncIterable<Buffer>) {
      total += chunk.length
      if (total > maxBytes) {
        res.destroy()
        throw fail('error.fetchTooLarge', url)
      }
      chunks.push(chunk)
    }
    return new Uint8Array(Buffer.concat(chunks))
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

/** The name in a `Content-Disposition` header (`filename*` first), without any directories. */
function dispositionName(header: string | undefined): string | null {
  if (header === undefined) return null
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header)
  let name: string | null = null
  if (extended?.[2] !== undefined) {
    try {
      name = decodeURIComponent(extended[2].trim())
    } catch {
      name = null
    }
  }
  if (name === null) {
    const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/i.exec(header)
    name = plain?.[1]?.replace(/\\(.)/g, '$1') ?? plain?.[2] ?? null
  }
  if (name === null) return null
  const base = posix.basename(name.replace(/\\/g, '/')).trim()
  return base === '' || base === '.' || base === '..' ? null : base
}

function pathName(target: URL): string | null {
  const segment = target.pathname.split('/').pop() ?? ''
  let name: string
  try {
    name = decodeURIComponent(segment)
  } catch {
    name = segment
  }
  name = name.replace(/[/\\]/g, '').trim()
  return name === '' ? null : name
}

/**
 * Downloads `url` for the media library, only from addresses `isAllowed` accepts (public ones by default).
 * Every address of each host is checked before connecting, and the connection goes only to a checked
 * address. Follows at most 3 redirects, each checked the same way. Gives up after `timeoutMs` and once
 * the body passes `maxBytes`. Every failure is an `InlayError` with a plain-language message.
 */
export async function fetchRemoteFile(
  url: string,
  opts: { maxBytes: number; timeoutMs?: number; isAllowed?: (address: string) => boolean },
): Promise<{ data: Uint8Array; filename: string }> {
  const isAllowed = opts.isAllowed ?? isPublicAddress
  const lookup = checkedLookup(isAllowed, url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    let target = checkUrl(url, isAllowed, url)
    for (let redirects = 0; ; redirects++) {
      const res = await get(target, lookup, controller.signal)
      const status = res.statusCode ?? 0
      if (REDIRECTS.has(status)) {
        res.resume()
        const location = res.headers.location
        if (location === undefined || redirects >= MAX_REDIRECTS) throw fail('error.fetchFailed', url)
        let next: string
        try {
          next = new URL(location, target).href
        } catch {
          throw fail('error.fetchFailed', url)
        }
        target = checkUrl(next, isAllowed, url)
        continue
      }
      if (status < 200 || status >= 300) {
        res.resume()
        throw fail('error.fetchFailed', url)
      }
      const data = await readBody(res, opts.maxBytes, url, controller.signal)
      const filename = dispositionName(res.headers['content-disposition']) ?? pathName(target) ?? t('media.downloadName')
      return { data, filename }
    }
  } catch (e) {
    if (e instanceof InlayError) throw e
    if (controller.signal.aborted) throw fail('error.fetchTimeout', url)
    throw fail('error.fetchFailed', url)
  } finally {
    clearTimeout(timer)
  }
}
