import { createHmac } from 'node:crypto'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { Window } from 'happy-dom'
import { OWNER_PASSWORD } from './app.js'

const ORIGIN = 'https://example.com'

type Response = LightMyRequestResponse

/** A signed-in browser: keeps the session cookie and sends the site's `Origin` with every request. */
export interface AdminClient {
  cookie: string
  get(url: string, headers?: Record<string, string>): Promise<Response>
  post(url: string, form: URLSearchParams | Record<string, string | string[]>, headers?: Record<string, string>): Promise<Response>
  upload(
    url: string,
    files: Array<{ name?: string; filename: string; data: Uint8Array; type: string }>,
    fields?: Record<string, string>,
  ): Promise<Response>
}

/** Keeps the cookies responses set, as a browser would. */
class Jar {
  readonly cookies = new Map<string, string>()

  store(res: Response): void {
    const header = res.headers['set-cookie']
    const lines = header === undefined ? [] : Array.isArray(header) ? header : [header]
    for (const line of lines) {
      const [pair = '', ...attrs] = line.split(';')
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '') this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

function toParams(form: URLSearchParams | Record<string, string | string[]>): URLSearchParams {
  if (form instanceof URLSearchParams) return form
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(form)) {
    for (const v of Array.isArray(value) ? value : [value]) params.append(key, v)
  }
  return params
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** The bytes of a base32 key (RFC 4648, padding and case ignored). */
function base32Bytes(key: string): Buffer {
  const bytes: number[] = []
  let bits = 0
  let value = 0
  for (const char of key.toUpperCase().replace(/=+$/, '')) {
    const index = BASE32.indexOf(char)
    if (index === -1) throw new Error(`Not a base32 key: ${key}`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >>> bits) & 0xff)
    }
  }
  return Buffer.from(bytes)
}

/** The six-digit code an authenticator app shows for the base32 `key` at `at` (ms): RFC 6238, HMAC-SHA1, 30 s steps. */
export function totpCode(key: string, at = Date.now()): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)))
  const mac = createHmac('sha1', base32Bytes(key)).update(counter).digest()
  const offset = mac[mac.length - 1]! & 0x0f
  const number = mac.readUInt32BE(offset) & 0x7fffffff
  return String(number % 1_000_000).padStart(6, '0')
}

/**
 * Logs in through `POST /admin/login` and returns a client carrying the session. When the login asks for a code
 * (two-step login is on), `key` answers it on `/admin/login/code`.
 */
export async function signIn(app: FastifyInstance, email: string, password = OWNER_PASSWORD, key?: string): Promise<AdminClient> {
  const jar = new Jar()
  const login = await app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
    payload: new URLSearchParams({ email, password }).toString(),
  })
  if (login.statusCode !== 302) throw new Error(`Login as ${email} failed with ${login.statusCode}`)
  jar.store(login)
  if (String(login.headers.location ?? '').startsWith('/admin/login/code')) {
    if (key === undefined) throw new Error(`Login as ${email} asks for a code`)
    const code = await app.inject({
      method: 'POST',
      url: '/admin/login/code',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, cookie: jar.header() },
      payload: new URLSearchParams({ code: totpCode(key) }).toString(),
    })
    if (code.statusCode !== 302) throw new Error(`The code for ${email} failed with ${code.statusCode}`)
    jar.store(code)
  }

  const send = async (opts: { method: 'GET' | 'POST'; url: string; headers?: Record<string, string>; payload?: string | Buffer }) => {
    const cookie = jar.header()
    const res = await app.inject({
      method: opts.method,
      url: opts.url,
      headers: { origin: ORIGIN, ...(cookie !== '' && { cookie }), ...opts.headers },
      ...(opts.payload !== undefined && { payload: opts.payload }),
    })
    jar.store(res)
    return res
  }

  return {
    get cookie() {
      return jar.header()
    },
    get: (url, headers = {}) => send({ method: 'GET', url, headers }),
    post: (url, form, headers = {}) =>
      send({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        payload: toParams(form).toString(),
      }),
    async upload(url, files, fields = {}) {
      const form = new FormData()
      for (const [key, value] of Object.entries(fields)) form.append(key, value)
      for (const file of files) {
        form.append(file.name ?? 'file', new Blob([new Uint8Array(file.data)], { type: file.type }), file.filename)
      }
      const request = new Request(`${ORIGIN}/`, { method: 'POST', body: form })
      const payload = Buffer.from(await request.arrayBuffer())
      return send({ method: 'POST', url, headers: { 'content-type': request.headers.get('content-type')! }, payload })
    },
  }
}

/**
 * Turns two-step login on through the account page's two forms (the password, then the current code) and returns
 * the key the page showed.
 */
export async function setUpTwoStep(client: AdminClient, password = OWNER_PASSWORD): Promise<string> {
  const setup = await client.post('/admin/account/two-step/setup', { password })
  if (setup.statusCode !== 200) throw new Error(`Setting up two-step login failed with ${setup.statusCode}`)
  const doc = parseHtml(setup.body)
  const key = doc.querySelector('#two-step-key')?.textContent.replace(/\s/g, '') ?? ''
  const uri = doc.querySelector<HTMLInputElement>('form[action="/admin/account/two-step/confirm"] input[name="uri"]')?.value ?? ''
  if (key === '' || uri === '') throw new Error('Setting up two-step login showed no key')
  const confirm = await client.post('/admin/account/two-step/confirm', { code: totpCode(key), uri })
  if (confirm.statusCode !== 303) throw new Error(`Turning on two-step login failed with ${confirm.statusCode}`)
  return key
}

let window: Window | undefined

/** `html` parsed into a DOM, for queries. */
export function parseHtml(html: string): Document {
  window ??= new Window()
  return new window.DOMParser().parseFromString(html, 'text/html') as unknown as Document
}

const SKIPPED_INPUTS = new Set(['submit', 'button', 'reset', 'image', 'file'])

const VALID_FLOAT = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/
const LOCAL_DATETIME = /^(\d{4,})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/

/** Whether year, month and day name a real day (the year above 0), as HTML's date parsing requires. */
function realDay(y: number, m: number, d: number): boolean {
  if (y < 1 || m < 1 || m > 12 || d < 1) return false
  const days = new Date(Date.UTC(2000, m, 0)).getUTCDate()
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
  return d <= (m === 2 ? (leap ? 29 : 28) : days)
}

/** A `type=date` value as the browser keeps it: a valid date string, or `''`. */
function sanitizeDate(value: string): string {
  const m = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(value)
  return m && realDay(Number(m[1]), Number(m[2]), Number(m[3])) ? value : ''
}

/** A `type=datetime-local` value as the browser keeps it: normalized (`T`, no zero seconds), or `''`. */
function sanitizeDatetime(value: string): string {
  const m = LOCAL_DATETIME.exec(value)
  if (!m) return ''
  const [, y = '', mo = '', d = '', h = '', mi = '', s, frac] = m
  if (!realDay(Number(y), Number(mo), Number(d)) || Number(h) > 23 || Number(mi) > 59 || Number(s ?? 0) > 59) return ''
  const fraction = (frac ?? '').replace(/0+$/, '')
  const seconds = fraction !== '' ? `:${s}.${fraction}` : s !== undefined && s !== '00' ? `:${s}` : ''
  return `${y}-${mo}-${d}T${h}:${mi}${seconds}`
}

/** An input's value after the browser's value sanitization for its type. */
function sanitized(type: string, value: string): string {
  switch (type) {
    case 'text':
    case 'search':
    case 'tel':
    case 'password':
      return value.replace(/[\r\n]/g, '')
    case 'url':
    case 'email':
      return value.replace(/[\r\n]/g, '').trim()
    case 'number':
      return VALID_FLOAT.test(value) ? value : ''
    case 'date':
      return sanitizeDate(value)
    case 'datetime-local':
      return sanitizeDatetime(value)
    default:
      return value
  }
}

/** Every lone CR or LF as CRLF, as browsers send names and values in a urlencoded form. */
const crlf = (s: string): string => s.replace(/\r\n|\r|\n/g, '\r\n')

/**
 * The fields a browser would submit from the page's form (`opts.form` is a CSS selector, default the first form):
 * enabled, named controls in document order; checkboxes and radios only when checked; every selected option; no
 * file inputs and no buttons, except `submitter`, which is appended. Input values are sanitized for their type
 * (newlines dropped from text, invalid numbers, dates and datetimes blanked, datetimes normalized), and newlines
 * are sent as CRLF, as browsers do.
 */
export function submittedForm(
  html: string,
  opts: { form?: string; submitter?: { name: string; value: string } } = {},
): URLSearchParams {
  const doc = parseHtml(html)
  const form = doc.querySelector(opts.form ?? 'form')
  if (!form) throw new Error(`No form matches ${opts.form ?? 'form'}`)
  const params = new URLSearchParams()
  const append = (name: string, value: string) => params.append(crlf(name), crlf(value))
  for (const el of form.querySelectorAll('input, select, textarea')) {
    const name = el.getAttribute('name')
    if (name === null || name === '' || el.hasAttribute('disabled') || el.closest('fieldset[disabled]')) continue
    if (el.tagName === 'SELECT') {
      const options = [...el.querySelectorAll('option')].filter((o) => !o.hasAttribute('disabled'))
      const selected = options.filter((o) => o.hasAttribute('selected'))
      const chosen = selected.length > 0 || el.hasAttribute('multiple') ? selected : options.slice(0, 1)
      for (const option of chosen) append(name, option.getAttribute('value') ?? option.textContent ?? '')
      continue
    }
    if (el.tagName === 'TEXTAREA') {
      append(name, (el as HTMLTextAreaElement).value)
      continue
    }
    const type = (el.getAttribute('type') ?? 'text').toLowerCase()
    if (SKIPPED_INPUTS.has(type)) continue
    if (type === 'checkbox' || type === 'radio') {
      if (el.hasAttribute('checked')) append(name, el.getAttribute('value') ?? 'on')
      continue
    }
    append(name, sanitized(type, el.getAttribute('value') ?? ''))
  }
  if (opts.submitter) append(opts.submitter.name, opts.submitter.value)
  return params
}
